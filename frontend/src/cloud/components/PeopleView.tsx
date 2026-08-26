import { useCallback, useEffect, useMemo, useState } from 'react'
import { cloudApi, toCloudError } from '../api'
import type { CloudUserLite } from '../types'
import { Avatar } from './ui'
import { toast } from './ui'

/**
 * Вкладка «Лица». Сверху — лента персон (кружки с именами и счётчиком по
 * этой хуяпке), под ней — либо снимки выбранной персоны, либо «неопознанные»
 * группы лиц, собранные кластеризацией: один человек — одна пачка, назвать
 * можно всю пачку разом. Людей в круге всего несколько, разметка ручная.
 */
type Person = {
  id: string
  name: string
  countInSpace: number
  cover: FaceRef | null
  /** Привязанный аккаунт Еблуши: имя и аватар тогда берутся из него. */
  user: CloudUserLite | null
}
export type FaceRef = {
  id: string
  fileId: string
  box: { x: number; y: number; w: number; h: number }
  score: number
  fileW: number | null
  fileH: number | null
}
type UnnamedGroup = { faces: FaceRef[]; faceIds: string[]; total: number; days: number; significant: boolean }

/**
 * Кадрированное лицо: CSS-кроп превью по рамке. Вся арифметика — в ПИКСЕЛЯХ
 * кадра: доли по X и Y нормированы разными сторонами, и на неквадратных
 * превью долевая математика уводила кроп в небо над лицом.
 */
export function FaceCrop({ face, size = 72 }: { face: FaceRef; size?: number }) {
  const b = face.box
  const W = face.fileW || 1000
  const H = face.fileH || 1000
  const fw = b.w * W
  const fh = b.h * H
  // Квадрат вокруг рамки с полями: лицо в кружке не должно упираться лбом.
  const sidePx = Math.max(fw, fh) * 1.6
  const k = size / sidePx
  const cx = (b.x + b.w / 2) * W
  const cy = (b.y + b.h / 2) * H
  return (
    <span className="cl-face" style={{ width: size, height: size }}>
      <img
        src={`/api/cloud/files/${face.fileId}/preview`}
        alt=""
        loading="lazy"
        draggable={false}
        style={{
          width: Math.round(W * k),
          height: Math.round(H * k),
          left: Math.round(size / 2 - cx * k),
          top: Math.round(size / 2 - cy * k),
        }}
      />
    </span>
  )
}

export function PeopleView({
  spaceId,
  canEdit,
  members,
  onOpenPerson,
}: {
  spaceId: string
  canEdit: boolean
  /** Участники хуяпки — кандидаты на привязку «это аккаунт такого-то». */
  members: CloudUserLite[]
  /** Открыть снимки персоны: таймлайн с фильтром, а не своя сетка. */
  onOpenPerson: (p: { id: string; name: string }) => void
}) {
  const [people, setPeople] = useState<Person[]>([])
  const [groups, setGroups] = useState<UnnamedGroup[]>([])
  const [managing, setManaging] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [naming, setNaming] = useState<UnnamedGroup | null>(null)
  const [showRare, setShowRare] = useState(false)
  /** Мультивыбор лиц: кликаешь несколько кружков — называешь разом. */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [pickedName, setPickedName] = useState('')
  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const [nameInput, setNameInput] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, u] = await Promise.all([
        cloudApi.get<{ people: Person[] }>('/faces/people', { params: { spaceId } }),
        cloudApi.get<{ groups: UnnamedGroup[] }>('/faces/unnamed', { params: { spaceId } }),
      ])
      setPeople(p.data.people)
      setGroups(u.data.groups)
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setLoading(false)
    }
  }, [spaceId])
  useEffect(() => void load(), [load])

  const nameFaces = async (faceIds: string[], opts: { name?: string; userId?: string }) => {
    try {
      const { data } = await cloudApi.post<{ propagated: number }>('/faces/name', { ...opts, faceIds })
      toast.success(data.propagated > 0 ? `Готово — и узнал ещё на ${data.propagated} лицах` : 'Готово')
      setNaming(null)
      setNameInput('')
      setPicked(new Set())
      setPickedName('')
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }
  const name = (group: UnnamedGroup, opts: { name?: string; userId?: string }) => nameFaces(group.faceIds, opts)

  const link = async (personId: string, userId: string | null) => {
    try {
      await cloudApi.post(`/faces/people/${personId}/link`, { userId })
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const managingPerson = useMemo(() => people.find((p) => p.id === managing) ?? null, [people, managing])
  /*
   * В ленте — только те, кто РЕАЛЬНО есть в этой хуяпке: персоны глобальные,
   * и без фильтра тут стояли люди с нулём снимков из чужих альбомов. Полный
   * список остаётся в подсказках формы имени — привязать к персоне из другой
   * хуяпки по-прежнему можно.
   */
  const present = useMemo(() => people.filter((p) => p.countInSpace > 0), [people])

  return (
    <div className="cl-people">
      {/* Лента персон */}
      <div className="cl-people-strip">
        {present.map((p) => (
          <span key={p.id} className="cl-person-wrap">
            <button
              className={`cl-person${managing === p.id ? ' is-active' : ''}`}
              onClick={() => onOpenPerson({ id: p.id, name: p.name })}
              title={`${p.name} — показать снимки в таймлайне`}
            >
              <span className="cl-person-ava">
                {p.cover ? <FaceCrop face={p.cover} size={64} /> : <span className="cl-face cl-face-empty" style={{ width: 64, height: 64 }}>🙂</span>}
                {p.user ? (
                  <span className="cl-person-badge" title={`Аккаунт: ${p.user.displayName || p.user.username}`}>
                    <Avatar user={p.user} />
                  </span>
                ) : null}
              </span>
              <b>{p.name}</b>
              <i>{p.countInSpace}</i>
            </button>
            {canEdit ? (
              <button
                className="cl-person-gear"
                title="Связка с аккаунтом"
                onClick={() => setManaging(managing === p.id ? null : p.id)}
              >
                ⚙
              </button>
            ) : null}
          </span>
        ))}
        {present.length === 0 && !loading ? (
          <div className="cl-people-hint">
            Пока никого не названо. Ниже — найденные лица: назовите пачку, и я буду узнавать этого человека сам.
          </div>
        ) : null}
      </div>

      {managingPerson && canEdit ? (
        <div className="cl-person-manage">
          <b>{managingPerson.name}</b>
          {managingPerson.user ? (
            <button className="cl-btn ghost sm" onClick={() => { void link(managingPerson.id, null); setManaging(null) }}>
              Отвязать от @{managingPerson.user.username}
            </button>
          ) : (
            <>
              <span className="cl-muted" style={{ fontSize: 12 }}>связать с аккаунтом:</span>
              {members.map((m) => (
                <button key={m.id} className="cl-face-member" onClick={() => { void link(managingPerson.id, m.id); setManaging(null) }}>
                  <Avatar user={m} />
                  <span>{m.displayName || m.username}</span>
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}

        <>
          {/* Неопознанные группы */}
          {groups.length > 0 ? <div className="cl-section-title">Неопознанные</div> : null}
          {loading ? <div className="cl-muted">Смотрим, кто на снимках…</div> : null}
          {!loading && groups.length === 0 && people.length > 0 ? (
            <div className="cl-muted" style={{ fontSize: 13.5 }}>Все найденные лица разобраны.</div>
          ) : null}
          {!loading && groups.length === 0 && people.length === 0 ? (
            <div className="cl-muted" style={{ fontSize: 13.5 }}>
              Лица ещё не просканированы — они появятся здесь после обработки снимков.
            </div>
          ) : null}
          <div className="cl-face-groups">
            {/*
             * Как у телефонов: в основном списке — только кластеры от трёх
             * лиц. Прохожие и туристы с одного-двух случайных кадров прячутся
             * за разворотом, чтобы не хоронить своих в шуме.
             */}
            {(showRare ? groups : groups.filter((g) => g.significant)).map((g, i) => (
              <div className="cl-face-group" key={i}>
                <div className="cl-face-row">
                  {g.faces.slice(0, 6).map((f) => (
                    <button
                      key={f.id}
                      className={`cl-face-pick${picked.has(f.id) ? ' is-picked' : ''}`}
                      title={picked.has(f.id) ? 'Убрать из выбора' : 'Выбрать лицо'}
                      onClick={() => togglePick(f.id)}
                    >
                      <FaceCrop face={f} size={56} />
                    </button>
                  ))}
                  {g.total > 6 ? <span className="cl-face-more">+{g.total - 6}</span> : null}
                </div>
                {canEdit ? (
                  naming === g ? (
                    <form
                      className="cl-face-nameform"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (nameInput.trim()) void name(g, { name: nameInput.trim() })
                      }}
                    >
                      {/* Свои люди — в один клик: пачка сразу привязывается к
                          аккаунту, имя и аватар приезжают из профиля. */}
                      {members.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="cl-face-member"
                          title={`Это ${m.displayName || m.username}`}
                          onClick={() => void name(g, { userId: m.id })}
                        >
                          <Avatar user={m} />
                          <span>{m.displayName || m.username}</span>
                        </button>
                      ))}
                      <input
                        autoFocus
                        className="cl-input"
                        placeholder="Кто это?"
                        list="cl-people-names"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
                      />
                      <datalist id="cl-people-names">
                        {people.map((p) => (
                          <option key={p.id} value={p.name} />
                        ))}
                      </datalist>
                      <button className="cl-btn primary sm" type="submit" disabled={!nameInput.trim()}>
                        Назвать
                      </button>
                    </form>
                  ) : (
                    <button className="cl-btn ghost sm" onClick={() => { setNaming(g); setNameInput('') }}>
                      Это…
                    </button>
                  )
                ) : null}
              </div>
            ))}
          </div>
          {!showRare && groups.some((g) => !g.significant) ? (
            <button className="cl-btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShowRare(true)}>
              Показать редкие лица · {groups.filter((g) => !g.significant).length} групп из случайных кадров
            </button>
          ) : null}
        </>


      {picked.size > 0 ? (
        <div className="cl-facebar">
          <b>
            {picked.size} {picked.size === 1 ? 'лицо' : picked.size < 5 ? 'лица' : 'лиц'}
          </b>
          {members.map((m) => (
            <button key={m.id} className="cl-face-member" onClick={() => void nameFaces([...picked], { userId: m.id })}>
              <Avatar user={m} />
              <span>{m.displayName || m.username}</span>
            </button>
          ))}
          <form
            className="cl-face-nameform"
            onSubmit={(e) => {
              e.preventDefault()
              if (pickedName.trim()) void nameFaces([...picked], { name: pickedName.trim() })
            }}
          >
            <input
              className="cl-input"
              placeholder="Или имя…"
              list="cl-people-names"
              value={pickedName}
              onChange={(e) => setPickedName(e.target.value)}
            />
            <button className="cl-btn primary sm" type="submit" disabled={!pickedName.trim()}>
              Назвать
            </button>
          </form>
          <button className="cl-btn ghost sm" onClick={() => setPicked(new Set())}>
            Сбросить
          </button>
        </div>
      ) : null}


    </div>
  )
}
