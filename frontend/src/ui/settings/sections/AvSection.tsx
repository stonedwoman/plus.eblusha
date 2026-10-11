/**
 * Раздел «Звук и видео» (веб). Вкладки, как у натива: «Устройства» · «Обработка голоса» · «Видео в звонке».
 *
 * - «Устройства»: микрофон, динамики и камеру на вебе выбирают только во время звонка (выбор живёт в комнате
 *   LiveKit и не запоминается — как и раньше). Из звонка здесь прежние списки LiveKit строками натива; вне звонка —
 *   пустое состояние. Ниже — «Разрешения браузера»: состояние доступа к микрофону и камере (navigator.permissions).
 * - «Обработка голоса»: эхоподавление / шумоподавление / автоусиление — ключи eb.lk.webrtc.* (раньше — окно звонка).
 * - «Видео в звонке»: «Показ экрана» — разрешение, кадры, звук — ключи eb.lk.screenShare.*; окно «Параметры показа
 *   экрана» при старте показа осталось, эти значения подставляются в него.
 */
import { useCallback, useState } from 'react'
import { useMediaDeviceSelect } from '@livekit/components-react'
import { FPS_OPTIONS, RESOLUTION_PRESETS, type ResolutionKey } from '../../../utils/screenSharePrefs'
import { cleanDeviceLabel } from '../settingsFormat'
import { AV_TAB_NAMES } from '../settingsIndex'
import type { SettingsAvTab } from '../settingsNav'
import { Card, Dash, Empty, Group, Msg, MsgLine, Row, Select, Seg, Small, Tabs, type RowMsg, type SelectOption } from '../settingsUi'
import { useSearchResult, useSettingsModel, type PermState } from '../useSettingsModel'
import { useSettingsUi } from '../settingsUi'

// ───────────────────────────── устройства в звонке ─────────────────────────────

const KIND_TEXT = {
  audioinput: { title: 'Микрофон', desc: 'Через него вас слышат в звонках.', id: 'a-mic', none: 'Микрофоны не найдены.', denied: 'Нет доступа к микрофону. Разрешите его в настройках сайта — значок слева от адреса.' },
  audiooutput: { title: 'Динамики и наушники', desc: 'Через них вы слышите собеседников.', id: 'a-spk', none: 'Устройства вывода звука не найдены.', denied: '' },
  videoinput: { title: 'Камера', desc: 'Её видят собеседники, когда вы включаете видео.', id: 'a-cam', none: 'Камеры не найдены.', denied: 'Нет доступа к камере. Разрешите её в настройках сайта — значок слева от адреса.' },
} as const

function LiveDeviceRow({ kind }: { kind: 'audioinput' | 'audiooutput' | 'videoinput' }) {
  const t = KIND_TEXT[kind]
  const [err, setErr] = useState<string | null>(null)
  // onError обязан быть устойчивым: хук LiveKit перезапускает эффект при смене функции — на каждом кадре получился бы цикл
  const onError = useCallback(
    (e: Error) => {
      const denied = /permission|denied|NotAllowed/i.test(String(e?.name ?? '') + ' ' + String(e?.message ?? ''))
      setErr(denied && t.denied ? t.denied : 'Не удалось получить список устройств.')
    },
    [t],
  )
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    requestPermissions: kind !== 'audiooutput',
    onError,
  })
  const real = devices.filter((d) => d.deviceId !== 'communications')
  const def = real.find((d) => d.deviceId === 'default')
  const options: SelectOption[] = real.map((d) =>
    d.deviceId === 'default'
      ? { value: d.deviceId, label: 'По умолчанию', sub: `сейчас: ${cleanDeviceLabel(d.label) || 'системное устройство'}` }
      : { value: d.deviceId, label: cleanDeviceLabel(d.label) || 'Устройство' },
  )
  const value = options.some((o) => o.value === activeDeviceId) ? activeDeviceId : def ? 'default' : (options[0]?.value ?? '')
  const msg: RowMsg = err
    ? { kind: 'err', text: err }
    : !real.length
      ? { kind: 'note', text: t.none }
      : kind === 'audiooutput'
        ? { kind: 'dim', text: 'На Safari и iPhone переключение вывода звука может быть недоступно.' }
        : null
  return (
    <Row id={t.id} title={t.title} desc={t.desc} wide err={!!err}
      ctl={
        <Select
          label={t.title}
          value={value}
          options={options}
          placeholder="Нет устройств"
          disabled={!options.length}
          invalid={!!err}
          onChange={(id) => {
            setErr(null)
            void setActiveMediaDevice(id).catch(() => setErr('Не удалось переключить устройство.'))
          }}
        />
      }
    >
      <MsgLine msg={msg} />
    </Row>
  )
}

// ───────────────────────────── доступ ─────────────────────────────

function permMsg(state: PermState, what: 'микрофон' | 'камеру'): { msg: RowMsg; err: boolean } {
  const acc = what === 'микрофон' ? 'микрофону' : 'камере'
  const wordAcc = what === 'микрофон' ? 'его' : 'её'
  switch (state) {
    case 'granted':
      return { msg: { kind: 'ok', text: 'Разрешён.' }, err: false }
    case 'denied':
      return { msg: { kind: 'err', text: `Браузер запретил ${what}. Разрешите ${wordAcc} в настройках сайта — значок слева от адреса.` }, err: true }
    case 'unsupported':
      return { msg: { kind: 'note', text: `Браузер не даёт доступ к ${acc} на этой странице: нужен защищённый адрес (https).` }, err: false }
    default:
      return { msg: { kind: 'note', text: `Браузер спросит при первом включении ${what === 'микрофон' ? 'микрофона' : 'камеры'}.` }, err: false }
  }
}

function PermissionRows() {
  const m = useSettingsModel()
  const mic = permMsg(m.micPerm, 'микрофон')
  const cam = permMsg(m.camPerm, 'камеру')
  return (
    <>
      <Row id="a-permmic" title="Доступ к микрофону" desc="Без него вас не слышно в звонках и не записать голосовое." err={mic.err}>
        <MsgLine msg={mic.msg} />
      </Row>
      <Row id="a-permcam" title="Доступ к камере" desc="Без него собеседники не увидят ваше видео." err={cam.err}>
        <MsgLine msg={cam.msg} />
      </Row>
    </>
  )
}

// ───────────────────────────── раздел ─────────────────────────────

export function AvSection({ tab, setTab, query }: { tab: SettingsAvTab; setTab: (t: SettingsAvTab) => void; query: string }) {
  const m = useSettingsModel()
  const { mode } = useSettingsUi()
  const { rows } = useSearchResult(m, query)
  const tabCount = (t: SettingsAvTab) => (rows ? rows.filter((r) => r.sec === 'av' && r.tab === t).length : 0)
  const phone = mode === 'phone'
  const fromCall = m.input.fromCall

  const tabs = (['dev', 'proc', 'video'] as const).map((id) => ({
    id,
    label: AV_TAB_NAMES[id],
    count: rows ? tabCount(id) : 0,
    faded: !!rows && tabCount(id) === 0,
    bang: id === 'dev' && (m.micPerm === 'denied' || m.camPerm === 'denied'),
  }))

  return (
    <>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Звук и видео" />

      {tab === 'dev' ? (
        <div key="dev" className="ebs-tabpane">
          {fromCall ? (
            <div className="ebs-grp">
              <Dash>
                <b>Вы пришли из звонка.</b> Всё меняется прямо в разговоре; закройте окно — вернётесь к звонку.
              </Dash>
            </div>
          ) : null}
          <Group>
            {m.input.inRoom ? (
              <>
                <Card>
                  <LiveDeviceRow kind="audioinput" />
                  <LiveDeviceRow kind="audiooutput" />
                  <LiveDeviceRow kind="videoinput" />
                </Card>
                <Small>Выбор применяется сразу и действует до конца звонка: на вебе он не запоминается.</Small>
              </>
            ) : (
              <Card id="a-mic a-spk a-cam">
                <Empty icon="mic" title="Устройства выбираются во время звонка" desc="Микрофон, динамики и камеру переключают в панели звонка: «Настройки» откроют эту вкладку со списками." />
              </Card>
            )}
          </Group>
          <Group icon="lock" title="Разрешения браузера">
            <Card>
              <PermissionRows />
            </Card>
          </Group>
        </div>
      ) : null}

      {tab === 'proc' ? (
        <div key="proc" className="ebs-tabpane">
          {!fromCall ? (
            <div className="ebs-grp">
              <Dash>{m.inCall ? 'Меняется прямо в разговоре — возможен короткий щелчок.' : 'Сработает в следующем звонке.'}</Dash>
            </div>
          ) : null}
          <Group>
            <Card>
              <Row id="a-echo" title="Эхоподавление" desc="Убирает голос собеседника, вернувшийся в микрофон из динамиков. На колонках без него вас слышно с эхом." toggle={{ checked: m.voice.aec, onChange: (v) => m.setVoice('aec', v) }} />
              <Row id="a-ns" title="Шумоподавление" desc="Убирает ровный фон — вентилятор, гул, кондиционер. Клавиатуру и стуки почти не трогает." toggle={{ checked: m.voice.ns, onChange: (v) => m.setVoice('ns', v) }} />
              <Row id="a-agc" title="Автоусиление" desc="Подтягивает тихий голос до обычной громкости. В паузах вместе с ним слышнее и фон." toggle={{ checked: m.voice.agc, onChange: (v) => m.setVoice('agc', v) }} err={!!m.voiceErr}>
                {m.voiceErr ? <Msg kind="err">{m.voiceErr}</Msg> : null}
              </Row>
            </Card>
            <Small>Посреди звонка переключение перезапускает микрофон — возможен короткий щелчок.</Small>
          </Group>
        </div>
      ) : null}

      {tab === 'video' ? (
        <div key="video" className="ebs-tabpane">
          <Group icon="share" title="Показ экрана">
            <Card>
              <Row
                id="a-shres"
                title="Разрешение"
                desc="С каким размером кадра начинается показ экрана."
                wide
                ctl={
                  <Select
                    label="Разрешение показа экрана"
                    value={m.share.res}
                    options={(Object.keys(RESOLUTION_PRESETS) as ResolutionKey[]).map((k) => ({ value: k, label: `${RESOLUTION_PRESETS[k].label} · ${RESOLUTION_PRESETS[k].hint}` }))}
                    onChange={(v) => m.setShareRes(v as ResolutionKey)}
                  />
                }
              />
              <Row
                id="a-shfps"
                title="Кадры в секунду"
                desc="Плавность показа: больше кадров — больше трафика."
                wide
                ctl={<Seg label="Кадры в секунду" full={phone} value={m.share.fps} options={FPS_OPTIONS.map((f) => ({ value: f, label: String(f) }))} onChange={(v) => m.setShareFps(v)} />}
              />
              <Row id="a-shaud" title="Звук" desc="Собеседники слышат звук показанной вкладки или экрана." toggle={{ checked: m.share.audio, onChange: m.setShareAudio }} err={!!m.share.err}>
                {m.share.err ? <Msg kind="err">{m.share.err}</Msg> : null}
              </Row>
            </Card>
            <Small>Эти значения подставятся в окно «Параметры показа экрана» — там их можно поменять перед началом показа.</Small>
          </Group>
        </div>
      ) : null}
    </>
  )
}
