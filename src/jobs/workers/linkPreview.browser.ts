/// <reference lib="dom" />
// ^ типы браузера нужны только для кода, который выполняется ВНУТРИ страницы (page.evaluate).
// Сам модуль работает в Node; DOM-объекты здесь не используются.

import logger from "../../config/logger";
import type { LinkPreview } from "../../lib/linkPreview";
import { assertSafeUrl } from "../../security/ssrf";

/**
 * Второй эшелон превью ссылок: настоящий браузер.
 *
 * Зачем: часть сайтов (Cloudflare "Just a moment", SPA без метатегов в HTML) не отдаёт
 * ничего обычному запросу — ни с ботовым User-Agent, ни с TLS-отпечатком Chrome. Проверено:
 * list.am и stackoverflow отдают превью только настоящему браузеру.
 *
 * Дорого (1–3 c, ~150 МБ памяти), поэтому вызывается ТОЛЬКО когда быстрый путь вернул пусто
 * или защитную заглушку. Ограничения: один браузер на процесс, лимит одновременных страниц,
 * таймаут, блокировка тяжёлых ресурсов (нам нужны только метатеги).
 */

type Browser = any;
type Page = any;

const NAV_TIMEOUT_MS = 10_000;
/**
 * Сколько ждём, пока страница станет пригодной для превью. Ждать приходится дважды по разным
 * причинам: Cloudflare-заглушка сама себя перезагружает, а сайты вроде booking.com отдают
 * пустую страницу-проверку с ПУСТЫМ заголовком и подставляют настоящие метатеги только после
 * своего скрипта. Раньше мы смотрели только на заголовок — пустой заголовок «не заглушка», и мы
 * забирали пустышку через полсекунды.
 */
const READY_WAIT_MS = 6_000;
const MAX_CONCURRENT_PAGES = 2;
const BROWSER_IDLE_SHUTDOWN_MS = 5 * 60_000;
/** Домены, которые нас жёстко блокируют (403/429 + капча), не трогаем какое-то время. */
const BLOCKED_HOST_TTL_MS = 15 * 60_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let browserPromise: Promise<Browser | null> | null = null;
let activePages = 0;
let idleTimer: NodeJS.Timeout | null = null;

function browserEnabled(): boolean {
  const v = String(process.env.LINK_PREVIEW_BROWSER ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function executablePath(): string | undefined {
  const p = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  return p && p.trim() ? p.trim() : undefined;
}

async function getBrowser(): Promise<Browser | null> {
  if (!browserEnabled()) return null;
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    try {
      // require, а не import: если модуль/бинарь отсутствуют — просто отключаем второй эшелон.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const puppeteer = require("puppeteer-core");
      const browser = await puppeteer.launch({
        executablePath: executablePath(),
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--mute-audio",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=Translate,BackForwardCache",
          "--lang=ru-RU,ru",
        ],
      });
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      logger.info("link preview: браузерный рендерер запущен");
      return browser;
    } catch (err) {
      logger.warn({ err }, "link preview: браузер недоступен, работаем без второго эшелона");
      browserPromise = null;
      return null;
    }
  })();

  return browserPromise;
}

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activePages > 0) return;
    const p = browserPromise;
    browserPromise = null;
    void (async () => {
      try {
        const b = await p;
        if (b) await b.close();
        logger.info("link preview: браузер закрыт по простою");
      } catch {
        // ignore
      }
    })();
  }, BROWSER_IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

const CHALLENGE_TITLES = [
  "just a moment",
  "один момент",
  "attention required",
  "checking your browser",
  "доступ ограничен",
  "antibot",
  "captcha",
  "enable javascript",
  "включите javascript",
];

function looksLikeChallenge(title: string | null, html: string | null): boolean {
  const t = (title ?? "").toLowerCase();
  if (CHALLENGE_TITLES.some((c) => t.includes(c))) return true;
  const h = (html ?? "").toLowerCase();
  return h.includes("challenge-platform") || h.includes("cf-mitigated");
}

/**
 * Домены, которые нас блокируют наглухо (403/429 с капчей), помним ненадолго: иначе каждая
 * ссылка на такой сайт впустую держит страницу все READY_WAIT_MS и тормозит очередь превью.
 */
const blockedHosts = new Map<string, number>();

function hostOf(urlString: string): string | null {
  try {
    return new URL(urlString).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isHostBlocked(urlString: string): boolean {
  const host = hostOf(urlString);
  if (!host) return false;
  const until = blockedHosts.get(host);
  if (!until) return false;
  if (until > Date.now()) return true;
  blockedHosts.delete(host);
  return false;
}

function rememberBlockedHost(urlString: string) {
  const host = hostOf(urlString);
  if (!host) return;
  blockedHosts.set(host, Date.now() + BLOCKED_HOST_TTL_MS);
  if (blockedHosts.size > 200) {
    const oldest = [...blockedHosts.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) blockedHosts.delete(oldest[0]);
  }
}

/** Достаёт превью настоящим браузером. Возвращает null, если не вышло. */
export async function fetchLinkPreviewViaBrowser(urlString: string): Promise<LinkPreview | null> {
  if (!browserEnabled()) return null;

  // Та же защита, что и у обычного пути: не ходим во внутреннюю сеть.
  try {
    await assertSafeUrl(new URL(urlString));
  } catch {
    return null;
  }

  if (activePages >= MAX_CONCURRENT_PAGES) return null;
  if (isHostBlocked(urlString)) return null;

  const browser = await getBrowser();
  if (!browser) return null;

  activePages++;
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ "accept-language": "ru-RU,ru;q=0.9,en;q=0.8" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // Грузим только разметку: картинки/шрифты/стили не нужны для метатегов и сильно тормозят.
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      try {
        if (BLOCKED_RESOURCES.has(req.resourceType())) req.abort();
        else req.continue();
      } catch {
        // ignore
      }
    });

    const response = await page.goto(urlString, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    const status: number | null = typeof response?.status === "function" ? response.status() : null;

    // Ждём не «ушла ли заглушка», а появления того, ради чего пришли: метатегов или
    // осмысленной страницы. Пустая страница-проверка (booking.com) и Cloudflare-заглушка
    // одинаково означают «ещё рано».
    const deadline = Date.now() + READY_WAIT_MS;
    for (;;) {
      const probe = await page
        .evaluate(() => {
          const m = (sel: string): string | null => {
            const el = document.querySelector(sel) as HTMLMetaElement | null;
            const v = el?.content?.trim();
            return v || null;
          };
          return {
            hasMeta: !!(
              m('meta[property="og:title"]') ||
              m('meta[name="twitter:title"]') ||
              m('meta[property="og:description"]') ||
              m('meta[name="twitter:description"]') ||
              m('meta[name="description"]') ||
              m('meta[property="og:image"]') ||
              m('meta[name="twitter:image"]')
            ),
            title: (document.title || "").trim(),
            bodyLen: document.body ? document.body.innerHTML.length : 0,
          };
        })
        .catch(() => null);

      const stillWaiting =
        !probe ||
        looksLikeChallenge(probe.title, null) ||
        !(probe.hasMeta || (probe.title && probe.bodyLen > 4000));
      if (!stillWaiting || Date.now() >= deadline) {
        // Сайт продержал нас всё окно и так и не пустил — значит блокирует. Запоминаем.
        if (stillWaiting && (status === 403 || status === 429)) rememberBlockedHost(urlString);
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const data = await page.evaluate(() => {
      const meta = (sel: string): string | null => {
        const el = document.querySelector(sel) as HTMLMetaElement | null;
        const v = el?.content?.trim();
        return v || null;
      };
      const abs = (u: string | null): string | null => {
        if (!u) return null;
        try {
          const x = new URL(u, location.href);
          return x.protocol === "http:" || x.protocol === "https:" ? x.toString() : null;
        } catch {
          return null;
        }
      };
      // JSON-LD как запасной источник (многие сайты дают заголовок/картинку только там)
      let ld: any = null;
      try {
        for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]')) as HTMLScriptElement[]) {
          const parsed = JSON.parse(s.textContent || "null");
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          for (const it of arr) {
            if (it && typeof it === "object" && (it.name || it.headline || it.image)) {
              ld = it;
              break;
            }
          }
          if (ld) break;
        }
      } catch {
        // ignore
      }
      const ldImage = (() => {
        const im = ld?.image;
        if (!im) return null;
        if (typeof im === "string") return im;
        if (Array.isArray(im)) return typeof im[0] === "string" ? im[0] : im[0]?.url ?? null;
        return im.url ?? null;
      })();

      return {
        title:
          meta('meta[property="og:title"]') ||
          meta('meta[name="twitter:title"]') ||
          (ld?.headline || ld?.name || null) ||
          (document.title || null),
        description:
          meta('meta[property="og:description"]') ||
          meta('meta[name="twitter:description"]') ||
          meta('meta[name="description"]') ||
          (typeof ld?.description === "string" ? ld.description : null),
        image: abs(
          meta('meta[property="og:image:secure_url"]') ||
            meta('meta[property="og:image"]') ||
            meta('meta[name="twitter:image"]') ||
            meta('meta[name="twitter:image:src"]') ||
            ldImage
        ),
        imageWidth: Number(meta('meta[property="og:image:width"]')) || null,
        imageHeight: Number(meta('meta[property="og:image:height"]')) || null,
        siteName: meta('meta[property="og:site_name"]') || null,
        finalUrl: location.href,
        htmlHead: document.documentElement.innerHTML.slice(0, 2000),
      };
    });

    if (looksLikeChallenge(data.title, data.htmlHead)) return null;

    const clean = (v: string | null, max: number): string | null => {
      if (!v) return null;
      const s = v.replace(/\s+/g, " ").trim();
      return s ? s.slice(0, max) : null;
    };

    const title = clean(data.title, 300);
    const description = clean(data.description, 300);
    const imageUrl = data.image;
    if (!title && !description && !imageUrl) return null;

    const siteName =
      clean(data.siteName, 120) ??
      (() => {
        try {
          return new URL(data.finalUrl || urlString).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      })();

    return {
      url: data.finalUrl || urlString,
      title,
      description,
      imageUrl,
      imageWidth: data.imageWidth,
      imageHeight: data.imageHeight,
      siteName,
      fetchedAtISO: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(
      { err: String((err as any)?.message ?? err).slice(0, 200), url: urlString.slice(0, 120) },
      "link preview: браузерный путь не дал результата"
    );
    return null;
  } finally {
    try {
      if (page) await page.close();
    } catch {
      // ignore
    }
    activePages--;
    scheduleIdleShutdown();
  }
}
