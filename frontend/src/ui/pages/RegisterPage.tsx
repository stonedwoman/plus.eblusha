import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../utils/api'

export default function RegisterPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async (data: {
      username: string
      displayName: string
      password: string
    }) => {
      const response = await api.post('/auth/register', data)
      return response.data
    },
    onSuccess: () => {
      navigate('/auth', { replace: true })
    },
    onError: (e: any) => {
      const msg = e.response?.data?.message
      if (msg === 'User already exists') setError('Пользователь с таким логином уже существует')
      else if (msg === 'Invalid data') setError('Проверьте логин, имя в чате и пароль')
      else setError(msg ?? 'Ошибка регистрации')
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      username: String(form.get('username') ?? ''),
      displayName: String(form.get('displayName') ?? ''),
      password: String(form.get('password') ?? ''),
    })
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h2>Регистрация</h2>
      <label>
        Логин
        <input name="username" type="text" required minLength={3} placeholder="Введите логин" autoComplete="username" />
      </label>
      <label>
        Имя в чате
        <input name="displayName" type="text" required minLength={2} placeholder="Как вас будут видеть" />
      </label>
      <label>
        Пароль
        <input name="password" type="password" required minLength={8} />
      </label>
      {error ? <div className="auth-error">{error}</div> : null}
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Создаем…' : 'Создать аккаунт'}
      </button>
    </form>
  )
}





