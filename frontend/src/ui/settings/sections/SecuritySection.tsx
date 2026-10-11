/**
 * Раздел «Безопасность» (веб): «Пароль» (форма раскрывается на месте строки), «Секретные чаты в этом браузере»
 * («Подтвердить по коду» — прежняя привязка нового устройства, LinkDeviceModal mode="trusted", раньше она лежала
 * только на мёртвой /settings) и «Активные сеансы» (вопросы на месте вместо окон-подтверждений).
 *
 * Логика прежняя: смена пароля — POST /auth/change-password, сеансы — GET /devices, DELETE /devices/{id},
 * POST /devices/revoke-others. Новое: «Отключить все другие» неактивна, пока своего устройства нет в списке —
 * без него revoke-others отзывает ВСЕ устройства, включая этот браузер.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../../../utils/api'
import { LinkDeviceModal } from '../../components/LinkDeviceModal'
import { lastSeenLabel, type SessionRow } from '../settingsFormat'
import { Btn, Card, Confirm, Ebox, Group, Ic, Msg, MsgLine, Row, useSettingsUi, type IconName } from '../settingsUi'
import { useSettingsModel } from '../useSettingsModel'

// ───────────────────────────── пароль ─────────────────────────────

function PasswordForm() {
  const m = useSettingsModel()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [revokeOthers, setRevokeOthers] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const first = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    first.current?.focus({ preventScroll: false })
  }, [])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (m.pwdBusy) return
    setMismatch(false)
    if (!current || !next || !repeat) return setError('Заполните все три поля.')
    if (next.length < 6) return setError('Новый пароль должен быть не короче 6 символов.')
    if (next !== repeat) {
      setMismatch(true)
      return setError('Пароли не совпадают.')
    }
    setError(null)
    m.setPwdBusy(true)
    try {
      const resp = await api.post('/auth/change-password', { currentPassword: current, newPassword: next, revokeOtherSessions: revokeOthers })
      const revoked = Number(resp?.data?.revokedSessions ?? 0)
      m.setPwdMsg({ kind: 'ok', text: revoked > 0 ? 'Пароль изменён, остальные сеансы завершены.' : 'Пароль изменён.' })
      m.setPwdOpen(false)
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status
      if (status === 403) setError('Неверный текущий пароль.')
      else if (status === 429) setError('Слишком много попыток. Повторите через минуту.')
      else setError('Не удалось изменить пароль. Попробуйте ещё раз.')
    } finally {
      m.setPwdBusy(false)
    }
  }

  return (
    <form className="ebs-pwd" onSubmit={(e) => void submit(e)} aria-label="Изменить пароль">
      <h4>
        <Ic n="key" /> Изменить пароль
      </h4>
      {/* Скрытый логин — подсказка менеджеру паролей, к какой учётке относится смена. */}
      <input type="text" name="username" autoComplete="username" value={m.me?.username ?? ''} readOnly style={{ display: 'none' }} />
      <label className="ebs-lbl">
        Текущий пароль
        <input ref={first} className="ebs-field" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="ebs-lbl">
        Новый пароль (минимум 6 символов)
        <input className="ebs-field" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="ebs-lbl">
        Новый пароль ещё раз
        <input className="ebs-field" type="password" autoComplete="new-password" value={repeat} aria-invalid={mismatch || undefined} onChange={(e) => setRepeat(e.target.value)} />
      </label>
      <label className="ebs-chk">
        <input type="checkbox" checked={revokeOthers} onChange={(e) => setRevokeOthers(e.target.checked)} />
        <span className="ebs-chk__box">
          <Ic n="check" />
        </span>
        <span>
          <b>Завершить остальные сеансы</b>
          <small>Отметьте, если пароль мог попасть в чужие руки.</small>
        </span>
      </label>
      {error ? <Msg kind="err">{error}</Msg> : null}
      <div className="ebs-pwd__btns">
        <Btn kind="ghost" onClick={() => m.setPwdOpen(false)} disabled={m.pwdBusy}>
          Отмена
        </Btn>
        <Btn kind="pri" icon="key" type="submit" disabled={m.pwdBusy}>
          {m.pwdBusy ? 'Меняем…' : 'Изменить пароль'}
        </Btn>
      </div>
    </form>
  )
}

// ───────────────────────────── сеансы ─────────────────────────────

const KIND_ICON: Record<SessionRow['kind'], IconName> = { phone: 'smartphone', tablet: 'tablet', desktop: 'monitor', browser: 'browser' }

function SessionLine({ r }: { r: SessionRow }) {
  const m = useSettingsModel()
  const { mode } = useSettingsUi()
  const s = m.sessions
  const id = String(r.device.id)
  const asking = s.askId === id
  const phone = mode === 'phone'
  const seen = r.isCurrent ? 'сейчас в сети' : lastSeenLabel(r.device.lastSeenAt as string | Date | null | undefined)
  return (
    <div className={`ebs-sess${asking ? ' ebs-sess--ask' : ''}`} data-ebs-id="s-sess">
      <div className="ebs-sess__ic">
        <Ic n={KIND_ICON[r.kind]} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="ebs-sess__n">
          {r.name}
          {r.count > 1 ? (
            <span className="ebs-cap ebs-cap--xs" title={`Ещё ${r.count - 1} ${r.count - 1 === 1 ? 'вход' : 'входа'} с такого же устройства`}>
              +{r.count - 1}
            </span>
          ) : null}
          {r.isCurrent ? <span className="ebs-chip-ok">Это устройство</span> : null}
        </div>
        {r.meta ? <div className="ebs-sess__m">{r.meta}</div> : null}
        <div className="ebs-sess__k">
          {r.keysReady ? (
            <>
              <Ic n="check" /> Ключи готовы
            </>
          ) : (
            <span className="ebs-warn">
              <Ic n="info" /> Ключи не готовы
            </span>
          )}
          {seen ? (
            <span className="ebs-seen">
              {phone ? '' : '· '}
              {seen}
            </span>
          ) : null}
        </div>
      </div>
      {phone ? (
        r.isCurrent ? (
          <span />
        ) : (
          <Btn sm className="ebs-btn--icon" aria-label={`Отключить «${r.name}»`} onClick={() => s.setAskId(id)} disabled={s.busy}>
            <Ic n="x" />
          </Btn>
        )
      ) : (
        <Btn sm aria-label={`Отключить «${r.name}»`} disabled={r.isCurrent || s.busy} title={r.isCurrent ? 'Нельзя отключить текущее устройство' : undefined} onClick={() => s.setAskId(id)}>
          Отключить
        </Btn>
      )}
      {asking ? (
        <div className="ebs-ask">
          <span>
            <b>Отключить устройство?</b> Оно перестанет получать секретные сообщения и ключи.
          </span>
          <span className="ebs-ask__btns">
            <AskCancel onCancel={() => s.setAskId(null)} />
            <Btn sm kind="danger" icon="x" onClick={() => void s.revokeOne(id)} disabled={s.busy}>
              Отключить
            </Btn>
          </span>
        </div>
      ) : null}
    </div>
  )
}

function AskCancel({ onCancel }: { onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    <button ref={ref} type="button" className="ebs-btn ebs-btn--sm" onClick={onCancel}>
      Отмена
    </button>
  )
}

export function SecuritySection() {
  const m = useSettingsModel()
  const { mode } = useSettingsUi()
  const s = m.sessions
  const phone = mode === 'phone'
  const ownRow = s.rows.find((r) => r.isCurrent)
  const allHint = !s.own ? 'Сначала это устройство должно появиться в списке' : !s.canAll ? 'Других устройств нет' : 'Отключить все другие устройства'

  return (
    <>
      <Group first>
        <Card>
          <Row
            id="s-pass"
            title="Пароль"
            desc="Этот пароль используется для входа в аккаунт."
            wide
            ctl={
              <Btn icon="key" sm={phone} onClick={() => { m.setPwdMsg(null); m.setPwdOpen(true) }} disabled={m.pwdOpen} aria-expanded={m.pwdOpen}>
                Изменить пароль
              </Btn>
            }
          >
            {m.pwdMsg && !m.pwdOpen ? <MsgLine msg={m.pwdMsg} /> : null}
          </Row>
          {m.pwdOpen ? <PasswordForm /> : null}
        </Card>
      </Group>

      <Group
        icon="lock"
        title="Секретные чаты в этом браузере"
        caption="Ключи секретных чатов хранятся только на устройствах. Новое своё устройство подключают кодом с уже подключённого."
      >
        <Card>
          <Row
            id="s-link"
            title="Подтвердить по коду"
            desc="Новое устройство показывает код — подтвердите его здесь, и оно получит ключи секретных чатов."
            wide
            ctl={
              <Btn sm icon="scan" onClick={() => m.setLinkOpen(true)}>
                Подтвердить по коду
              </Btn>
            }
          >
            {ownRow ? (
              ownRow.keysReady ? (
                <Msg kind="ok">Этот браузер зарегистрирован, ключи готовы.</Msg>
              ) : (
                <Msg kind="note">Этот браузер зарегистрирован, ключи ещё не готовы.</Msg>
              )
            ) : null}
          </Row>
        </Card>
      </Group>

      <Group
        icon="smartphone"
        title="Активные сеансы"
        caption="Телефоны, браузеры и приложения, где открыт ваш аккаунт."
        extra={
          <>
            {!s.loading && !s.failed ? <small className="ebs-num">{s.total}</small> : null}
            <Btn sm kind="dtext" icon="x" disabled={!s.canAll || s.busy} title={allHint} onClick={() => s.setAskAll(true)}>
              {phone ? 'Все другие' : 'Отключить все другие'}
            </Btn>
          </>
        }
      >
        {s.askAll ? (
          <div style={{ marginBottom: 10 }}>
            <Confirm
              title="Отключить все другие устройства?"
              text="Они будут разлогинены и перестанут получать секретные сообщения."
              okLabel="Отключить"
              busy={s.busy}
              onCancel={() => s.setAskAll(false)}
              onOk={() => void s.revokeOthers()}
            />
          </div>
        ) : null}
        {s.failed ? (
          <Ebox onRetry={s.refetch}>Не удалось загрузить список устройств.</Ebox>
        ) : s.loading ? (
          <Card>
            <div className="ebs-empty" role="status" aria-live="polite">
              <span className="ebs-spin" style={{ width: 22, height: 22 }} aria-hidden="true" />
              <div className="ebs-empty__t">Загружаем устройства…</div>
            </div>
          </Card>
        ) : s.rows.length === 0 ? (
          <Card>
            <div className="ebs-empty">
              <Ic n="shield" />
              <div className="ebs-empty__t">Нет устройств</div>
              <div className="ebs-empty__d">Других входов в ваш аккаунт сейчас нет.</div>
            </div>
          </Card>
        ) : (
          <Card>
            {s.rows.map((r) => (
              <SessionLine key={String(r.device.id)} r={r} />
            ))}
          </Card>
        )}
        {s.msg ? (
          <div style={{ marginTop: 10 }}>
            <MsgLine msg={s.msg} />
          </div>
        ) : null}
        {!s.loading && !s.failed && s.rows.length > 0 && !s.own ? (
          <div style={{ marginTop: 12 }}>
            <div className="ebs-dash">
              <Ic n="info" />
              <span>Этот браузер здесь пока не значится: его устройство для секретных чатов не зарегистрировано.</span>
            </div>
          </div>
        ) : null}
      </Group>

      <LinkDeviceModal open={m.linkOpen} onClose={() => m.setLinkOpen(false)} mode="trusted" />
    </>
  )
}
