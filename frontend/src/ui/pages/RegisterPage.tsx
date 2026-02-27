import { type FormEvent, useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { X, UploadCloud, Check } from 'lucide-react'
import { api } from '../../utils/api'
import { useAppStore } from '../../domain/store/appStore'
import { Avatar } from '../components/Avatar'
import { AvatarCropEditor } from '../components/AvatarCropEditor'

const MIN_USERNAME = 3
const MIN_PASSWORD = 8
const MIN_DISPLAY_NAME = 2

export default function RegisterPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((s) => s.setSession)
  const [step, setStep] = useState<1 | 2>(1)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayNameInput, setDisplayNameInput] = useState('')
  const [step1Error, setStep1Error] = useState<string | null>(null)
  const [step2Error, setStep2Error] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null)
  const [avatarEditingUrl, setAvatarEditingUrl] = useState<string | null>(null)
  const heightWrapperRef = useRef<HTMLDivElement>(null)
  const stepContainerRef = useRef<HTMLDivElement>(null)
  const prevStepRef = useRef<1 | 2>(1)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const avatarPreviewUrlRef = useRef<string | null>(null)
  const avatarEditingUrlRef = useRef<string | null>(null)

  const mutation = useMutation({
    mutationFn: async (data: {
      username: string
      displayName: string
      password: string
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
            xhr.open('POST', '/api/upload')
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
      window.location.replace('/')
    },
    onError: (e: any) => {
      const msg = e.response?.data?.message
      if (msg === 'User already exists') setStep2Error('Пользователь с таким логином уже существует')
      else if (msg === 'Invalid data') setStep2Error('Проверьте логин, имя в чате и пароль')
      else setStep2Error(msg ?? 'Ошибка регистрации')
    },
  })

  const step1Valid = username.length >= MIN_USERNAME && password.length >= MIN_PASSWORD

  const handleStep1Submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setStep1Error(null)
    const form = new FormData(e.currentTarget)
    const u = String(form.get('username') ?? '').trim()
    const p = String(form.get('password') ?? '')
    if (u.length < MIN_USERNAME || p.length < MIN_PASSWORD) {
      setStep1Error('Логин не менее 3 символов, пароль не менее 8')
      return
    }
    setUsername(u)
    setPassword(p)
    setStep(2)
  }

  const handleStep2Submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setStep2Error(null)
    const displayName = displayNameInput.trim()
    if (displayName.length < MIN_DISPLAY_NAME) {
      setStep2Error('Ник не менее 2 символов')
      return
    }
    mutation.mutate({ username, password, displayName })
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

  useEffect(() => () => {
    avatarPreviewUrlRef.current && URL.revokeObjectURL(avatarPreviewUrlRef.current)
    avatarEditingUrlRef.current && URL.revokeObjectURL(avatarEditingUrlRef.current)
  }, [])
  avatarPreviewUrlRef.current = avatarPreviewUrl
  avatarEditingUrlRef.current = avatarEditingUrl

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && avatarEditingUrl) handleAvatarCropCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [avatarEditingUrl])

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
    if (!stepContainerRef.current) return
    const isTransition = prevStepRef.current !== step
    prevStepRef.current = step
    if (!isTransition) return
    stepContainerRef.current.style.opacity = '0'
    stepContainerRef.current.style.transform = step === 1 ? 'translateX(4px)' : 'translateX(-4px)'
    const t = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!stepContainerRef.current) return
        stepContainerRef.current.style.transition = 'opacity 0.2s ease, transform 0.2s ease'
        stepContainerRef.current.style.opacity = '1'
        stepContainerRef.current.style.transform = 'translateX(0)'
      })
    })
    return () => cancelAnimationFrame(t)
  }, [step])

  return (
    <div className="auth-form-wrapper">
      <div
        ref={heightWrapperRef}
        className="auth-register-step-height"
        style={{ overflow: 'hidden' }}
      >
        <div ref={stepContainerRef}>
        {step === 1 ? (
          <form className="auth-form" onSubmit={handleStep1Submit}>
            <label style={labelBlockStyle}>
              Имя для входа
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
                    name={(displayNameInput.trim() || username) || '?'}
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
              Ник
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
            document.body
          )}
        </div>
      </div>
    </div>
  )
}
