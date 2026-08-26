import { useCallback, useEffect, useState } from 'react'
import { cloudApi, toCloudError } from '../api'
import type { CloudUserLite } from '../types'
import { FaceCrop, type FaceRef } from './PeopleView'
import { Avatar, toast } from './ui'

/**
 * Секция «Люди» в панели «Сведения» просмотрщика.
 *
 * Показывает лица текущего кадра; для первого неопознанного задаёт вопрос
 * «Вы знаете этого человека?» с кандидатами — принятыми друзьями Еблуши и
 * соседями по хуяпкам (себя — первым: «это я» — самый частый случай).
 * Привязка тут же дотягивается матчером на остальные снимки.
 */
type PanelFace = FaceRef & {
  person: { id: string; name: string; user: CloudUserLite | null } | null
}
type Candidate = CloudUserLite & { linked: boolean }

let candidatesCache: Candidate[] | null = null

export function FacesPanel({ fileId, canEdit }: { fileId: string; canEdit: boolean }) {
  const [faces, setFaces] = useState<PanelFace[] | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>(candidatesCache ?? [])
  const [asking, setAsking] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [skipped, setSkipped] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ faces: PanelFace[] }>('/faces/by-file', { params: { fileId } })
      setFaces(data.faces)
    } catch {
      setFaces([])
    }
  }, [fileId])
  useEffect(() => {
    setFaces(null)
    setAsking(null)
    setSkipped(new Set())
    void load()
  }, [load])

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
      setAsking(null)
      setNameInput('')
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  if (!faces || faces.length === 0) return null
  const unknown = faces.filter((f) => !f.person && !skipped.has(f.id))
  const current = unknown[0] ?? null

  return (
    <section className="cl-mi-sect">
      <h4>Люди</h4>
      <div className="cl-vfaces">
        {faces.map((f) => (
          <span
            key={f.id}
            className={`cl-vface${!f.person ? ' is-unknown' : ''}${current?.id === f.id ? ' is-asking' : ''}`}
            title={f.person ? f.person.name : 'Неопознанный'}
          >
            <FaceCrop face={f} size={46} />
            {f.person ? <i>{f.person.name}</i> : <i>?</i>}
          </span>
        ))}
      </div>

      {canEdit && current ? (
        <div className="cl-vface-ask">
          <div className="cl-vface-q">
            <FaceCrop face={current} size={40} />
            <span>Вы знаете этого человека?</span>
          </div>
          {asking === current.id ? (
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
                onKeyDown={(e) => e.key === 'Escape' && setAsking(null)}
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
              <button className="cl-face-member is-plain" onClick={() => setAsking(current.id)}>
                Другое имя…
              </button>
              <button
                className="cl-face-member is-plain"
                onClick={() => setSkipped((prev) => new Set(prev).add(current.id))}
              >
                Не знаю
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}
