/**
 * Плитки обзора (веб: пять штук) — вход в раздел и одновременно сводка с живым состоянием (SPEC §1.2, §3.5).
 * Подложка — кнопка на всю плитку, содержимое лежит слоем поверх и ловит мышь только на своих действиях
 * (вложенных кнопок в кнопке нет). Поиск заменяет тело плитки выдачей (SPEC §3.9).
 */
import type { ReactNode } from 'react'
import { Avatar } from '../components/Avatar'
import { usePresenceDevice } from '../../domain/store/presenceDeviceStore'
import { statusDotColor } from '../components/UserProfileCard'
import { RESOLUTION_PRESETS } from '../../utils/screenSharePrefs'
import { deviceCount, deviceWord, pluralRu as plural, sessionTileLine, shareSummary, voiceSummary } from './settingsFormat'
import { excerptFor, SECTION_NAMES, type IndexRow, type Seg } from './settingsIndex'
import { resultsPerTile, type SettingsMode } from './settingsLayout'
import type { SettingsSectionId } from './settingsNav'
import { Hl, Ic, Kbd, Switch, type IconName } from './settingsUi'
import type { SettingsModel } from './useSettingsModel'

export const SECTION_ICONS: Record<SettingsSectionId, IconName> = { profile: 'user', conn: 'globe', av: 'mic', security: 'shield', app: 'app' }

export interface TilesCtx {
  mode: SettingsMode
  model: SettingsModel
  query: string
  rows: IndexRow[] | null
  firstHit: IndexRow | null
  onOpen: (id: SettingsSectionId, from: HTMLElement | null) => void
  onOpenRow: (row: IndexRow) => void
  onOpenPassword: () => void
}

/** Имя плитки для диктора: «{Раздел}: {состояние}[, требует внимания]». */
export function tileLabel(model: SettingsModel, id: SettingsSectionId): string {
  const s = model.secState(id)
  return `${SECTION_NAMES[id]}: ${s.text}${model.attention[id] ? ', требует внимания' : ''}`
}

const Segs = ({ segs }: { segs: Seg[] }) => (
  <>
    {segs.map((s, i) => (s.hit ? <mark key={i}>{s.t}</mark> : <span key={i}>{s.t}</span>))}
  </>
)

function Results({ id, rows, ctx }: { id: SettingsSectionId; rows: IndexRow[]; ctx: TilesCtx }) {
  const max = resultsPerTile(id, ctx.mode)
  const shown = rows.slice(0, max)
  return (
    <div className="ebs-results">
      {shown.map((r) => (
        <button key={r.id} type="button" className="ebs-res ebs-act" onClick={() => ctx.onOpenRow(r)}>
          <Ic n="arrow" />
          <span className="ebs-res__t">
            <Hl text={r.title} />
          </span>
          <span className="ebs-res__v">{ctx.firstHit && r.id === ctx.firstHit.id && ctx.mode !== 'phone' ? <Kbd>Enter</Kbd> : r.val}</span>
          <span className="ebs-res__s">
            <Segs segs={excerptFor(r, ctx.query)} />
          </span>
        </button>
      ))}
      {rows.length > max ? <div className="ebs-res__more">и ещё {rows.length - max} — откройте раздел</div> : null}
    </div>
  )
}

function TileShell({
  id,
  ctx,
  extra,
  hot,
  children,
  span,
}: {
  id: SettingsSectionId
  ctx: TilesCtx
  extra?: ReactNode
  hot?: boolean
  children: ReactNode
  span?: 1 | 2
}) {
  const { model, mode, rows } = ctx
  const hits = rows ? rows.filter((r) => r.sec === id) : null
  const found = !!hits && hits.length > 0
  const faded = !!hits && hits.length === 0 && mode !== 'phone'
  const sick = model.attention[id] && !rows
  const dirty = id === 'profile' && model.profile.dirty
  const cls = ['ebs-tile', sick ? 'ebs-tile--sick' : '', found ? 'ebs-tile--found' : '', faded ? 'ebs-tile--faded' : '', hot ? 'ebs-tile--hot' : '', span === 2 ? 'is-span2' : ''].filter(Boolean).join(' ')
  const label = hits && hits.length ? `${SECTION_NAMES[id]}: ${hits.length} ${plural(hits.length, 'совпадение', 'совпадения', 'совпадений')}` : tileLabel(model, id)
  return (
    <section className={cls} style={mode === 'phone' ? undefined : { gridArea: id }} data-tile={id}>
      <button
        type="button"
        className="ebs-tile__hit"
        data-tile-hit={id}
        aria-label={label}
        {...{ 'aria-description': 'Открыть раздел' }}
        onClick={(e) => ctx.onOpen(id, e.currentTarget.closest('section'))}
      />
      <div className="ebs-tile__body">
        {found ? (
          <>
            <div className="ebs-tile__head">
              <span className="ebs-sq">
                <Ic n={SECTION_ICONS[id]} />
              </span>
              <span className="ebs-tile__name">{SECTION_NAMES[id]}</span>
              <span className="ebs-count" aria-hidden="true">{hits!.length}</span>
            </div>
            <Results id={id} rows={hits!} ctx={ctx} />
          </>
        ) : (
          <>
            <div className="ebs-tile__head">
              <span className="ebs-sq">
                <Ic n={SECTION_ICONS[id]} />
              </span>
              <span className="ebs-tile__name">{SECTION_NAMES[id]}</span>
              {dirty ? <span className="ebs-adot" aria-hidden="true" /> : null}
              {extra}
              {model.attention[id] ? (
                <span className="ebs-bang" aria-hidden="true">!</span>
              ) : null}
              {mode !== 'phone' ? (
                <span className="ebs-tile__exp" style={model.attention[id] || extra ? undefined : undefined} aria-hidden="true">
                  <Ic n="expand" />
                </span>
              ) : null}
            </div>
            {children}
          </>
        )}
      </div>
    </section>
  )
}

// ───────────────────────────── Профиль ─────────────────────────────

function ProfileTile({ ctx, span }: { ctx: TilesCtx; span?: 1 | 2 }) {
  const { model, mode } = ctx
  const { profile, meInfo, me } = model
  const phone = mode === 'phone'
  const name = profile.name.trim() || me?.displayName || me?.username || 'Я'
  const avatarUrl: string | undefined = ((meInfo?.avatarUrl ?? me?.avatarUrl) as string | undefined) || undefined
  const device = usePresenceDevice(me?.id)
  const deviceWord = device === 'mobile' ? 'телефон' : device === 'desktop' ? 'ПК' : device === 'web' ? 'браузер' : ''
  const presence = model.input.presence as any
  const eblid = meInfo?.eblid ?? '— — — —'
  const sizeAva = phone ? 60 : mode === 'cmp' ? 72 : 100
  return (
    <TileShell id="profile" ctx={ctx} span={phone ? 2 : span}>
      <div className="ebs-tp__banner" aria-hidden="true" />
      {phone ? (
        <div className="ebs-tp__row">
          <span className="ebs-tp__ava">
            <Avatar name={name} id={me?.id ?? 'me'} size={sizeAva} avatarUrl={avatarUrl} presence={presence} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="ebs-tp__name">{name}</div>
            <div className="ebs-tp__caps">
              <span className="ebs-cap ebs-cap--sm">
                EBLID <b className="ebs-num">{eblid}</b>
              </span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="ebs-tp__center">
            <span className="ebs-tp__ava" style={mode === 'cmp' ? { marginTop: 8 } : undefined}>
              <Avatar name={name} id={me?.id ?? 'me'} size={sizeAva} avatarUrl={avatarUrl} presence={presence} />
            </span>
            <div className="ebs-tp__name">{name}</div>
            {model.input.statusText ? (
              <div className="ebs-tp__status">
                <span className="ebs-pdot" style={{ background: statusDotColor(String(presence ?? meInfo?.status ?? 'OFFLINE')) }} />
                <span>
                  {model.input.statusText}
                  {deviceWord ? ` · ${deviceWord}` : ''}
                </span>
              </div>
            ) : null}
            <span className="ebs-cap" style={{ marginTop: 4 }}>
              EBLID <b className="ebs-num">{eblid}</b>
            </span>
          </div>
          <div className="ebs-tile__foot ebs-tp__foot">
            <Ic n="pencil" /> {profile.dirty ? <span className="ebs-cream" style={{ color: 'var(--eb-cream)' }}>Сохраните изменения</span> : 'Сменить фото или имя'}
          </div>
        </>
      )}
    </TileShell>
  )
}

// ───────────────────────────── Соединение ─────────────────────────────

function ConnTile({ ctx, span }: { ctx: TilesCtx; span?: 1 | 2 }) {
  const { model, mode } = ctx
  const phone = mode === 'phone'
  const compact = mode !== 'wide'
  const r = model.route
  return (
    <TileShell id="conn" ctx={ctx} span={span}>
      <div className={`ebs-tile__big${r.kind === 'other' ? ' is-host' : ''}`}>{r.label}</div>
      {r.kind !== 'other' ? (
        <div style={{ marginTop: 8 }}>
          <span className="ebs-cap ebs-cap--sm ebs-cap--mono">{r.host}</span>
        </div>
      ) : null}
      <div className="ebs-tile__fill" />
      <div className="ebs-tile__foot">
        <Ic n="zap" />
        <span>
          {phone ? '' : 'Звонки: '}
          <b>{model.relay ? (compact ? 'ретранслятор' : 'через ретранслятор') : compact ? 'путь сам' : 'путь выбирается сам'}</b>
        </span>
      </div>
    </TileShell>
  )
}

// ───────────────────────────── Звук и видео ─────────────────────────────

function permWord(s: string, kind: 'mic' | 'cam'): string {
  if (s === 'granted') return 'есть'
  if (s === 'denied') return 'запрещён'
  if (s === 'unsupported') return 'недоступен'
  return kind === 'mic' ? 'спросим' : 'спросим'
}

function AvTile({ ctx, span }: { ctx: TilesCtx; span?: 1 | 2 }) {
  const { model, mode } = ctx
  const phone = mode === 'phone'
  const cmp = mode === 'cmp'
  const v = model.voice
  const denied = model.micPerm === 'denied' || model.camPerm === 'denied'
  const voiceFull = voiceSummary(v.aec, v.ns, v.agc)
  const share = shareSummary(RESOLUTION_PRESETS[model.share.res].label, model.share.fps, model.share.audio)
  const inCallCap = model.inCall ? <span className="ebs-cap ebs-cap--xs">в звонке</span> : null
  type L = { icon: IconName; label?: string; value: string; dim?: boolean; err?: boolean }
  const lines: L[] = phone
    ? [
        { icon: 'sliders', value: v.aec && v.ns && v.agc ? 'Голос: всё вкл.' : `Голос: ${voiceFull.replace(/^вкл: /, '')}` },
        { icon: 'share', value: `Экран: ${RESOLUTION_PRESETS[model.share.res].label}` },
        denied ? { icon: 'alert', value: model.micPerm === 'denied' ? 'Нет доступа к микрофону' : 'Нет доступа к камере', err: true } : { icon: 'mic', value: model.input.inRoom ? 'Выбор — здесь' : 'Выбор — в звонке', dim: true },
      ]
    : [
        { icon: 'sliders', label: cmp ? 'Голос' : 'Обработка голоса', value: voiceFull },
        { icon: 'share', label: 'Показ экрана', value: share },
        { icon: 'mic', label: cmp ? 'Устройства' : 'Микрофон и камера', value: model.input.inRoom ? 'меняются в этом окне' : 'выбираются в звонке', dim: true },
        {
          icon: denied ? 'alert' : 'lock',
          label: 'Доступ',
          value: `микрофон — ${permWord(model.micPerm, 'mic')} · камера — ${permWord(model.camPerm, 'cam')}`,
          err: denied,
        },
      ]
  const shown = cmp ? lines.slice(0, 3) : lines
  return (
    <TileShell id="av" ctx={ctx} extra={inCallCap} span={span}>
      <div style={{ marginTop: 12 }}>
        {shown.map((l, i) => (
          <div key={i} className={`ebs-tmini${l.err ? ' ebs-tmini--err' : ''}`}>
            <Ic n={l.icon} />
            {l.label ? <span className="ebs-tmini__l">{l.label}</span> : null}
            <span className={`ebs-tmini__v${l.dim ? ' is-dim' : ''}${l.err ? ' is-err' : ''}`}>{l.value}</span>
          </div>
        ))}
      </div>
    </TileShell>
  )
}

// ───────────────────────────── Безопасность ─────────────────────────────

function SecurityTile({ ctx, span }: { ctx: TilesCtx; span?: 1 | 2 }) {
  const { model, mode } = ctx
  const s = model.sessions
  const phone = mode === 'phone'
  const cmp = mode === 'cmp'
  const n = s.total
  const open = ctx.onOpenPassword

  const state: 'loading' | 'failed' | 'empty' | 'ok' = s.failed ? 'failed' : s.loading ? 'loading' : n === 0 ? 'empty' : 'ok'
  const countBlock =
    state === 'loading' ? (
      <>
        <div className="ebs-tile__big" style={{ fontSize: 'var(--tile-sub)', lineHeight: '22px', fontWeight: 600, display: 'flex', gap: 9, alignItems: 'center' }}>
          <span className="ebs-spin" aria-hidden="true" /> Загружаем устройства…
        </div>
      </>
    ) : state === 'failed' ? (
      <>
        <div className="ebs-tile__big" style={{ color: 'var(--eb-danger-text)' }}>Не загрузилось</div>
        <div className="ebs-tile__sub" style={{ whiteSpace: 'normal' }}>Не удалось загрузить список устройств.</div>
      </>
    ) : state === 'empty' ? (
      <>
        <div className="ebs-tile__big">Нет устройств</div>
        <div className="ebs-tile__sub">других входов в аккаунт нет</div>
      </>
    ) : phone ? (
      <>
        <div className="ebs-tile__big ebs-num">
          {n} <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0 }}>{deviceWord(n)}</span>
        </div>
        <div className="ebs-tile__sub">где открыт аккаунт</div>
      </>
    ) : (
      <>
        <div className="ebs-tile__big ebs-num" style={{ marginTop: 2 }}>{deviceCount(n)}</div>
        <div className="ebs-tile__sub">где открыт ваш аккаунт</div>
      </>
    )

  if (phone) {
    return (
      <TileShell id="security" ctx={ctx} span={span}>
        {countBlock}
        <div className="ebs-tile__fill" />
        <button type="button" className="ebs-tile__foot ebs-act" style={{ textAlign: 'left' }} onClick={open} aria-label="Изменить пароль">
          <Ic n="key" />
          <b>Пароль</b>
          <Ic n="chev" />
        </button>
      </TileShell>
    )
  }

  const maxRows = 3
  const shown = s.rows.slice(0, maxRows)
  return (
    <TileShell id="security" ctx={ctx} span={span}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1.15fr', gap: 20, flex: 1, minHeight: 0, marginTop: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {countBlock}
          <div className="ebs-tile__fill" />
          <button type="button" className="ebs-act ebs-pwdbtn" onClick={open} aria-label="Изменить пароль">
            <span className="ebs-sq">
              <Ic n="key" />
            </span>
            <span style={{ flex: 1 }}>
              {cmp ? (
                <b style={{ fontSize: 14 }}>Изменить пароль</b>
              ) : (
                <>
                  <b style={{ display: 'block', fontSize: 14 }}>Пароль</b>
                  <span className="ebs-mut" style={{ fontSize: 12.5 }}>для входа в аккаунт</span>
                </>
              )}
            </span>
            <Ic n="chev" className="ebs-amb" />
          </button>
        </div>
        <div style={{ background: 'var(--eb-border)' }} />
        <div style={{ minWidth: 0 }}>
          {state === 'ok'
            ? shown.map((r, i) => (
                <div key={String(r.device.id)} className="ebs-tsess" style={i === 0 ? { borderTop: 0 } : undefined}>
                  <span className="ebs-sess__ic" style={{ width: 34, height: 34 }}>
                    <Ic n={r.kind === 'phone' ? 'smartphone' : r.kind === 'tablet' ? 'tablet' : r.kind === 'desktop' ? 'monitor' : 'browser'} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <b className="ebs-tsess__n">
                      {r.name}
                      {r.count > 1 ? <span className="ebs-mut" style={{ fontWeight: 500 }}> +{r.count - 1}</span> : null}
                    </b>
                    <span className={`ebs-tsess__m ${r.keysReady ? 'ebs-mut' : 'ebs-amb'}`} style={r.keysReady ? undefined : { fontWeight: 600 }}>
                      {sessionTileLine(r)}
                    </span>
                  </span>
                </div>
              ))
            : null}
          {state === 'ok' && n > maxRows ? <div className="ebs-res__more">и ещё {n - maxRows} — откройте раздел</div> : null}
          {state === 'ok' && !cmp && !s.own ? (
            <div className="ebs-res__more" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <Ic n="info" className="ebs-amb" /> Этот браузер в списке не значится
            </div>
          ) : null}
        </div>
      </div>
    </TileShell>
  )
}

// ───────────────────────────── Приложение ─────────────────────────────

function AppTile({ ctx, span }: { ctx: TilesCtx; span?: 1 | 2 }) {
  const { model } = ctx
  return (
    <TileShell id="app" ctx={ctx} span={span}>
      <div className="ebs-tile__big">{model.yt ? 'В карточке' : 'В браузере'}</div>
      <div className="ebs-tile__sub">ролики YouTube</div>
      <div className="ebs-tile__fill" />
      <div className="ebs-tile__foot" style={{ justifyContent: 'space-between' }}>
        <span className="ebs-cap ebs-cap--sm">
          <Ic n="play" /> YouTube
        </span>
        <Switch small checked={model.yt} onChange={model.setYt} label="Встроенный проигрыватель YouTube" />
      </div>
    </TileShell>
  )
}

export function OverviewTiles({ ctx, ids, spans }: { ctx: TilesCtx; ids: readonly SettingsSectionId[]; spans?: Record<string, 1 | 2> }) {
  return (
    <>
      {ids.map((id) => {
        const span = spans?.[id]
        return id === 'profile' ? (
          <ProfileTile key={id} ctx={ctx} span={span} />
        ) : id === 'conn' ? (
          <ConnTile key={id} ctx={ctx} span={span} />
        ) : id === 'av' ? (
          <AvTile key={id} ctx={ctx} span={span} />
        ) : id === 'security' ? (
          <SecurityTile key={id} ctx={ctx} span={span} />
        ) : (
          <AppTile key={id} ctx={ctx} span={span} />
        )
      })}
    </>
  )
}

/** Телефон: при поиске плитки с совпадениями выстраиваются списком групп во всю ширину (SPEC §2.3). */
export function ResultGroup({ id, ctx }: { id: SettingsSectionId; ctx: TilesCtx }) {
  const hits = (ctx.rows ?? []).filter((r) => r.sec === id)
  return (
    <section className="ebs-tile ebs-tile--found ebs-rgroup" data-tile={id}>
      <div className="ebs-tile__body" style={{ pointerEvents: 'auto' }}>
        <div className="ebs-tile__head">
          <span className="ebs-sq">
            <Ic n={SECTION_ICONS[id]} />
          </span>
          <span className="ebs-tile__name">{SECTION_NAMES[id]}</span>
          <span className="ebs-count">{hits.length}</span>
        </div>
        <Results id={id} rows={hits} ctx={ctx} />
      </div>
    </section>
  )
}
