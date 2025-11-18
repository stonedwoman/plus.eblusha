import nacl from 'tweetnacl'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { api } from '../../utils/api'
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../../utils/base64'
import { consumePrekeySecret, getIdentityKeyPair, getStoredDeviceInfo } from '../device/deviceManager'

type ConversationRef = {
  id: string
  isSecret?: boolean | null
  secretStatus?: 'ACTIVE' | 'PENDING' | 'CANCELLED' | null
  secretInitiatorDeviceId?: string | null
  secretPeerDeviceId?: string | null
}

type SessionRecord = {
  conversationId: string
  key: string
  localDeviceId: string
  peerDeviceId: string
  role: 'initiator' | 'peer'
  prekeyId: string
  hkdfInfo: string
  handshakeSalt: string
  createdAt: number
}

const STORAGE_KEY = 'eb_e2ee_sessions_v1'

class E2EEManager {
  private sessions: Record<string, SessionRecord> = {}
  private version = 0

  constructor() {
    this.load()
  }

  getVersion(): number {
    return this.version
  }

  hasSession(conversationId: string): boolean {
    return !!this.sessions[conversationId]
  }

  getSession(conversationId: string): SessionRecord | null {
    return this.sessions[conversationId] ?? null
  }

  async ensureSession(conversation: ConversationRef): Promise<SessionRecord | null> {
    if (!conversation.isSecret || conversation.secretStatus !== 'ACTIVE') {
      return null
    }
    const existing = this.sessions[conversation.id]
    if (existing) {
      return existing
    }
    const localInfo = getStoredDeviceInfo()
    const identity = getIdentityKeyPair()
    if (!localInfo || !identity) {
      return null
    }
    if (!conversation.secretInitiatorDeviceId || !conversation.secretPeerDeviceId) {
      return null
    }
    const isInitiator = conversation.secretInitiatorDeviceId === localInfo.deviceId
    if (!isInitiator) {
      return null
    }
    const remoteDeviceId = conversation.secretPeerDeviceId
    if (!remoteDeviceId) {
      return null
    }
    return this.createInitiatorSession(conversation, localInfo.deviceId, remoteDeviceId, identity)
  }

  processHandshakes(conversation: ConversationRef, messages: Array<any> | undefined | null): boolean {
    if (!conversation.isSecret || !messages || messages.length === 0) {
      return false
    }
    const localInfo = getStoredDeviceInfo()
    if (!localInfo) {
      return false
    }
    let changed = false
    for (const msg of messages) {
      const meta = (msg?.metadata ?? {}) as Record<string, any>
      const e2eeMeta = meta.e2ee
      if (!e2eeMeta || e2eeMeta.kind !== 'handshake') {
        continue
      }
      const payload = e2eeMeta.payload as Record<string, any> | undefined
      if (!payload || payload.recipientDeviceId !== localInfo.deviceId) {
        continue
      }
      const current = this.sessions[conversation.id]
      if (current && current.peerDeviceId === payload.initiatorDeviceId && current.prekeyId === payload.prekeyId) {
        continue
      }
      const handled = this.handlePeerHandshake(conversation, payload)
      if (handled) {
        changed = true
      }
    }
    if (changed) {
      this.bumpVersion()
    }
    return changed
  }

  transformMessage(conversationId: string, message: any): any {
    if (!message) return message
    const meta = (message.metadata ?? {}) as Record<string, any>
    const e2eeMeta = meta.e2ee
    if (!e2eeMeta || e2eeMeta.kind !== 'ciphertext') {
      return message
    }
    const session = this.sessions[conversationId]
    if (!session) {
      return {
        ...message,
        content: '🔐 Зашифровано',
        metadata: {
          ...meta,
          e2ee: { ...e2eeMeta, decrypted: false },
        },
      }
    }
    try {
      const key = base64ToBytes(session.key)
      const nonce = base64ToBytes(e2eeMeta.nonce as string)
      const cipherBytes = base64ToBytes(message.content || '')
      const plain = nacl.secretbox.open(cipherBytes, nonce, key)
      if (!plain) {
        throw new Error('Failed to decrypt')
      }
      return {
        ...message,
        content: bytesToUtf8(plain),
        metadata: {
          ...meta,
          e2ee: { ...e2eeMeta, decrypted: true },
        },
      }
    } catch (error) {
      console.warn('Failed to decrypt message', error)
      return {
        ...message,
        content: '🔐 Ошибка расшифровки',
        metadata: {
          ...meta,
          e2ee: { ...e2eeMeta, decrypted: false, error: true },
        },
      }
    }
  }

  async encryptPayload(
    conversation: ConversationRef,
    payload: {
      type: string
      content?: string
      metadata?: Record<string, any>
      replyToId?: string
    },
  ): Promise<{
    conversationId: string
    type: string
    content?: string
    metadata?: Record<string, any>
    replyToId?: string
  }> {
    const session = await this.ensureSession(conversation)
    if (!session) {
      throw new Error('E2EE session is not ready')
    }
    const key = base64ToBytes(session.key)
    const nonce = nacl.randomBytes(24)
    const plaintext = utf8ToBytes(payload.content ?? '')
    const cipher = nacl.secretbox(plaintext, nonce, key)
    return {
      conversationId: conversation.id,
      type: payload.type,
      content: bytesToBase64(cipher),
      replyToId: payload.replyToId,
      metadata: {
        ...(payload.metadata ?? {}),
        e2ee: {
          kind: 'ciphertext',
          version: 1,
          algorithm: 'xsalsa20_poly1305',
          nonce: bytesToBase64(nonce),
        },
      },
    }
  }

  private async createInitiatorSession(
    conversation: ConversationRef,
    localDeviceId: string,
    remoteDeviceId: string,
    identity: { publicKey: string; secretKey: string },
  ): Promise<SessionRecord | null> {
     try {
      const claimResponse = await api.post('/devices/prekeys/claim', { deviceId: remoteDeviceId })
      const remoteIdentityKey = claimResponse.data?.identityKey as string | undefined
      const prekey = claimResponse.data?. prekey
      if (!remoteIdentityKey || !prekey?.publicKey || !prekey?.keyId) {
        throw new Error('Invalid prekey response')
      }
      const sharedSecret = nacl.scalarMult(base64ToBytes(identity.secretKey), base64ToBytes(prekey.publicKey))
      const handshakeSaltBytes = nacl.randomBytes(32)
      const hkdfInfo = `eblusha:e2ee:${conversation.id}:${localDeviceId}->${remoteDeviceId}:${prekey.keyId}`
      const sessionKey = this.deriveKey(sharedSecret, handshakeSaltBytes, hkdfInfo)
      const record: SessionRecord = {
        conversationId: conversation.id,
        key: bytesToBase64(sessionKey),
        localDeviceId,
        peerDeviceId: remoteDeviceId,
        role: 'initiator',
        prekeyId: prekey.keyId,
        hkdfInfo,
        handshakeSalt: bytesToBase64(handshakeSaltBytes),
        createdAt: Date.now(),
      }
      this.sessions[conversation.id] = record
      this.persist()
      await this.sendHandshakeMessage(conversation.id, {
        version: 1,
        kind: 'handshake',
        conversationId: conversation.id,
        initiatorDeviceId: localDeviceId,
        recipientDeviceId: remoteDeviceId,
        prekeyId: prekey.keyId,
        handshakeSalt: record.handshakeSalt,
        hkdfInfo,
        initiatorIdentityKey: identity.publicKey,
        createdAt: Date.now(),
      })
      return record
    } catch (error) {
      console.error('Failed to initialize E2EE session', error)
      delete this.sessions[conversation.id]
      this.persist()
      return null
    }
  }

  private handlePeerHandshake(conversation: ConversationRef, payload: Record<string, any>): boolean {
    if (!payload?.prekeyId || !payload?.initiatorIdentityKey || !payload.hkdfInfo || !payload.handshakeSalt) {
      return false
    }
    const identity = getIdentityKeyPair()
    if (!identity) return false
    const localInfo = getStoredDeviceInfo()
    if (!localInfo) return false
    const prekeySecret = consumePrekeySecret(payload.prekeyId as string)
    if (!prekeySecret) {
      console.warn('Missing prekey secret for handshake', payload.prekeyId)
      return false
    }
    try {
      const sharedSecret = nacl.scalarMult(base64ToBytes(prekeySecret), base64ToBytes(payload.initiatorIdentityKey as string))
      const sessionKey = this.deriveKey(sharedSecret, base64ToBytes(payload.handshakeSalt as string), payload.hkdfInfo as string)
      const record: SessionRecord = {
        conversationId: conversation.id,
        key: bytesToBase64(sessionKey),
        localDeviceId: localInfo.deviceId,
        peerDeviceId: payload.initiatorDeviceId as string,
        role: 'peer',
        prekeyId: payload.prekeyId as string,
        hkdfInfo: payload.hkdfInfo as string,
        handshakeSalt: payload.handshakeSalt as string,
        createdAt: Date.now(),
      }
      this.sessions[conversation.id] = record
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to handle handshake payload', error)
      return false
    }
  }

  private async sendHandshakeMessage(conversationId: string, payload: Record<string, any>) {
    await api.post('/conversations/send', {
      conversationId,
      type: 'SYSTEM',
      content: '',
      metadata: {
        e2ee: {
          kind: 'handshake',
          payload,
        },
      },
    })
  }

  private deriveKey(sharedSecret: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
    return hkdf(sha256, sharedSecret, salt, utf8ToBytes(info), 32)
  }

  clearSession(conversationId: string) {
    if (this.sessions[conversationId]) {
      delete this.sessions[conversationId]
      this.persist()
    }
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        this.sessions = JSON.parse(raw) as Record<string, SessionRecord>
      }
    } catch {
      this.sessions = {}
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.sessions))
    } catch {
      // ignore
    }
    this.bumpVersion()
  }

  private bumpVersion() {
    this.version = (this.version + 1) % Number.MAX_SAFE_INTEGER
  }
}

export const e2eeManager = new E2EEManager()

