/**
 * Где смонтирован Cloud в текущем браузере.
 *
 * Один и тот же бандл обслуживает два расклада:
 *
 *   eblusha.cloud/            — домен целиком отдан Cloud, префикса нет
 *   eblusha.org/cloud/        — Cloud живёт рядом с мессенджером, под префиксом
 *
 * Определять по pathname нельзя: на eblusha.org корень принадлежит чату, и
 * cloud-маршруты обязаны сидеть под /cloud независимо от того, куда зашли.
 * Поэтому решает хост.
 *
 * Список хостов при желании переопределяется мета-тегом (nginx может его
 * подставить для нового домена без пересборки фронта):
 *   <meta name="eb-cloud-base" content="">
 */
const CLOUD_ONLY_HOSTS = new Set(['eblusha.cloud', 'www.eblusha.cloud', 'cloud.eblusha.org'])

function detectBase(): string {
  try {
    const meta = document.querySelector('meta[name="eb-cloud-base"]')?.getAttribute('content')
    if (typeof meta === 'string') return meta.replace(/\/+$/, '')
  } catch {
    // до появления DOM сюда не попадём, но пусть не падает
  }
  try {
    return CLOUD_ONLY_HOSTS.has(window.location.hostname) ? '' : '/cloud'
  } catch {
    return '/cloud'
  }
}

/** '' на выделенном домене, '/cloud' рядом с мессенджером. */
export const CLOUD_BASE = detectBase()

/** true, если домен отдан Cloud целиком (маршруты чата не монтируются). */
export const CLOUD_ROOT_MODE = CLOUD_BASE === ''

/**
 * Путь внутри Cloud с учётом префикса.
 *   cloudPath()            → '/'        либо '/cloud'
 *   cloudPath('/trash')    → '/trash'   либо '/cloud/trash'
 */
export function cloudPath(sub = ''): string {
  const tail = sub && !sub.startsWith('/') ? `/${sub}` : sub
  return `${CLOUD_BASE}${tail}` || '/'
}

/** Абсолютный URL — для redirect_uri и прочего, что уходит на другой origin. */
export function cloudUrl(sub = ''): string {
  return `${window.location.origin}${cloudPath(sub)}`
}

/** Принадлежит ли путь Cloud (для валидации returnTo после входа). */
export function isCloudPath(path: string): boolean {
  if (!path.startsWith('/')) return false
  return CLOUD_ROOT_MODE ? true : path === '/cloud' || path.startsWith('/cloud/')
}
