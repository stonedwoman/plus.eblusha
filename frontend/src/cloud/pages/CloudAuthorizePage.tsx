import { useEffect, useState } from 'react'
import { api } from '../../core/api'
import '../cloud.css'

/**
 * Страница выдачи кода — живёт на origin МЕССЕНДЖЕРА (eblusha.org/cloud-auth).
 *
 * Сюда браузер приходит с поддомена Cloud, когда там нет сессии. Здесь есть
 * токен Еблуши, поэтому можно попросить одноразовый код и вернуть человека
 * обратно. Роут стоит под ProtectedRoute: незалогиненного сначала отправят на
 * /auth, а после входа вернут ровно сюда вместе со всеми параметрами.
 *
 * Никаких секретов страница не видит: code_verifier остался на стороне Cloud,
 * наружу пришёл только code_challenge.
 */
export default function CloudAuthorizePage() {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const clientId = params.get('client_id') ?? 'eblusha-cloud-web'
    const redirectUri = params.get('redirect_uri') ?? '/cloud'
    const state = params.get('state') ?? ''
    const codeChallenge = params.get('code_challenge') ?? ''
    const method = params.get('code_challenge_method') ?? 'S256'

    if (!codeChallenge || !state) {
      setError('Запрос неполный: не хватает параметров входа.')
      return
    }

    let cancelled = false
    api
      .post<{ code: string }>('/cloud/auth/authorize', {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: method,
      })
      .then(({ data }) => {
        if (cancelled) return
        // redirect_uri уже проверен сервером по allowlist — здесь он безопасен.
        const target = new URL(redirectUri, window.location.origin)
        target.searchParams.set('code', data.code)
        target.searchParams.set('state', state)
        window.location.replace(target.toString())
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = (err as { response?: { status?: number } })?.response?.status
        setError(
          status === 422
            ? 'Cloud запросил возврат на неразрешённый адрес. Проверьте CLOUD_ALLOWED_REDIRECT_ORIGINS.'
            : 'Не удалось выдать код доступа. Попробуйте ещё раз.'
        )
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="cl-root">
      <div className="cl-page narrow">
        <div className="cl-empty">
          <div className="logo" style={{ fontSize: 30, justifyContent: 'center' }}>
            <span>Е</span>
            <span className="b">Б</span>
            <span>луша</span>
          </div>
          <h3>{error ? 'Не получилось' : 'Открываем Eblusha Cloud…'}</h3>
          <p className="cl-muted">{error ?? 'Передаём доступ на защищённый поддомен'}</p>
          {error ? (
            <div style={{ marginTop: 18 }}>
              <a className="cl-btn" href="/">
                Вернуться в Еблушу
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
