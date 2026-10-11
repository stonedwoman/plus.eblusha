/**
 * Раздел «Приложение» (веб): «Встроенный проигрыватель YouTube» — тумблер над ключом localStorage
 * youtubeOpenMode (вкл = embed, выкл = external). Раньше ключ был скрытым, переключателя не было.
 */
import { Card, Group, MsgLine, Row } from '../settingsUi'
import { useSettingsModel } from '../useSettingsModel'

export function AppSection() {
  const m = useSettingsModel()
  return (
    <Group first>
      <Card>
        <Row
          id="ap-yt"
          title="Встроенный проигрыватель YouTube"
          desc="Ролик играет прямо в карточке ссылки. Выключите — ролики будут открываться в новой вкладке."
          toggle={{ checked: m.yt, onChange: m.setYt }}
          err={!!m.ytErr}
        >
          {m.ytErr ? <MsgLine msg={{ kind: 'err', text: m.ytErr }} /> : null}
        </Row>
      </Card>
    </Group>
  )
}
