/**
 * Модель «Центра управления»: всё живое состояние настроек в одном месте, чтобы плитки обзора, колонка
 * разделов и сами разделы показывали одно и то же (одна настройка — одно состояние, два отображения).
 *
 * Здесь НЕТ новой логики хранения: профиль — PATCH /status/me, местное время — /status/me/local-time,
 * «Чат с Еблушей» — /bot/settings, сеансы — /devices, пароль — /auth/change-password, ретранслятор,
 * обработка голоса, показ экрана и YouTube — те же ключи localStorage, что и раньше (SPEC §6).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { useAppStore } from '../../domain/store/appStore'
import { getStoredDeviceInfo } from '../../domain/device/deviceManager'
import { wipeLocalDeviceData } from '../../domain/device/deviceWipe'
import { setBotChatEnabled, useSystemBotQuery } from '../../domain/bot/useSystemBot'
import { formatLocalTimeLabel, normalizeLocalTimeInfo, type LocalTimeInfo } from '../../domain/localTime/localTime'
import { useMinuteTick, useOwnShareState } from '../../domain/localTime/localTimeStore'
import { applyOwnLocalTimeStateFromServer } from '../../domain/localTime/localTimeSync'
import { isRelayOnlyEnabled, setRelayOnlyEnabled } from '../../utils/callRouting'
import { useVoiceProcessing, writeVoiceKey, type VoiceKey } from '../../utils/voiceProcessing'
import {
  RESOLUTION_PRESETS,
  STORAGE_KEYS,
  readAudio,
  readFps,
  readResolution,
  writeStoredChecked,
  type FpsValue,
  type ResolutionKey,
} from '../../utils/screenSharePrefs'
import { isYouTubeEmbedEnabled, setYouTubeEmbedEnabled } from '../pages/chats/chatsEmbeds'
import { useCallStore } from '../../domain/store/callStore'
import {
  canRevokeOthers,
  deviceCount,
  groupSessions,
  hasOwnDevice,
  profilePatchBody,
  serverRoute,
  voiceSummary,
  type DeviceRecord,
  type ServerRoute,
  type SessionRow,
} from './settingsFormat'
import { buildIndex, countBySection, searchRows, type IndexRow } from './settingsIndex'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './settingsNav'
import type { RowMsg } from './settingsUi'

const httpStatus = (e: unknown): number | undefined => (e as { response?: { status?: number } } | null)?.response?.status

export type SecState = { text: string; kind: '' | 'busy' | 'err' }

// ───────────────────────────── доступ к микрофону и камере ─────────────────────────────

export type PermState = 'granted' | 'denied' | 'prompt' | 'unknown' | 'unsupported'

/** navigator.permissions.query: перечитывается при смене разрешения и при возврате на вкладку. */
function useMediaPermission(name: 'microphone' | 'camera'): PermState {
  const [state, setState] = useState<PermState>('unknown')
  useEffect(() => {
    let cancelled = false
    let status: PermissionStatus | null = null
    const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    if (!supported) {
      setState('unsupported')
      return
    }
    const apply = (s: PermissionState) => {
      if (!cancelled) setState(s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'prompt')
    }
    const read = () => {
      const q = navigator.permissions?.query
      if (!q) {
        setState('unknown')
        return
      }
      navigator.permissions
        .query({ name: name as PermissionName })
        .then((st) => {
          status = st
          apply(st.state)
          st.onchange = () => apply(st.state)
        })
        .catch(() => {
          if (!cancelled) setState('unknown')
        })
    }
    read()
    const onVis = () => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
      if (status) status.onchange = null
    }
  }, [name])
  return state
}

// ───────────────────────────── профиль: правка имени ─────────────────────────────

export type SaveFlow = 'idle' | 'saving' | 'error' | 'done'

function useProfileDraft(meInfo: any | undefined, meId: string | undefined) {
  const qc = useQueryClient()
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [flow, setFlow] = useState<SaveFlow>('idle')
  const [nameErr, setNameErr] = useState(false)
  const doneTimer = useRef<number | null>(null)

  const srvName = String(meInfo?.displayName ?? '')
  const name = nameDraft ?? srvName
  const dirty = nameDraft !== null && nameDraft.trim() !== srvName.trim()

  useEffect(() => () => {
    if (doneTimer.current) window.clearTimeout(doneTimer.current)
  }, [])

  const setName = useCallback((v: string) => {
    setNameDraft(v)
    setNameErr(false)
    setFlow((f) => (f === 'done' ? 'idle' : f))
  }, [])

  const discard = useCallback(() => {
    setNameDraft(null)
    setNameErr(false)
    setFlow('idle')
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    if (flow === 'saving') return false
    const nextName = name.trim()
    if (!nextName) {
      setNameErr(true)
      return false
    }
    setFlow('saving')
    try {
      // уходит только имя: «О себе» и ручного статуса в интерфейсе больше нет, сервер непришедшие поля не трогает
      const res = await api.patch('/status/me', profilePatchBody(nextName))
      const user = res?.data?.user
      qc.setQueryData(['me-info'], (old: any) => ({ ...(old ?? {}), ...(user ?? { displayName: nextName }) }))
      void qc.invalidateQueries({ queryKey: ['me-info'] })
      // своё имя в сессии — его показывает плитка в списке бесед
      try {
        const s = useAppStore.getState().session
        if (s && meId && s.user?.id === meId) useAppStore.getState().setSession({ ...s, user: { ...s.user, displayName: nextName } })
      } catch {
        // сессия не обновилась — имя подтянется при следующем входе
      }
      setNameDraft(null)
      setNameErr(false)
      setFlow('done')
      if (doneTimer.current) window.clearTimeout(doneTimer.current)
      doneTimer.current = window.setTimeout(() => setFlow((f) => (f === 'done' ? 'idle' : f)), 2800)
      return true
    } catch {
      setFlow('error')
      return false
    }
  }, [flow, name, qc, meId])

  return { name, setName, dirty, flow, nameErr, save, discard, srvName }
}

// ───────────────────────────── «Местное время» ─────────────────────────────

function useLocalTimeSetting() {
  const share = useOwnShareState()
  const [load, setLoad] = useState<'loading' | 'ready' | 'unsupported'>('loading')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<boolean | null>(null)
  const [visibleAs, setVisibleAs] = useState<LocalTimeInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useMinuteTick()

  useEffect(() => {
    let cancelled = false
    api
      .get('/status/me/local-time')
      .then((res) => {
        if (cancelled) return
        applyOwnLocalTimeStateFromServer(res?.data)
        setVisibleAs(normalizeLocalTimeInfo((res?.data as { localTime?: unknown } | undefined)?.localTime) ?? null)
        setLoad('ready')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (httpStatus(e) === 404) setLoad('unsupported')
        else {
          setLoad('ready')
          setErr('Не удалось узнать настройку на сервере.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Включили на другом устройстве, а мы знаем только «выключено» (тогда сервер пояс не отдаёт) —
  // дочитать, какой пояс теперь видят собеседники.
  const sharedNow = share?.shareLocalTime === true
  useEffect(() => {
    if (load !== 'ready' || busy || !sharedNow || visibleAs) return
    let cancelled = false
    api
      .get('/status/me/local-time')
      .then((res) => {
        if (!cancelled) setVisibleAs(normalizeLocalTimeInfo((res?.data as { localTime?: unknown } | undefined)?.localTime) ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, sharedNow])

  const checked = pending ?? (share ? share.shareLocalTime : true)

  const toggle = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      setPending(next)
      setErr(null)
      try {
        const res = await api.put('/status/me/local-time', { shareLocalTime: next })
        applyOwnLocalTimeStateFromServer(res?.data)
        setVisibleAs(normalizeLocalTimeInfo((res?.data as { localTime?: unknown } | undefined)?.localTime) ?? null)
      } catch (e: unknown) {
        setErr(httpStatus(e) === 429 ? 'Слишком много переключений — попробуйте через минуту.' : 'Не удалось сохранить настройку. Попробуйте ещё раз.')
      } finally {
        setPending(null)
        setBusy(false)
      }
    },
    [busy],
  )

  const seen = checked && !busy ? formatLocalTimeLabel(visibleAs, new Date()) : null
  let msg: RowMsg = null
  if (load === 'ready' || load === 'loading') {
    if (busy) msg = { kind: 'busy', text: 'Сохраняем…' }
    else if (err) msg = { kind: 'err', text: err }
    else if (load === 'ready') {
      if (checked) msg = seen ? { kind: 'ok', text: `Собеседники видят: ${seen}` } : { kind: 'note', text: 'Собеседники увидят ваше время, как только устройство сообщит часовой пояс.' }
      else msg = { kind: 'dim', text: 'Скрыто: собеседники не видят ваше время.' }
    }
  }
  return { supported: load !== 'unsupported', loading: load === 'loading', checked, busy, toggle, msg, err: !!err, seen }
}

// ───────────────────────────── «Чат с Еблушей» ─────────────────────────────

function useBotChatSetting() {
  const client = useQueryClient()
  const q = useSystemBotQuery()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<boolean | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const info = q.data ?? null
  const checked = pending ?? info?.botChat.botChatEnabled ?? false

  const toggle = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      setPending(next)
      setErr(null)
      try {
        await setBotChatEnabled(client, next)
      } catch (e: unknown) {
        setErr(httpStatus(e) === 429 ? 'Слишком много переключений — попробуйте через минуту.' : 'Не удалось сохранить настройку. Попробуйте ещё раз.')
      } finally {
        setPending(null)
        setBusy(false)
      }
    },
    [busy, client],
  )

  let msg: RowMsg = null
  if (busy) msg = { kind: 'busy', text: 'Сохраняем…' }
  else if (err) msg = { kind: 'err', text: err }
  else msg = checked ? { kind: 'dim', text: 'Включён: «Еблуша» в списке бесед.' } : { kind: 'dim', text: 'Выключен.' }
  return { available: !!info, checked, busy, toggle, msg, err: !!err, conversationId: info?.botChat.conversationId ?? null }
}

// ───────────────────────────── сеансы ─────────────────────────────

async function fetchMyDevices(): Promise<DeviceRecord[]> {
  const response = await api.get('/devices')
  return (response.data?.devices ?? []) as DeviceRecord[]
}

function useSessions(active: boolean) {
  const qc = useQueryClient()
  // тот же ключ, что у ChatsPage: список общий, session:new обновляет его из AppLayout
  const q = useQuery({ queryKey: ['my-devices'], queryFn: fetchMyDevices })
  const [askId, setAskId] = useState<string | null>(null)
  const [askAll, setAskAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<RowMsg>(null)

  let currentId: string | null = null
  try {
    currentId = getStoredDeviceInfo()?.deviceId ?? null
  } catch {
    currentId = null
  }

  // Перечитывается при каждом открытии окна (как у натива)
  useEffect(() => {
    if (active) void q.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const data = q.data as DeviceRecord[] | undefined
  const rows = useMemo<SessionRow[]>(() => groupSessions(data, currentId), [data, currentId])
  const own = hasOwnDevice(data, currentId)
  const canAll = canRevokeOthers(data, currentId)

  const revokeOne = useCallback(
    async (deviceId: string) => {
      if (busy) return
      setBusy(true)
      setMsg(null)
      try {
        await api.delete(`/devices/${encodeURIComponent(String(deviceId))}`)
        setAskId(null)
        await qc.refetchQueries({ queryKey: ['my-devices'] })
        setMsg({ kind: 'ok', text: 'Устройство отключено' })
      } catch {
        setMsg({ kind: 'err', text: 'Не удалось отключить устройство' })
      } finally {
        setBusy(false)
      }
    },
    [busy, qc],
  )

  const revokeOthers = useCallback(async () => {
    if (busy || !canAll) return
    setBusy(true)
    setMsg(null)
    try {
      await api.post('/devices/revoke-others')
      setAskAll(false)
      await qc.refetchQueries({ queryKey: ['my-devices'] })
      setMsg({ kind: 'ok', text: 'Другие устройства отключены' })
    } catch {
      setMsg({ kind: 'err', text: 'Не удалось отключить другие устройства. Попробуйте ещё раз.' })
    } finally {
      setBusy(false)
    }
  }, [busy, canAll, qc])

  return {
    rows,
    total: rows.length,
    loading: q.isLoading,
    failed: q.isError && !data,
    refetch: () => void q.refetch(),
    currentId,
    own,
    canAll,
    askId,
    setAskId,
    askAll,
    setAskAll,
    busy,
    msg,
    setMsg,
    revokeOne,
    revokeOthers,
  }
}

// ───────────────────────────── собираем модель ─────────────────────────────

export interface SettingsModelInput {
  /** внутри комнаты звонка LiveKit (центр открыт из панели звонка) */
  inRoom: boolean
  /** центр открыт именно из звонка — пометка «Вы пришли из звонка» */
  fromCall: boolean
  /** центр сейчас на экране (перечитать сеансы при открытии) */
  active: boolean
  statusText: string
  presence: string | undefined
  /** идёт ли звонок (в любой комнате) */
  callActive?: boolean
  /** для «Открыть чат» с ботом: закрыть центр и открыть беседу */
  openBotChat?: (conversationId: string) => void
  /** выбор файла для нового фото — прежний редактор кадра ChatsPage */
  pickAvatar?: () => void
  /** итог загрузки фото (редактор живёт в ChatsPage) */
  avatarMsg?: string | null
  avatarBusy?: boolean
}

export function useSettingsModelState(input: SettingsModelInput) {
  const me = useAppStore((s) => s.session?.user)
  const meQuery = useQuery({
    queryKey: ['me-info'],
    queryFn: async () => {
      const r = await api.get('/status/me')
      return r.data.user as any
    },
  })
  const meInfo = meQuery.data as any | undefined
  const profile = useProfileDraft(meInfo, me?.id)
  const lt = useLocalTimeSetting()
  const bot = useBotChatSetting()
  const sessions = useSessions(input.active)

  // ── соединение ──
  const [relay, setRelayState] = useState(() => isRelayOnlyEnabled())
  const [relayMsg, setRelayMsg] = useState<RowMsg>(null)
  const route: ServerRoute = useMemo(() => serverRoute(typeof location !== 'undefined' ? location.hostname : ''), [])
  const setRelay = useCallback((v: boolean) => {
    setRelayOnlyEnabled(v)
    const ok = isRelayOnlyEnabled() === v
    if (ok) {
      setRelayState(v)
      setRelayMsg({ kind: 'ok', text: v ? 'Звонки пойдут через ретранслятор — со следующего звонка' : 'Путь для звонков снова выбирается автоматически' })
    } else {
      setRelayState(isRelayOnlyEnabled())
      setRelayMsg({ kind: 'err', text: 'Не удалось сохранить настройку. Попробуйте ещё раз.' })
    }
  }, [])

  // ── звук и видео ──
  const voice = useVoiceProcessing()
  const [voiceErr, setVoiceErr] = useState<string | null>(null)
  const setVoice = useCallback((key: VoiceKey, v: boolean) => {
    const ok = writeVoiceKey(key, v)
    setVoiceErr(ok ? null : 'Не удалось сохранить настройку. Попробуйте ещё раз.')
  }, [])
  const [shareRes, setShareRes] = useState<ResolutionKey>(() => readResolution())
  const [shareFps, setShareFps] = useState<FpsValue>(() => readFps())
  const [shareAudio, setShareAudio] = useState<boolean>(() => readAudio())
  const [shareErr, setShareErr] = useState<string | null>(null)
  const writeShare = useCallback((key: string, value: string, apply: () => void) => {
    if (writeStoredChecked(key, value)) {
      apply()
      setShareErr(null)
    } else setShareErr('Не удалось сохранить настройку. Попробуйте ещё раз.')
  }, [])
  const micPerm = useMediaPermission('microphone')
  const camPerm = useMediaPermission('camera')

  // ── приложение ──
  const [yt, setYtState] = useState(() => isYouTubeEmbedEnabled())
  const [ytErr, setYtErr] = useState<string | null>(null)
  const setYt = useCallback((v: boolean) => {
    const ok = setYouTubeEmbedEnabled(v)
    setYtState(isYouTubeEmbedEnabled())
    setYtErr(ok ? null : 'Не удалось сохранить настройку. Попробуйте ещё раз.')
  }, [])

  // ── звонок ──
  const storeCall = useCallStore((s) => !!(s.activeConvId || s.overlayConvId || s.minimizedCallConvId || s.outgoingCall))
  const inCall = !!input.callActive || storeCall || input.inRoom

  // ── состояния для UI оболочки ──
  const [pwdOpen, setPwdOpen] = useState(false)
  const [pwdBusy, setPwdBusy] = useState(false)
  const [pwdMsg, setPwdMsg] = useState<RowMsg>(null)
  const [exitAsk, setExitAsk] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)

  // ── сводки разделов (строки колонки, имена плиток) ──
  const secState = useCallback(
    (id: SettingsSectionId): SecState => {
      switch (id) {
        case 'profile':
          if (profile.flow === 'error') return { text: 'Не сохранилось', kind: 'err' }
          if (profile.dirty) return { text: 'Есть несохранённое', kind: 'busy' }
          return { text: `${profile.srvName || me?.displayName || me?.username || 'Профиль'} · EBLID ${meInfo?.eblid ?? '— — — —'}`, kind: '' }
        case 'conn':
          return { text: `${route.label} · ${relay ? 'ретранслятор' : 'путь сам'}`, kind: '' }
        case 'av': {
          if (micPerm === 'denied') return { text: 'Нет доступа к микрофону', kind: 'err' }
          if (camPerm === 'denied') return { text: 'Нет доступа к камере', kind: 'err' }
          return { text: voiceSummary(voice.aec, voice.ns, voice.agc).replace(/^вкл: /, ''), kind: '' }
        }
        case 'security':
          if (sessions.failed) return { text: 'Список не загрузился', kind: 'err' }
          if (sessions.loading) return { text: 'Загружаем…', kind: 'busy' }
          return { text: `${deviceCount(sessions.total)} · пароль`, kind: '' }
        case 'app':
          return { text: yt ? 'YouTube в карточке' : 'YouTube в браузере', kind: '' }
      }
    },
    [profile.flow, profile.dirty, profile.srvName, me?.displayName, me?.username, meInfo?.eblid, route.label, relay, micPerm, camPerm, voice, sessions.failed, sessions.loading, sessions.total, yt],
  )

  const attention = useMemo<Record<SettingsSectionId, boolean>>(
    () => ({
      profile: profile.flow === 'error' || lt.err || bot.err,
      conn: relayMsg?.kind === 'err',
      av: micPerm === 'denied' || camPerm === 'denied' || !!voiceErr || !!shareErr,
      security: sessions.failed,
      app: !!ytErr,
    }),
    [profile.flow, lt.err, bot.err, relayMsg, micPerm, camPerm, voiceErr, shareErr, sessions.failed, ytErr],
  )

  // ── указатель поиска с живыми значениями ──
  const index = useMemo<IndexRow[]>(() => {
    const onOff = (v: boolean) => (v ? 'Вкл' : 'Выкл')
    const values: Record<string, string> = {
      'p-photo': meInfo?.avatarUrl ? 'есть фото' : 'нет фото',
      'p-name': profile.name,
      'p-eblid': String(meInfo?.eblid ?? ''),
      'p-ltime': onOff(lt.checked),
      'p-bot': onOff(bot.checked),
      'c-server': route.label,
      'c-relay': onOff(relay),
      'a-mic': input.inRoom ? '' : 'в звонке',
      'a-spk': input.inRoom ? '' : 'в звонке',
      'a-cam': input.inRoom ? '' : 'в звонке',
      'a-permmic': micPerm === 'granted' ? 'есть' : micPerm === 'denied' ? 'нет' : '',
      'a-permcam': camPerm === 'granted' ? 'есть' : camPerm === 'denied' ? 'нет' : '',
      'a-echo': onOff(voice.aec),
      'a-ns': onOff(voice.ns),
      'a-agc': onOff(voice.agc),
      'a-shres': RESOLUTION_PRESETS[shareRes].label,
      'a-shfps': String(shareFps),
      'a-shaud': onOff(shareAudio),
      's-sess': String(sessions.total),
      'ap-yt': onOff(yt),
    }
    return buildIndex({ hasBot: bot.available, values })
  }, [meInfo?.avatarUrl, meInfo?.eblid, profile.name, lt.checked, bot.checked, bot.available, route.label, relay, input.inRoom, micPerm, camPerm, voice, shareRes, shareFps, shareAudio, sessions.total, yt])

  // ── выход: прежний порядок (DELETE своего устройства → logout → стереть локальное) ──
  const logout = useCallback(async () => {
    try {
      const did = getStoredDeviceInfo()?.deviceId
      if (did) await api.delete(`/devices/${encodeURIComponent(String(did))}`)
    } catch {
      // best-effort
    }
    try {
      const refreshToken = useAppStore.getState().session?.refreshToken
      await api.post('/auth/logout', refreshToken ? { refreshToken } : undefined)
    } catch {
      // ошибка выхода на сервере не мешает выйти локально
    }
    wipeLocalDeviceData()
    useAppStore.getState().setSession(null)
  }, [])

  return {
    input,
    me,
    meInfo,
    meLoading: meQuery.isLoading,
    profile,
    lt,
    bot,
    sessions,
    // соединение
    route,
    relay,
    setRelay,
    relayMsg,
    // звук и видео
    voice,
    setVoice,
    voiceErr,
    share: { res: shareRes, fps: shareFps, audio: shareAudio, err: shareErr },
    setShareRes: (v: ResolutionKey) => writeShare(STORAGE_KEYS.resolution, v, () => setShareRes(v)),
    setShareFps: (v: FpsValue) => writeShare(STORAGE_KEYS.fps, String(v), () => setShareFps(v)),
    setShareAudio: (v: boolean) => writeShare(STORAGE_KEYS.audio, v ? '1' : '0', () => setShareAudio(v)),
    micPerm,
    camPerm,
    // приложение
    yt,
    setYt,
    ytErr,
    // звонок
    inCall,
    // пароль, выход, привязка
    pwdOpen,
    setPwdOpen,
    pwdBusy,
    setPwdBusy,
    pwdMsg,
    setPwdMsg,
    exitAsk,
    setExitAsk,
    linkOpen,
    setLinkOpen,
    logout,
    // сводки
    secState,
    attention,
    index,
  }
}

export type SettingsModel = ReturnType<typeof useSettingsModelState>

const ModelCtx = createContext<SettingsModel | null>(null)

export function SettingsModelProvider({ value, children }: { value: SettingsModel; children: ReactNode }) {
  return <ModelCtx.Provider value={value}>{children}</ModelCtx.Provider>
}

export function useSettingsModel(): SettingsModel {
  const m = useContext(ModelCtx)
  if (!m) throw new Error('useSettingsModel: нет SettingsModelProvider')
  return m
}

/** Совпадения поиска: строки и счётчики по разделам. */
export function useSearchResult(model: SettingsModel, query: string) {
  return useMemo(() => {
    const rows = searchRows(model.index, query)
    return { rows, counts: countBySection(rows), ids: rows ? new Set(rows.map((r) => r.id)) : null }
  }, [model.index, query])
}

/** Какие разделы есть на вебе — порядок как у натива. */
export const WEB_SECTIONS = SETTINGS_SECTIONS

