/**
 * Раздел «Соединение» (веб): «Сервер» — сведение об адресе, с которого открыт сайт (на вебе его задаёт домен,
 * переключателя нет), и «Звонки» — «Всегда соединяться через ретранслятор» (localStorage eb.lk.webrtc.relayOnly,
 * по умолчанию включено, у каждого браузера своё — как и было).
 */
import { Card, Group, Ic, MsgLine, Row } from '../settingsUi'
import { serverHint } from '../settingsFormat'
import { useSettingsModel } from '../useSettingsModel'

export function ConnectionSection() {
  const m = useSettingsModel()
  const origin = typeof location !== 'undefined' ? location.origin : ''
  return (
    <>
      <Group icon="server" title="Сервер" first>
        <Card>
          <Row id="c-server" title="Сервер" desc={serverHint(m.route)}>
            <span className="ebs-cap ebs-cap--sm ebs-cap--mono">Сейчас: {origin}</span>
          </Row>
        </Card>
      </Group>
      <Group icon="phone" title="Звонки">
        <Card>
          <Row
            id="c-relay"
            title="Всегда соединяться через ретранслятор"
            desc="Обычно путь к серверу выбирается сам: сначала короткий, а ретранслятор — если короткий не сложился."
            desc2="Включите, если в звонках рвётся связь или голос звучит «роботом»: через ретранслятор дольше, но заметно надёжнее."
            toggle={{ checked: m.relay, onChange: m.setRelay }}
            err={m.relayMsg?.kind === 'err'}
          >
            <span className="ebs-cap ebs-cap--sm">
              <Ic n="info" /> Применится со следующего звонка
            </span>
            <MsgLine msg={m.relayMsg} />
          </Row>
        </Card>
      </Group>
    </>
  )
}
