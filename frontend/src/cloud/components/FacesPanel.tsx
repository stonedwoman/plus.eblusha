import { useEffect, useState } from 'react'
import { cloudApi, toCloudError } from '../api'
import type { CloudUserLite } from '../types'
import { FaceCrop, type FaceRef } from './PeopleView'
import { Avatar, toast } from './ui'

/**
 * Люди на кадре: отдельная вкладка ящика просмотрщика.
 *
 * Кружки лиц с именами; для неопознанных — вопрос «Вы знаете этого человека?»
 * с кандидатами (друзья Еблуши + соседи по хуяпкам, себя — первым). Если все
 * лица известны — никакого вопроса: панель молчит, бейдж на корешке гаснет.
 * Клик по кружку неопознанного переводит вопрос на него.
 */
export type PanelFace = FaceRef & {
  person: { id: string; name: string; user: CloudUserLite | null } | null
}
type Candidate = CloudUserLite & { linked: boolean }

let candidatesCache: Candidate[] | null = null

export function FacesPanel({
  faces,
  canEdit,
  onChanged,
}: {
  faces: PanelFace[] | null
  canEdit: boolean
  onChanged: () => void
}) {
  const [candidates, setCandidates] = useState<Candidate[]>(candidatesCache ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [nameInput, setNameInput] = useState('')

  useEffect(() => {
    if (candidatesCache || !canEdit) return
    void cloudApi
      .get<{ candidates: Candidate[] }>('/faces/candidates')
      .then(({ data }) => {
        candidatesCache = data.candidates
        setCandidates(data.candidates)
      })
      .catch(() => undefined)
  }, [canEdit])

  const bind = async (faceId: string, opts: { userId?: string; name?: string }) => {
    try {
      await cloudApi.post('/faces/name', { ...opts, faceIds: [faceId] })
      setTyping(false)
      setNameInput('')
      setSelectedId(null)
      onChanged()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  if (faces === null) return <div className="cl-muted">Смотрим, кто на кадре…</div>
  if (faces.length === 0) return <div className="cl-muted" style={{ fontSize: 13.5 }}>На этом кадре лиц не нашлось.</div>

  const unknown = faces.filter((f) => !f.person)
  // Вопрос — про выбранное рамкой/кружком лицо, иначе про первое неопознанное.
  const current = (selectedId && unknown.find((f) => f.id === selectedId)) || (canEdit ? unknown[0] : null) || null

  return (
    <div className="cl-vfaces-tab">
      <div className="cl-vfaces">
        {faces.map((f) => (
          <button
            key={f.id}
            className={`cl-vface${!f.person ? ' is-unknown' : ''}${current?.id === f.id ? ' is-asking' : ''}`}
            title={f.person ? f.person.name : 'Неопознанный — нажмите, чтобы назвать'}
            onClick={() => setSelectedId(f.person ? null : f.id)}
          >
            <FaceCrop face={f} size={52} />
            {f.person ? <i>{f.person.name}</i> : <i>?</i>}
          </button>
        ))}
      </div>

      {canEdit && current ? (
        <div className="cl-vface-ask">
          <div className="cl-vface-q">
            <FaceCrop face={current} size={40} />
            <span>Вы знаете этого человека?</span>
          </div>
          {typing ? (
            <form
              className="cl-face-nameform"
              onSubmit={(e) => {
                e.preventDefault()
                if (nameInput.trim()) void bind(current.id, { name: nameInput.trim() })
              }}
            >
              <input
                autoFocus
                className="cl-input"
                placeholder="Имя…"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setTyping(false)}
              />
              <button className="cl-btn primary sm" type="submit" disabled={!nameInput.trim()}>
                Назвать
              </button>
            </form>
          ) : (
            <div className="cl-vface-opts">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  className="cl-face-member"
                  title={c.linked ? 'Уже связан с персоной — лицо добавится к ней' : `Это ${c.displayName || c.username}`}
                  onClick={() => void bind(current.id, { userId: c.id })}
                >
                  <Avatar user={c} />
                  <span>{c.displayName || c.username}</span>
                </button>
              ))}
              <button className="cl-face-member is-plain" onClick={() => setTyping(true)}>
                Другое имя…
              </button>
            </div>
          )}
        </div>
      ) : null}
      {canEdit && !current && unknown.length === 0 ? (
        <div className="cl-muted" style={{ fontSize: 12.5, marginTop: 10 }}>Все лица на кадре опознаны.</div>
      ) : null}
    </div>
  )
}
