import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import '../cloud.css'
import { ensureCloudSession, type CloudMe } from '../auth'
import { toCloudError } from '../api'
import { connectCloudSocket, disconnectCloudSocket, onCloudEvent } from '../realtime'
import { hydrateServerUploads, startUploadReconciler, takeDuplicateCount, useUploadBusy } from '../uploads/manager'
import { Toasts, toast } from '../components/ui'
import { cloudPath } from '../basePath'

/**
 * Каркас Cloud: устанавливает собственную сессию (через SSO Еблуши), поднимает
 * сокет и подтягивает незавершённые загрузки — именно здесь пользователь узнаёт,
 * что у него «висит» файл, начатый вчера с другого компьютера.
 */
export type CloudContext = { me: CloudMe }

// Кэш между размонтированиями: возврат из мессенджера в Cloud не должен каждый
// раз заново гонять SSO-обмен.
let sharedMe: CloudMe | null = null

export default function CloudLayout() {
  const [me, setMe] = useState<CloudMe | null>(sharedMe)
  const [error, setError] = useState<string | null>(null)
  const [online, setOnline] = useState(true)
  const location = useLocation()

  useEffect(() => {
    let alive = true
    ensureCloudSession()
      .then(async (session) => {
        if (!alive) return
        sharedMe = session
        setMe(session)
        connectCloudSocket()
        const restored = await hydrateServerUploads().catch(() => 0)
        if (restored > 0) {
          toast.info(
            restored === 1 ? 'У вас есть незавершённая загрузка' : `Незавершённых загрузок: ${restored}`
          )
        }
      })
      .catch((err) => {
        if (!alive) return
        const e = toCloudError(err)
        setError(e.status === 401 ? 'Нужно войти в Еблушу' : e.message)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const off = onCloudEvent('__connected', (payload) => {
      const connected = Boolean(payload)
      setOnline((prev) => {
        if (prev && !connected) toast.error('Связь потеряна — загрузки приостановлены')
        if (!prev && connected) toast.success('Связь восстановлена')
        return connected
      })
    })
    return () => {
      off()
    }
  }, [])

  useEffect(() => () => disconnectCloudSocket(), [])

  // Страховка на случай потерянных realtime-событий: см. startUploadReconciler.
  useEffect(() => startUploadReconciler(), [])

  // Булев селектор, а не сводка: useUploadSummary пересчитывался на КАЖДЫЙ тик
  // прогресса и перерисовывал каркас вместе со всей галереей под ним. Это и был
  // главный источник тормозов при заливке пачки в сотни файлов.
  const uploadsBusy = useUploadBusy()
  useEffect(() => {
    if (uploadsBusy) return
    const dupes = takeDuplicateCount()
    if (dupes > 0) toast.info(`Уже были в хуяпке: ${dupes} — повторно не добавляли`)
  }, [uploadsBusy])

  if (error) {
    return (
      <div className="cl-root">
        <div className="cl-page narrow">
          <div className="cl-empty">
            <h3>Eblusha Cloud</h3>
            <p>{error}</p>
            <div style={{ marginTop: 18 }}>
              {/* state.from — тот же механизм, что у ProtectedRoute: после входа
                  LoginPage вернёт ровно сюда, вместе с search и hash. */}
              <Link className="cl-btn primary" to="/auth" state={{ from: location }}>
                Войти через Еблушу
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Контекст мемоизируем: новый объект на каждом рендере каркаса заставлял
  // перерисовываться все страницы под Outlet.
  const outletContext = useMemo<CloudContext | null>(() => (me ? { me } : null), [me])

  if (!me) {
    return (
      <div className="cl-root">
        <div className="cl-page narrow">
          <div className="cl-empty">
            <h3>Открываем Cloud…</h3>
            <p className="cl-muted">Проверяем сессию Еблуши</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cl-root">
      <header className="cl-topbar">
        <Link className="cl-brand" to={cloudPath()}>
          {/* Тот же логотип, что и в чате: .logo + вращающаяся Б (style.css). */}
          <span className="logo">
            <span>Е</span>
            <span className="b">Б</span>
            <span>луша</span>
          </span>
          <span className="cl-brand-suffix">Cloud</span>
        </Link>
        <nav className="cl-topnav">
          <NavLink to={cloudPath()} end className={({ isActive }) => (isActive ? 'is-active' : '')}>
            Хуяпки
          </NavLink>
          <NavLink to={cloudPath('/recent')} className={({ isActive }) => (isActive ? 'is-active' : '')}>
            Недавние
          </NavLink>
          <NavLink to={cloudPath('/favorites')} className={({ isActive }) => (isActive ? 'is-active' : '')}>
            Избранное
          </NavLink>
          <NavLink to={cloudPath('/uploads')} className={({ isActive }) => (isActive ? 'is-active' : '')}>
            Загрузки
          </NavLink>
          <NavLink to={cloudPath('/trash')} className={({ isActive }) => (isActive ? 'is-active' : '')}>
            Корзина
          </NavLink>
          {me.isAdmin ? (
            <NavLink to={cloudPath('/admin/storage')} className={({ isActive }) => (isActive ? 'is-active' : '')}>
              Хранилище
            </NavLink>
          ) : null}
        </nav>
        <div className="cl-spacer" />
        {!online ? <span className="cl-muted" style={{ fontSize: 12.5 }}>нет связи</span> : null}
        <a className="cl-btn ghost sm" href="/" title="Вернуться в мессенджер">
          ← Еблуша
        </a>
      </header>

      <Outlet context={outletContext} />
      <Toasts />
    </div>
  )
}
