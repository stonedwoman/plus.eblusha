/**
 * Указатель поиска по настройкам веба (SPEC §3.9, REF §10).
 *
 * id строк — те же, что у натива и в SPEC §1.3 (по ним сверяются платформы); на вебе есть не все.
 * Совпадение: без регистра, «ё» = «е»; запрос режется на слова, слова короче 2 знаков отбрасываются;
 * строка подходит, если КАЖДОЕ слово — подстрока названия, пояснения, синонимов или имени раздела.
 */
import type { SettingsAvTab, SettingsSectionId } from './settingsNav'

export const SECTION_NAMES: Record<SettingsSectionId, string> = {
  profile: 'Профиль',
  conn: 'Соединение',
  av: 'Звук и видео',
  security: 'Безопасность',
  app: 'Приложение',
}

export const AV_TAB_NAMES: Record<SettingsAvTab, string> = { dev: 'Устройства', proc: 'Обработка голоса', video: 'Видео в звонке' }

export type IndexRowDef = {
  id: string
  sec: SettingsSectionId | null
  tab?: SettingsAvTab
  title: string
  cap: string
  kw: string
  /** строка есть только при условии (бот заведён на сервере) */
  needs?: 'bot'
}

export const INDEX_DEFS: readonly IndexRowDef[] = [
  { id: 'p-photo', sec: 'profile', title: 'Фото профиля', cap: 'В круг попадёт центральная часть фото.', kw: 'аватар аватарка картинка снимок фотография' },
  { id: 'p-name', sec: 'profile', title: 'Отображаемое имя', cap: 'Под этим именем вас увидят другие пользователи.', kw: 'ник никнейм' },
  { id: 'p-eblid', sec: 'profile', title: 'EBLID', cap: 'Ваш номер в Еблуше — по нему вас находят в «Контактах».', kw: 'номер айди id идентификатор' },
  { id: 'p-ltime', sec: 'profile', title: 'Показывать моё местное время', cap: 'Собеседники в личных чатах видят в шапке беседы, который у вас час, и город по часовому поясу.', kw: 'время часы часовой пояс город таймзона timezone местное' },
  { id: 'p-bot', sec: 'profile', title: 'Чат с Еблушей', cap: 'Личный чат с ботом: там можно писать без обращения. В остальных беседах зовите «Еблуша, …».', kw: 'бот еблуша eblusha bot ассистент помощник нейросеть ии ai вопрос спросить valheim вальхейм', needs: 'bot' },
  { id: 'c-server', sec: 'conn', title: 'Сервер', cap: 'Через какой адрес открыт сайт: напрямую или через СПб.', kw: 'адрес напрямую спб санкт-петербург блокировка vpn прокси eblusha.org сайт' },
  { id: 'c-relay', sec: 'conn', title: 'Всегда соединяться через ретранслятор', cap: 'Обычно путь к серверу выбирается сам: сначала короткий, а ретранслятор — если короткий не сложился. Включите, если в звонках рвётся связь или голос звучит «роботом».', kw: 'relay turn связь звонки обрывы робот' },
  { id: 'a-mic', sec: 'av', tab: 'dev', title: 'Микрофон', cap: 'Через него вас слышат в звонках. Выбирается во время звонка.', kw: 'гарнитура mic запись' },
  { id: 'a-spk', sec: 'av', tab: 'dev', title: 'Динамики и наушники', cap: 'Через них вы слышите собеседников. Выбираются во время звонка.', kw: 'колонки звук вывод громкость' },
  { id: 'a-cam', sec: 'av', tab: 'dev', title: 'Камера', cap: 'Её видят собеседники, когда вы включаете видео. Выбирается во время звонка.', kw: 'вебка вебкамера webcam' },
  { id: 'a-permmic', sec: 'av', tab: 'dev', title: 'Доступ к микрофону', cap: 'Без него вас не слышно в звонках и не записать голосовое.', kw: 'разрешение доступ микрофон mic браузер' },
  { id: 'a-permcam', sec: 'av', tab: 'dev', title: 'Доступ к камере', cap: 'Без него собеседники не увидят ваше видео.', kw: 'разрешение доступ камера вебка браузер' },
  { id: 'a-echo', sec: 'av', tab: 'proc', title: 'Эхоподавление', cap: 'Убирает голос собеседника, вернувшийся в микрофон из динамиков. На колонках без него вас слышно с эхом.', kw: 'эхо aec' },
  { id: 'a-ns', sec: 'av', tab: 'proc', title: 'Шумоподавление', cap: 'Убирает ровный фон — вентилятор, гул, кондиционер. Клавиатуру и стуки почти не трогает.', kw: 'шумодав фон шум ns' },
  { id: 'a-agc', sec: 'av', tab: 'proc', title: 'Автоусиление', cap: 'Подтягивает тихий голос до обычной громкости. В паузах вместе с ним слышнее и фон.', kw: 'громкость agc тихо' },
  { id: 'a-shres', sec: 'av', tab: 'video', title: 'Показ экрана · разрешение', cap: 'С каким размером кадра начинается показ экрана.', kw: 'демонстрация экран стрим разрешение 1080p 1440p 4k качество' },
  { id: 'a-shfps', sec: 'av', tab: 'video', title: 'Показ экрана · кадры в секунду', cap: 'Плавность показа: больше кадров — больше трафика.', kw: 'демонстрация экран стрим fps кадры плавность' },
  { id: 'a-shaud', sec: 'av', tab: 'video', title: 'Показ экрана · звук', cap: 'Собеседники слышат звук показанной вкладки или экрана.', kw: 'демонстрация экран стрим звук захват звука' },
  { id: 's-pass', sec: 'security', title: 'Пароль', cap: 'Этот пароль используется для входа в аккаунт.', kw: 'сменить изменить пароль' },
  { id: 's-link', sec: 'security', title: 'Подтвердить по коду', cap: 'Новое устройство показывает код — подтвердите его здесь, и оно получит ключи секретных чатов.', kw: 'привязать связать qr код новое устройство секретные ключи' },
  { id: 's-sess', sec: 'security', title: 'Активные сеансы', cap: 'Телефоны, браузеры и приложения, где открыт ваш аккаунт.', kw: 'устройства телефон браузер отключить разлогинить ключи' },
  { id: 'ap-yt', sec: 'app', title: 'Встроенный проигрыватель YouTube', cap: 'Ролик играет прямо в карточке ссылки. Выключите — ролики будут открываться в новой вкладке.', kw: 'ютуб youtube видео ролик плеер браузер' },
  { id: 'x-exit', sec: null, title: 'Выйти из Еблуши', cap: 'Выход из аккаунта в этом браузере.', kw: 'выход выйти разлогиниться аккаунт' },
]

/** id строк веба — для сверки с таблицей SPEC §1.3 (тест). */
export const WEB_INDEX_IDS: readonly string[] = INDEX_DEFS.map((d) => d.id)

export type IndexRow = IndexRowDef & { val: string }

export function buildIndex(opts: { hasBot: boolean; values?: Record<string, string> }): IndexRow[] {
  const values = opts.values ?? {}
  return INDEX_DEFS.filter((d) => (d.needs === 'bot' ? opts.hasBot : true)).map((d) => ({ ...d, val: values[d.id] ?? '' }))
}

export const normalize = (s: string): string => String(s ?? '').toLowerCase().replace(/ё/g, 'е')

/** Слова запроса: короче 2 знаков отбрасываются. До 80 знаков, как поле поиска. */
export function queryWords(q: string): string[] {
  return normalize(String(q ?? '').slice(0, 80))
    .split(/\s+/)
    .filter((w) => w.length >= 2)
}

export function searchRows(index: readonly IndexRow[], q: string): IndexRow[] | null {
  const ws = queryWords(q)
  if (!ws.length) return null
  return index.filter((r) => {
    const hay = normalize([r.title, r.cap, r.kw, r.sec ? SECTION_NAMES[r.sec] : ''].join(' '))
    return ws.every((w) => hay.includes(w))
  })
}

export type Seg = { t: string; hit: boolean }

/** Режет текст на куски, подсвечивая слова запроса (регистр и «ё» не важны). Длина текста не меняется. */
export function splitHighlight(text: string, q: string): Seg[] {
  const ws = queryWords(q)
  if (!ws.length || !text) return [{ t: text, hit: false }]
  const n = normalize(text)
  const marks = new Array<boolean>(text.length).fill(false)
  for (const w of ws) {
    let i = 0
    while ((i = n.indexOf(w, i)) >= 0) {
      for (let k = i; k < i + w.length; k++) marks[k] = true
      i += w.length
    }
  }
  const out: Seg[] = []
  let cur = ''
  let curHit = marks[0]
  for (let k = 0; k < text.length; k++) {
    if (marks[k] !== curHit) {
      out.push({ t: cur, hit: curHit })
      cur = ''
      curHit = marks[k]
    }
    cur += text[k]
  }
  out.push({ t: cur, hit: curHit })
  return out
}

/**
 * Подстрока выдачи: найдено в пояснении — выдержка с начала слова за два слова до совпадения;
 * в названии — вкладка («Устройства») или начало пояснения; только по синониму — «по слову «…»».
 */
export function excerptFor(row: IndexRow, q: string): Seg[] {
  const ws = queryWords(q)
  if (!ws.length) return []
  const cap = row.cap
  const n = normalize(cap)
  for (const w of ws) {
    const i = n.indexOf(w)
    if (i >= 0) {
      // с начала слова за два слова до совпадения
      let s = i
      for (let skipped = 0; skipped < 2 && s > 0; skipped++) {
        const prev = cap.lastIndexOf(' ', s - 2)
        s = prev < 0 ? 0 : prev + 1
      }
      const tail = cap.slice(s, s + 64)
      const cut = s + 64 < cap.length
      const segs = splitHighlight(tail, q)
      if (s > 0) segs.unshift({ t: '…', hit: false })
      if (cut) segs.push({ t: '…', hit: false })
      return segs
    }
  }
  if (ws.some((w) => normalize(row.title).includes(w))) {
    return [{ t: row.tab ? AV_TAB_NAMES[row.tab] : cap.slice(0, 60), hit: false }]
  }
  const k = ws.find((w) => normalize(row.kw).includes(w))
  if (k) {
    const word = row.kw.split(' ').find((x) => normalize(x).includes(k)) ?? k
    return [{ t: `по слову «${word}»`, hit: false }]
  }
  return []
}

export function countBySection(rows: readonly IndexRow[] | null): Record<SettingsSectionId, number> {
  const out: Record<SettingsSectionId, number> = { profile: 0, conn: 0, av: 0, security: 0, app: 0 }
  for (const r of rows ?? []) if (r.sec) out[r.sec] += 1
  return out
}
