import { useCallback, useEffect, useMemo, useState } from 'react'
import { cloudApi, toCloudError } from '../api'
import type { CloudFile, CloudUserLite } from '../types'
import { Avatar } from './ui'
import { Tiles } from './Gallery'
import { Viewer } from './Viewer'
import { toast } from './ui'

/**
 * Вкладка «Лица». Сверху — лента персон (кружки с именами и счётчиком по
 * этой хуяпке), под ней — либо снимки выбранной персоны, либо «неопознанные»
 * группы лиц, собранные кластеризацией: один человек — одна пачка, назвать
 * можно всю пачку разом. Людей в круге всего несколько, разметка ручная.
 */
const EMPTY_SET = new Set<string>()
const noop = () => undefined

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
type UnnamedGroup = { faces: FaceRef[]; faceIds: string[]; total: number }

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
}: {
  spaceId: string
  canEdit: boolean
  /** Участники хуяпки — кандидаты на привязку «это аккаунт такого-то». */
  members: CloudUserLite[]
}) {
  const [people, setPeople] = useState<Person[]>([])
  const [groups, setGroups] = useState<UnnamedGroup[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<CloudFile[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewerIdx, setViewerIdx] = useState<number | null>(null)
  const [naming, setNaming] = useState<UnnamedGroup | null>(null)
  const [showRare, setShowRare] = useState(false)
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

  // Снимки выбранной персоны — обычный таймлайн-срез с фильтром personId.
  const loadFiles = useCallback(
    async (personId: string, after?: string | null) => {
      const { data } = await cloudApi.get<{ files: CloudFile[]; nextCursor: string | null }>('/files', {
        params: { spaceId, view: 'timeline', personId, limit: 100, ...(after ? { cursor: after } : {}) },
      })
      setFiles((prev) => (after ? [...prev, ...data.files] : data.files))
      setCursor(data.nextCursor)
    },
    [spaceId]
  )
  useEffect(() => {
    if (selected) void loadFiles(selected)
    else setFiles([])
  }, [selected, loadFiles])

  const name = async (group: UnnamedGroup, opts: { name?: string; userId?: string }) => {
    try {
      const { data } = await cloudApi.post<{ propagated: number }>('/faces/name', { ...opts, faceIds: group.faceIds })
      toast.success(data.propagated > 0 ? `Готово — и узнал ещё на ${data.propagated} лицах` : 'Готово')
      setNaming(null)
      setNameInput('')
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const link = async (personId: string, userId: string | null) => {
    try {
      await cloudApi.post(`/faces/people/${personId}/link`, { userId })
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const selectedPerson = useMemo(() => people.find((p) => p.id === selected) ?? null, [people, selected])
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
          <button
            key={p.id}
            className={`cl-person${selected === p.id ? ' is-active' : ''}`}
            onClick={() => setSelected(selected === p.id ? null : p.id)}
            title={`${p.name} · ${p.countInSpace} в этой хуяпке`}
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
        ))}
        {present.length === 0 && !loading ? (
          <div className="cl-people-hint">
            Пока никого не названо. Ниже — найденные лица: назовите пачку, и я буду узнавать этого человека сам.
          </div>
        ) : null}
      </div>

      {/* Снимки выбранной персоны */}
      {selectedPerson ? (
        <>
          <div className="cl-section-title cl-person-head">
            {selectedPerson.name} · {selectedPerson.countInSpace}
            {canEdit ? (
              selectedPerson.user ? (
                <button className="cl-btn ghost sm" onClick={() => void link(selectedPerson.id, null)}>
                  Отвязать от @{selectedPerson.user.username}
                </button>
              ) : (
                <span className="cl-person-linkrow">
                  связать с аккаунтом:
                  {members.map((m) => (
                    <button key={m.id} className="cl-face-member" onClick={() => void link(selectedPerson.id, m.id)}>
                      <Avatar user={m} />
                      <span>{m.displayName || m.username}</span>
                    </button>
                  ))}
                </span>
              )
            ) : null}
          </div>
          <Tiles
            files={files}
            selection={EMPTY_SET}
            selectMode={false}
            onToggleSelect={noop}
            onOpen={(f) => setViewerIdx(files.findIndex((x) => x.id === f.id))}
          />
          {cursor ? (
            <button className="cl-btn sm" style={{ margin: '14px auto', display: 'block' }} onClick={() => void loadFiles(selectedPerson.id, cursor)}>
              Ещё
            </button>
          ) : null}
        </>
      ) : (
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
            {(showRare ? groups : groups.filter((g) => g.total >= 3)).map((g, i) => (
              <div className="cl-face-group" key={i}>
                <div className="cl-face-row">
                  {g.faces.slice(0, 6).map((f) => (
                    <FaceCrop key={f.id} face={f} size={56} />
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
          {!showRare && groups.some((g) => g.total < 3) ? (
            <button className="cl-btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShowRare(true)}>
              Показать редкие лица · {groups.filter((g) => g.total < 3).length} групп по 1–2 кадра
            </button>
          ) : null}
        </>
      )}

      {viewerIdx !== null && files[viewerIdx] ? (
        <Viewer
          files={files}
          index={viewerIdx}
          spaceId={spaceId}
          onIndexChange={setViewerIdx}
          onClose={() => setViewerIdx(null)}
          onFileChanged={(f) => setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, ...f } : x)))}
        />
      ) : null}
    </div>
  )
}
