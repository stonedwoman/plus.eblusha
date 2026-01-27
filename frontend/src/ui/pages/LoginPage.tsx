import { type FormEvent, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { useAppStore } from '../../domain/store/appStore'
import { unlockAppAudio } from '../../utils/audioUnlock'

export default function LoginPage() {
  const setSession = useAppStore((state) => state.setSession)
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async (data: { username: string; password: string }) => {
      const response = await api.post('/auth/login', data)
      return response.data
    },
    onSuccess: (data) => {
      setSession({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? undefined,
      })
      // Force new document so iOS Safari drops autofill/passkey context
      const redirectTo = (location.state as { from?: Location })?.from?.pathname ?? '/'
      // Small microtask delay ensures state flush in React
      setTimeout(() => { window.location.replace(redirectTo) }, 0)
    },
    onError: () => {
      setError('Неверные данные')
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Unlock audio right on the login gesture (so we don't need a separate overlay).
    void unlockAppAudio()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      username: String(form.get('username') ?? ''),
      password: String(form.get('password') ?? ''),
    })
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h2>Вход</h2>
      <label>
        Логин
        <input name="username" type="text" required autoComplete="username" />
      </label>
      <label>
        Пароль
        <input name="password" type="password" required autoComplete="current-password" />
      </label>
      {error ? <div className="auth-error">{error}</div> : null}
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Входим…' : 'Войти'}
      </button>
    </form>
  )
}





