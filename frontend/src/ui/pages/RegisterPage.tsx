import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { X, UploadCloud, Check } from 'lucide-react'
import { api, getUploadUrl } from '../../utils/api'
import { useAppStore } from '../../domain/store/appStore'
import { Avatar } from '../components/Avatar'
import { AvatarCropEditor } from '../components/AvatarCropEditor'

const MIN_USERNAME = 3
const MIN_PASSWORD = 6
const MIN_DISPLAY_NAME = 2
const REGISTRATION_INVITE_CODE_DIGITS = 8
const EMPTY_INVITE_DIGITS = Array.from({ length: REGISTRATION_INVITE_CODE_DIGITS }, () => '')

type RegistrationStep = 0 | 1 | 2

type InviterPreview = {
  id: string
  username: string
  displayName: string | null
  avatarUrl?: string | null
}

function normalizeInviteCode(value: string) {
  return value.replace(/\D/g, '').slice(0, REGISTRATION_INVITE_CODE_DIGITS)
}

export default function RegisterPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((s) => s.setSession)
  const [step, setStep] = useState<RegistrationStep>(0)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayNameInput, setDisplayNameInput] = useState('')
  const [inviteDigits, setInviteDigits] = useState<string[]>(() => [...EMPTY_INVITE_DIGITS])
  const [registrationInviteToken, setRegistrationInviteToken] = useState<string | null>(null)
  const [verifiedInviter, setVerifiedInviter] = useState<InviterPreview | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [step1Error, setStep1Error] = useState<string | null>(null)
  const [step2Error, setStep2Error] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null)
  const [avatarEditingUrl, setAvatarEditingUrl] = useState<string | null>(null)
  const heightWrapperRef = useRef<HTMLDivElement>(null)
  const stepContainerRef = useRef<HTMLDivElement>(null)
  const prevStepRef = useRef<RegistrationStep>(0)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const avatarPreviewUrlRef = useRef<string | null>(null)
  const avatarEditingUrlRef = useRef<string | null>(null)
  const inviteDigitRefs = useRef<Array<HTMLInputElement | null>>([])

  const verifyInviteMutation = useMutation({
    mutationFn: async (code: string) => {
      const response = await api.post('/auth/register/code/verify', { code })
      return response.data as { registrationInviteToken: string; inviter: InviterPreview }
    },
    onSuccess: (data) => {
      setInviteError(null)
      setRegistrationInviteToken(data.registrationInviteToken)
      setVerifiedInviter(data.inviter)
      setStep(1)
    },
    onError: (e: any) => {
      const msg = e.response?.data?.message
      if (msg === 'Invite code is invalid or expired') setInviteError('Код недействителен или уже истек')
      else if (msg === 'Invalid invite code') setInviteError(`Введите ${REGISTRATION_INVITE_CODE_DIGITS} цифр`)
      else setInviteError(msg ?? 'Не удалось проверить код')
    },
  })

  const mutation = useMutation({
    mutationFn: async (data: {
      username: string
      displayName: string
      password: string
      registrationInviteToken: string
    }) => {
      const response = await api.post('/auth/register', data)
      return response.data
    },
    onSuccess: async (data: { user: any; accessToken: string; refreshToken?: string }) => {
      setSession({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken ?? null })
      if (avatarFile) {
        try {
          const form = new FormData()
          form.append('file', avatarFile)
          const url = await new Promise<string>((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', getUploadUrl())
            const token = useAppStore.getState().session?.accessToken
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
            xhr.onreadystatechange = () => {
              if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                  try {
                    resolve(JSON.parse(xhr.responseText).url)
                  } catch {
                    reject(new Error('upload failed'))
                  }
                } else reject(new Error('upload failed'))
              }
            }
            xhr.send(form)
          })
          await api.patch('/status/me', { avatarUrl: url })
        } catch {
          // ignore
        }
      }
      navigate('/chats', { replace: true })
    },
    onError: (e: any) => {
      const msg = e.response?.data?.message
      if (msg === 'User already exists') {
        // Занят именно ЛОГИН с шага 1 — возвращаем туда, иначе кажется, что занято имя
        setStep2Error(null)
        setStep1Error('Этот логин уже занят — придумайте другой')
        setStep(1)
        return
      }
      if (msg === 'Invalid data') {
        setStep2Error('Проверьте логин, имя и пароль')
        return
      }
      if (msg === 'Registration requires invite code' || msg === 'Invalid or expired registration invite') {
        setRegistrationInviteToken(null)
        setVerifiedInviter(null)
        setInviteError('Код приглашения устарел. Введите новый')
        setStep(0)
        return
      }
      setStep2Error(msg ?? 'Ошибка регистрации')
    },
  })

  const step1Valid = username.length >= MIN_USERNAME && password.length >= MIN_PASSWORD
  const inviteCode = useMemo(() => inviteDigits.join(''), [inviteDigits])
  const inviteCodeValid = inviteDigits.every((digit) => /^\d$/.test(digit))

  const focusInviteDigit = (idx: number) => {
    const el = inviteDigitRefs.current[idx]
    if (!el) return
    try {
      el.focus()
      el.select?.()
    } catch {}
  }

  const submitInviteCode = (code: string) => {
    const normalized = normalizeInviteCode(code)
    if (verifyInviteMutation.isPending || normalized.length !== REGISTRATION_INVITE_CODE_DIGITS) return
    setInviteError(null)
    verifyInviteMutation.mutate(normalized)
  }

  const applyInviteDigits = (startIdx: number, raw: string) => {
    const only = normalizeInviteCode(raw)
    if (!only) return
    const next = [...inviteDigits]
    for (let k = 0; k < only.length && startIdx + k < REGISTRATION_INVITE_CODE_DIGITS; k += 1) {
      next[startIdx + k] = only[k] ?? ''
    }
    setInviteDigits(next)
    if (inviteError) setInviteError(null)
    const lastFilled = Math.min(REGISTRATION_INVITE_CODE_DIGITS - 1, startIdx + only.length - 1)
    if (lastFilled < REGISTRATION_INVITE_CODE_DIGITS - 1) {
      focusInviteDigit(lastFilled + 1)
    }
    const nextCode = next.join('')
    const complete = next.every((digit) => /^\d$/.test(digit))
    if (complete) {
      submitInviteCode(nextCode)
    }
  }

  const resetInvite = () => {
    setInviteError(null)
    setStep1Error(null)
    setStep2Error(null)
    setInviteDigits([...EMPTY_INVITE_DIGITS])
    setRegistrationInviteToken(null)
    setVerifiedInviter(null)
    setStep(0)
  }

  const handleInviteSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setInviteError(null)
    const normalized = normalizeInviteCode(inviteCode)
    if (normalized.length !== REGISTRATION_INVITE_CODE_DIGITS) {
      setInviteError(`Введите ${REGISTRATION_INVITE_CODE_DIGITS} цифр`)
      return
    }
    submitInviteCode(normalized)
  }

  const handleStep1Submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setStep1Error(null)
    const form = new FormData(e.currentTarget)
    const u = String(form.get('username') ?? '').trim()
    const p = String(form.get('password') ?? '')
    if (u.length < MIN_USERNAME || p.length < MIN_PASSWORD) {
      setStep1Error(`Логин не менее ${MIN_USERNAME} символов, пароль не менее ${MIN_PASSWORD}`)
      return
    }
    // Сразу проверяем доступность логина — иначе «занято» всплывало на шаге имени
    // и люди меняли имя вместо логина. Ошибка сети не блокирует шаг —
    // финальная регистрация всё равно проверит.
    try {
      const { data } = await api.post('/auth/register/check', { username: u })
      if (data?.available === false) {
        setStep1Error('Этот логин уже занят — придумайте другой')
        return
      }
    } catch {
      // ignore — проверка необязательна
    }
    setUsername(u)
    setPassword(p)
    setStep(2)
  }

  const handleStep2Submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setStep2Error(null)
    const displayName = displayNameInput.trim()
    if (!registrationInviteToken) {
      setInviteError('Сначала подтвердите код приглашения')
      setStep(0)
      return
    }
    if (displayName.length < MIN_DISPLAY_NAME) {
      setStep2Error('Имя не менее 2 символов')
      return
    }
    mutation.mutate({ username, password, displayName, registrationInviteToken })
  }

  const goBack = () => {
    setStep2Error(null)
    setStep(1)
  }

  const handleAvatarClick = () => avatarInputRef.current?.click()
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (avatarEditingUrl) URL.revokeObjectURL(avatarEditingUrl)
    setAvatarEditingUrl(URL.createObjectURL(file))
  }

  const handleAvatarCropConfirm = (blob: Blob) => {
    const file = new File([blob], 'avatar.jpg', { type: blob.type })
    setAvatarFile(file)
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
    setAvatarPreviewUrl(URL.createObjectURL(blob))
    if (avatarEditingUrl) URL.revokeObjectURL(avatarEditingUrl)
    setAvatarEditingUrl(null)
  }

  const handleAvatarCropCancel = () => {
    if (avatarEditingUrl) URL.revokeObjectURL(avatarEditingUrl)
    setAvatarEditingUrl(null)
  }

  useEffect(
    () => () => {
      avatarPreviewUrlRef.current && URL.revokeObjectURL(avatarPreviewUrlRef.current)
      avatarEditingUrlRef.current && URL.revokeObjectURL(avatarEditingUrlRef.current)
    },
    [],
  )
  avatarPreviewUrlRef.current = avatarPreviewUrl
  avatarEditingUrlRef.current = avatarEditingUrl

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && avatarEditingUrl) handleAvatarCropCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [avatarEditingUrl])

  useEffect(() => {
    if (step !== 0) return
    const id = window.setTimeout(() => focusInviteDigit(0), 60)
    return () => window.clearTimeout(id)
  }, [step])

  const labelBlockStyle = { display: 'flex' as const, flexDirection: 'column' as const, gap: 8 }

  useLayoutEffect(() => {
    const wrap = heightWrapperRef.current
    const content = stepContainerRef.current
    if (!wrap || !content) return
    const syncHeight = () => {
      wrap.style.height = `${content.scrollHeight}px`
    }
    syncHeight()
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(syncHeight)
    })
    const ro = new ResizeObserver(() => {
      syncHeight()
    })
    ro.observe(content)
    return () => {
      cancelAnimationFrame(id)
      ro.disconnect()
    }
  }, [step])

  useEffect(() => {
    const container = stepContainerRef.current
    if (!container) return
    const prevStep = prevStepRef.current
    const isTransition = prevStep !== step
    prevStepRef.current = step
    if (!isTransition) return
    container.style.opacity = '0'
    container.style.transform = step < prevStep ? 'translateX(4px)' : 'translateX(-4px)'
    const t = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const current = stepContainerRef.current
        if (!current) return
        current.style.transition = 'opacity 0.2s ease, transform 0.2s ease'
        current.style.opacity = '1'
        current.style.transform = 'translateX(0)'
      })
    })
    return () => cancelAnimationFrame(t)
  }, [step])

  const inviterLabel = verifiedInviter?.displayName ?? verifiedInviter?.username ?? 'Пользователь'
  const inviteVerifiedCard =
    verifiedInviter && registrationInviteToken ? (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: 12,
          borderRadius: 14,
          border: '1px solid var(--tab-border)',
          background: 'rgba(255,255,255,0.04)',
          marginBottom: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: '50%',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <Avatar
              name={inviterLabel}
              id={verifiedInviter.id}
              size={42}
              avatarUrl={verifiedInviter.avatarUrl ?? undefined}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <strong style={{ fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Вас пригласил {inviterLabel}
            </strong>
            <span style={{ fontSize: 12, color: 'var(--tab-text-muted)' }}>
              После регистрации вы сразу будете в друзьях
            </span>
          </div>
        </div>
        <button type="button" className="btn btn-secondary" onClick={resetInvite}>
          Сменить код
        </button>
      </div>
    ) : null

  return (
    <div className="auth-form-wrapper">
      <div
        ref={heightWrapperRef}
        className="auth-register-step-height"
        style={{ overflow: 'hidden' }}
      >
        <div ref={stepContainerRef}>
          {step === 0 ? (
            <form className="auth-form" onSubmit={handleInviteSubmit}>
              <label style={labelBlockStyle}>
                Код приглашения
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    flexWrap: 'nowrap',
                    width: '100%',
                    overflow: 'hidden',
                  }}
                >
                  {inviteDigits.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => {
                        inviteDigitRefs.current[idx] = el
                      }}
                      value={digit}
                      onChange={(e) => {
                        const raw = String(e.target.value ?? '')
                        const only = normalizeInviteCode(raw)
                        if (!only) {
                          setInviteDigits((prev) => {
                            const next = [...prev]
                            next[idx] = ''
                            return next
                          })
                          if (inviteError) setInviteError(null)
                          return
                        }
                        applyInviteDigits(idx, only)
                      }}
                      onFocus={(e) => {
                        try {
                          e.currentTarget.select()
                        } catch {}
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Backspace' && !inviteDigits[idx] && idx > 0) {
                          e.preventDefault()
                          setInviteDigits((prev) => {
                            const next = [...prev]
                            next[idx - 1] = ''
                            return next
                          })
                          if (inviteError) setInviteError(null)
                          focusInviteDigit(idx - 1)
                        }
                        if (e.key === 'ArrowLeft' && idx > 0) {
                          e.preventDefault()
                          focusInviteDigit(idx - 1)
                        }
                        if (e.key === 'ArrowRight' && idx < REGISTRATION_INVITE_CODE_DIGITS - 1) {
                          e.preventDefault()
                          focusInviteDigit(idx + 1)
                        }
                      }}
                      onPaste={(e) => {
                        const txt = e.clipboardData?.getData('text') ?? ''
                        if (!txt) return
                        e.preventDefault()
                        applyInviteDigits(idx, txt)
                      }}
                      type="tel"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete={idx === 0 ? 'one-time-code' : 'off'}
                      aria-label={`Цифра кода ${idx + 1}`}
                      disabled={verifyInviteMutation.isPending}
                      style={{
                        flex: '1 1 0',
                        minWidth: 0,
                        maxWidth: 38,
                        height: 50,
                        width: 38,
                        padding: 0,
                        boxSizing: 'border-box',
                        borderRadius: 12,
                        border: '1px solid var(--tab-border)',
                        background: 'var(--tab-surface)',
                        color: 'var(--tab-text)',
                        caretColor: 'var(--tab-accent)',
                        outline: 'none',
                        fontSize: 22,
                        fontWeight: 800,
                        lineHeight: '50px',
                        textAlign: 'center',
                        textIndent: 0,
                        fontVariantNumeric: 'tabular-nums',
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      }}
                    />
                  ))}
                </div>
                <span className="auth-field-hint">
                  Код показывает зарегистрированный пользователь во вкладке «Контакты». Он обновляется каждую минуту.
                </span>
              </label>
              {inviteError ? <div className="auth-error">{inviteError}</div> : null}
              {verifyInviteMutation.isPending ? (
                <div
                  style={{
                    width: '100%',
                    textAlign: 'center',
                    fontSize: 14,
                    fontWeight: 700,
                    color: 'var(--tab-accent)',
                    paddingTop: 4,
                  }}
                >
                  Проверяем код…
                </div>
              ) : !inviteCodeValid ? (
                <div
                  style={{
                    width: '100%',
                    textAlign: 'center',
                    fontSize: 13,
                    color: 'var(--tab-text-muted)',
                    paddingTop: 4,
                  }}
                >
                  Введите все 8 цифр
                </div>
              ) : null}
            </form>
          ) : step === 1 ? (
            <form className="auth-form" onSubmit={handleStep1Submit}>
              {inviteVerifiedCard}
              <label style={labelBlockStyle}>
                Логин (имя для входа)
                <input
                  name="username"
                  type="text"
                  required
                  minLength={MIN_USERNAME}
                  placeholder="Введите логин"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                {username.length > 0 && (
                  <span className={`auth-field-hint ${username.length >= MIN_USERNAME ? 'auth-field-hint--valid' : ''}`}>
                    {username.length >= MIN_USERNAME ? <Check size={12} aria-hidden /> : null}
                    Не менее {MIN_USERNAME} символов
                  </span>
                )}
              </label>
              <label style={labelBlockStyle}>
                Пароль
                <input
                  name="password"
                  type="password"
                  required
                  minLength={MIN_PASSWORD}
                  placeholder="Пароль для входа"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {password.length > 0 && (
                  <span className={`auth-field-hint ${password.length >= MIN_PASSWORD ? 'auth-field-hint--valid' : ''}`}>
                    {password.length >= MIN_PASSWORD ? <Check size={12} aria-hidden /> : null}
                    Не менее {MIN_PASSWORD} символов
                  </span>
                )}
              </label>
              {step1Error ? <div className="auth-error">{step1Error}</div> : null}
              <button type="submit" disabled={!step1Valid}>
                Далее
              </button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={handleStep2Submit}>
              {inviteVerifiedCard}
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarChange}
                style={{ display: 'none' }}
              />
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--tab-text-muted)', marginBottom: 8, textAlign: 'center' }}>Аватар</div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div
                    onClick={handleAvatarClick}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && handleAvatarClick()}
                    aria-label="Загрузить аватар"
                    title="Загрузить аватар"
                    style={{ position: 'relative', cursor: 'pointer', flexShrink: 0 }}
                    className="register-avatar-pick"
                  >
                    <Avatar
                      name={displayNameInput.trim() || username || '?'}
                      id="register-preview"
                      size={88}
                      avatarUrl={avatarPreviewUrl ?? undefined}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: '50%',
                        background: 'rgba(0,0,0,0.45)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: 0,
                        transition: 'opacity 0.2s ease',
                        pointerEvents: 'none',
                      }}
                      className="register-avatar-hover"
                      aria-hidden
                    >
                      <UploadCloud size={28} color="#fff" strokeWidth={2} />
                    </div>
                  </div>
                </div>
              </div>
              <label style={labelBlockStyle}>
                Имя
                <input
                  name="displayName"
                  type="text"
                  required
                  minLength={MIN_DISPLAY_NAME}
                  placeholder="Что будут видеть другие"
                  autoComplete="name"
                  value={displayNameInput}
                  onChange={(e) => setDisplayNameInput(e.target.value)}
                />
                {displayNameInput.trim().length > 0 && (
                  <span className={`auth-field-hint ${displayNameInput.trim().length >= MIN_DISPLAY_NAME ? 'auth-field-hint--valid' : ''}`}>
                    {displayNameInput.trim().length >= MIN_DISPLAY_NAME ? <Check size={12} aria-hidden /> : null}
                    Не менее {MIN_DISPLAY_NAME} символов
                  </span>
                )}
              </label>
              {step2Error ? <div className="auth-error">{step2Error}</div> : null}
              <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={goBack}>
                  Назад
                </button>
                <button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Создаем…' : 'Создать аккаунт'}
                </button>
              </div>
            </form>
          )}
          {avatarEditingUrl &&
            createPortal(
              <div
                className="eb-no-drag"
                role="dialog"
                aria-modal="true"
                aria-labelledby="avatar-crop-title"
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1300,
                  background: 'rgba(0,0,0,0.7)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  boxSizing: 'border-box',
                }}
                onClick={(e) => e.target === e.currentTarget && handleAvatarCropCancel()}
              >
                <div
                  style={{
                    background: 'var(--tab-bg, var(--surface-200))',
                    borderRadius: 16,
                    maxWidth: 420,
                    width: '100%',
                    maxHeight: '90vh',
                    overflow: 'auto',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
                    position: 'relative',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    aria-label="Закрыть"
                    onClick={handleAvatarCropCancel}
                    style={{
                      position: 'absolute',
                      top: 12,
                      right: 12,
                      background: 'var(--tab-surface)',
                      border: '1px solid var(--tab-border)',
                      borderRadius: 10,
                      width: 36,
                      height: 36,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: 'var(--tab-text-muted)',
                      zIndex: 1,
                    }}
                  >
                    <X size={20} />
                  </button>
                  <div style={{ padding: '16px 16px 20px' }}>
                    <AvatarCropEditor
                      imageUrl={avatarEditingUrl}
                      onConfirm={handleAvatarCropConfirm}
                      onCancel={handleAvatarCropCancel}
                      isMobile={typeof window !== 'undefined' && window.innerWidth < 768}
                    />
                  </div>
                </div>
              </div>,
              document.body,
            )}
        </div>
      </div>
    </div>
  )
}
