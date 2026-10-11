/**
 * Раздел «Профиль»: фото, имя, EBLID, «Местное время», «Чат с Еблушей» + панель сохранения.
 * Имя (раньше — только на мёртвой /settings) уходит по «Сохранить изменения». Поля «О себе» и выбора статуса в
 * интерфейсе нет (решение владельца 2026-10-11): присутствие определяется само.
 * Фото на вебе — прежний редактор кадра ChatsPage: «Заменить фото» открывает выбор файла, а в самом редакторе —
 * кнопка «Загрузить», как и раньше. Щелчок по кругу — прежняя галерея с удалением прошлых снимков.
 */
import { useState } from 'react'
import { api } from '../../../utils/api'
import { Avatar } from '../../components/Avatar'
import { AvatarViewer, resolveAvatarSrc } from '../../components/UserProfileCard'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, Card, Group, Msg, MsgLine, Row, SaveBar, copyText, useSettingsUi } from '../settingsUi'
import { useSettingsModel } from '../useSettingsModel'

export function ProfileSection() {
  const m = useSettingsModel()
  const { mode } = useSettingsUi()
  const qc = useQueryClient()
  const { profile, meInfo, me, lt, bot } = m
  const [viewerOpen, setViewerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [galleryErr, setGalleryErr] = useState<string | null>(null)

  const currentAvatar: string | undefined = (meInfo?.avatarUrl ?? me?.avatarUrl ?? undefined) || undefined
  const history: string[] = Array.isArray(meInfo?.avatarHistory) ? (meInfo.avatarHistory as string[]) : []
  const rawAvatars = [currentAvatar, ...history].filter((u): u is string => typeof u === 'string' && u.length > 0)
  const items: Array<{ raw: string; src: string; isCurrent: boolean }> = []
  const seen = new Set<string>()
  rawAvatars.forEach((raw, i) => {
    if (seen.has(raw)) return
    seen.add(raw)
    const src = resolveAvatarSrc(raw)
    if (src) items.push({ raw, src, isCurrent: i === 0 })
  })
  const hasPhoto = !!currentAvatar && !currentAvatar.startsWith('emoji:')

  const displayName = profile.name || me?.displayName || me?.username || 'Я'

  const copyEblid = async () => {
    const eblid = String(meInfo?.eblid ?? '').trim()
    if (!eblid) return
    if (await copyText(eblid)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  const saveState = profile.flow === 'saving' ? 'saving' : profile.flow === 'error' ? 'error' : profile.flow === 'done' ? 'done' : 'dirty'
  const showBar = profile.dirty || profile.flow !== 'idle'
  const saveHint = 'Новое имя увидят другие пользователи.'

  return (
    <>
      <Group first>
        <Card>
          <Row
            id="p-photo"
            title="Фото профиля"
            desc="В круг попадёт центральная часть фото."
            desc2="Щёлкните по фото — откроются оно и прежние снимки."
            wide
            ctl={
              <>
                <Btn sm icon="image" onClick={() => m.input.pickAvatar?.()} disabled={!m.input.pickAvatar || m.input.avatarBusy}>
                  {hasPhoto ? 'Заменить фото' : 'Добавить фото'}
                </Btn>
                <button
                  type="button"
                  className="ebs-avabtn"
                  aria-label="Фото профиля"
                  title={items.length ? 'Открыть фото и историю' : undefined}
                  onClick={() => items.length && setViewerOpen(true)}
                  style={{ cursor: items.length ? 'pointer' : 'default' }}
                >
                  <Avatar name={displayName} id={me?.id ?? 'me'} size={72} avatarUrl={currentAvatar} />
                </button>
              </>
            }
          >
            {m.input.avatarBusy ? <Msg kind="busy">Загружаем фото…</Msg> : m.input.avatarMsg ? <Msg kind="ok">Фото обновлено.</Msg> : null}
            {galleryErr ? <Msg kind="err">{galleryErr}</Msg> : null}
          </Row>
          <Row id="p-name" title="Отображаемое имя" desc="Под этим именем вас увидят другие пользователи." wide err={profile.nameErr}
            ctl={
              <input
                className={`ebs-field${profile.name.trim() !== profile.srvName.trim() ? ' is-edited' : ''}`}
                value={profile.name}
                maxLength={120}
                placeholder="Введите отображаемое имя"
                aria-label="Отображаемое имя"
                aria-invalid={profile.nameErr || undefined}
                autoComplete="off"
                onChange={(e) => profile.setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && profile.dirty) void profile.save()
                }}
              />
            }
          >
            {profile.nameErr ? <Msg kind="err">Введите отображаемое имя.</Msg> : null}
          </Row>
          <Row
            id="p-eblid"
            title="EBLID"
            desc="Ваш номер в Еблуше — по нему вас находят в «Контактах»."
            wide
            ctl={
              <>
                <span className="ebs-cap" style={{ height: 32 }}>
                  EBLID <b className="ebs-num">{meInfo?.eblid ?? '— — — —'}</b>
                </span>
                <Btn sm icon={copied ? 'check' : 'copy'} onClick={() => void copyEblid()} disabled={!meInfo?.eblid}>
                  {copied ? 'Скопировано' : 'Скопировать'}
                </Btn>
              </>
            }
          />
        </Card>
      </Group>

      {lt.supported ? (
        <Group icon="clock" title="Местное время">
          <Card>
            <Row
              id="p-ltime"
              title="Показывать моё местное время"
              desc="Собеседники в личных чатах видят под вашим именем, который у вас час, и город по часовому поясу."
              toggle={{ checked: lt.checked, onChange: (v) => void lt.toggle(v), disabled: lt.busy || lt.loading }}
              err={lt.err}
            >
              <MsgLine msg={lt.msg} />
            </Row>
          </Card>
        </Group>
      ) : null}

      {bot.available ? (
        <Group icon="bot" title="Бот «Еблуша»">
          <Card>
            <Row
              id="p-bot"
              title="Чат с Еблушей"
              desc="Личный чат с ботом: там можно писать без обращения. В остальных беседах зовите «Еблуша, …»."
              toggle={{ checked: bot.checked, onChange: (v) => void bot.toggle(v), disabled: bot.busy }}
              err={bot.err}
            >
              {bot.checked && !bot.busy && bot.conversationId && m.input.openBotChat ? (
                <Btn sm icon="bot" onClick={() => m.input.openBotChat?.(String(bot.conversationId))}>
                  Открыть чат
                </Btn>
              ) : null}
              <MsgLine msg={bot.msg} />
            </Row>
          </Card>
        </Group>
      ) : null}

      {showBar ? (
        <SaveBar
          state={saveState}
          hint={saveHint}
          compact={mode === 'phone'}
          onDiscard={profile.discard}
          onSave={() => void profile.save()}
        />
      ) : null}

      {viewerOpen && items.length ? (
        <AvatarViewer
          items={items}
          startIndex={0}
          canManage
          onDelete={async (raw) => {
            setGalleryErr(null)
            try {
              await api.post('/status/me/avatars/remove', { url: raw })
              await qc.refetchQueries({ queryKey: ['me-info'] })
              if (items.length <= 1) setViewerOpen(false)
            } catch {
              setGalleryErr('Не удалось удалить фото.')
              setViewerOpen(false)
            }
          }}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}
    </>
  )
}
