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
  /*
   * Заголовок сайта: index.html общий с мессенджером и несёт «Еблуша — Plus»,
   * а облако — отдельный продукт со своим именем. Ставим здесь, а не в
   * index.html: менять общий title значило бы переименовать и мессенджер.
   */
  useEffect(() => {
    document.title = 'Еблуша — Cloud'
  }, [])

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

  /*
   * Протухшая сессия: сбрасываем кэш и заново проходим ensureCloudSession —
   * тот сам решит, хватит ли тихого обмена или нужен редирект на SSO.
   */
  useEffect(() => {
    const onDead = () => {
      sharedMe = null
      setMe(null)
      ensureCloudSession()
        .then((session) => {
          sharedMe = session
          setMe(session)
        })
        .catch((err) => setError(toCloudError(err).status === 401 ? 'Нужно войти в Еблушу' : toCloudError(err).message))
    }
    window.addEventListener('cloud:unauthorized', onDead)
    return () => window.removeEventListener('cloud:unauthorized', onDead)
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
        {/* На мобильном подписи разделов сменяются иконками (см. .cl-topnav в
            @media): пять слов не влезали в одну строку и раздували шапку до
            двух рядов — фотографиям оставалось меньше половины экрана. */}
        <nav className="cl-topnav">
          <NavLink to={cloudPath()} end className={({ isActive }) => (isActive ? 'is-active' : '')} title="Хуяпки">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
              <path d="M3.5 8.5V6.8c0-.9.7-1.6 1.6-1.6h3.6l2 2.1h8.2c.9 0 1.6.7 1.6 1.6v8.6c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V8.5Z" />
            </svg>
            <span>Хуяпки</span>
          </NavLink>
          <NavLink to={cloudPath('/recent')} className={({ isActive }) => (isActive ? 'is-active' : '')} title="Недавние">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8.2" />
              <path d="M12 7.6V12l3 2.1" />
            </svg>
            <span>Недавние</span>
          </NavLink>
          <NavLink to={cloudPath('/uploads')} className={({ isActive }) => (isActive ? 'is-active' : '')} title="Загрузки">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15V4.5m0 0 4 4m-4-4-4 4" />
              <path d="M4.5 19.5h15" />
            </svg>
            <span>Загрузки</span>
          </NavLink>
          <NavLink to={cloudPath('/trash')} className={({ isActive }) => (isActive ? 'is-active' : '')} title="Корзина">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 6.5h15M9.5 6.5V5c0-.8.7-1.5 1.5-1.5h2c.8 0 1.5.7 1.5 1.5v1.5m3.5 0-.8 12a1.6 1.6 0 0 1-1.6 1.5H8.4a1.6 1.6 0 0 1-1.6-1.5l-.8-12" />
              <path d="M10 10.5v6m4-6v6" />
            </svg>
            <span>Корзина</span>
          </NavLink>
          {me.isAdmin ? (
            <NavLink to={cloudPath('/admin/storage')} className={({ isActive }) => (isActive ? 'is-active' : '')} title="Хранилище">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
                <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
                <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
              </svg>
              <span>Хранилище</span>
            </NavLink>
          ) : null}
        </nav>
        <div className="cl-spacer" />
        {!online ? <span className="cl-muted" style={{ fontSize: 12.5 }}>нет связи</span> : null}
      </header>

      <Outlet context={outletContext} />
      <Toasts />
    </div>
  )
}
