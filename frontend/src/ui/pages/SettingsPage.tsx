import { useMutation, useQuery } from '@tanstack/react-query'
import { type FormEvent } from 'react'
import { api } from '../../utils/api'

export default function SettingsPage() {
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const response = await api.get('/status/me')
      return response.data.user
    },
  })

  const mutation = useMutation({
    mutationFn: async (payload: { displayName?: string; bio?: string; status?: string }) => {
      const response = await api.patch('/status/me', payload)
      return response.data.user
    },
    onSuccess: () => {
      meQuery.refetch()
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      displayName: String(form.get('displayName') ?? ''),
      bio: String(form.get('bio') ?? ''),
      status: String(form.get('status') ?? ''),
    })
  }

  const user = meQuery.data

  return (
    <div className="settings-page">
      <h2>Профиль</h2>
      <form onSubmit={handleSubmit}>
        <label>
          Имя
          <input name="displayName" defaultValue={user?.displayName ?? ''} />
        </label>
        <label>
          Статус
          <select name="status" defaultValue={user?.status ?? 'ONLINE'}>
            <option value="ONLINE">Онлайн</option>
            <option value="AWAY">Отошел</option>
            <option value="DND">Не беспокоить</option>
            <option value="OFFLINE">Оффлайн</option>
          </select>
        </label>
        <label>
          О себе
          <textarea name="bio" defaultValue={user?.bio ?? ''} />
        </label>
        <button type="submit" disabled={mutation.isPending}>
          Сохранить
        </button>
      </form>
    </div>
  )
}





