import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../cloud.css'
import { completeCloudCallback } from '../auth'

/**
 * Возврат с кодом на origin Cloud. Здесь код меняется на HttpOnly-сессию, а из
 * адресной строки немедленно вычищаются code и state — им незачем оставаться
 * в истории браузера и утекать через Referer на следующей навигации.
 */
export default function CloudCallbackPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const search = window.location.search
    // Чистим URL до сетевого обмена: даже при ошибке код в адресной строке не нужен.
    window.history.replaceState(null, '', window.location.pathname)

    completeCloudCallback(search)
      .then(({ returnTo }) => {
        if (!cancelled) navigate(returnTo, { replace: true })
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось завершить вход')
      })

    return () => {
      cancelled = true
    }
  }, [navigate])

  return (
    <div className="cl-root">
      <div className="cl-page narrow">
        <div className="cl-empty">
          <div style={{ fontSize: 40 }}>☁</div>
          <h3>{error ? 'Вход не завершён' : 'Входим…'}</h3>
          <p className="cl-muted">{error ?? 'Обмениваем код на сессию'}</p>
          {error ? (
            <div style={{ marginTop: 18 }}>
              <a className="cl-btn primary" href="/cloud">
                Попробовать снова
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
