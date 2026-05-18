const KEYS_TO_CLEAR_EXACT = [
  // device identity + OPK secrets
  'eb_device_info_v1',
  'eb_device_secret_v1',
  // secret thread keys + share receipts
  'eb_secret_thread_keys_v1',
  'eb_secret_keyshare_state_v1',
  // secret v2 runtime + inbox poison/attempt tracking
  'eb_secret_v2_runtime_v1',
  'eb_secret_inbox_attempts_v1',
  // link-device helpers
  'eb_device_link_invite_v1',
  'eb_device_link_last_success',
]

export function wipeLocalDeviceData() {
  try {
    for (const k of KEYS_TO_CLEAR_EXACT) localStorage.removeItem(k)
    // best-effort: clear per-thread history dismiss flags
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key.startsWith('eb_secret_history_dismissed:')) localStorage.removeItem(key)
    }
  } catch {}
}

