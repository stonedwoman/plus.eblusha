import { type FormEvent, useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { useAppStore } from '../../domain/store/appStore'
import { Avatar } from '../components/Avatar'
import { AvatarCropEditor } from '../components/AvatarCropEditor'
import { UploadCloud, X } from 'lucide-react'

const MIN_USERNAME = 3
const MIN_PASSWORD = 8
const MIN_DISPLAY_NAME = 2

export default function RegisterPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((s) => s.setSession)
  const [step, setStep] = useState<1 | 2>(1)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [step1Error, setStep1Error] = useState<string | null>(null)
  const [step2Error, setStep2Error] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null)
  const [avatarEditingUrl, setAvatarEditingUrl] = useState<string | null>(null)
  const [displayNameInput, setDisplayNameInput] = useState('')
  const avatarPreviewUrlRef = useRef<string | null>(null)
  avatarPreviewUrlRef.current = avatarPreviewUrl
  const avatarEditingUrlRef = useRef<string | null>(null)
  avatarEditingUrlRef.current = avatarEditingUrl
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const heightWrapperRef = useRef<HTMLDivElement>(null)
  const stepContainerRef = useRef<HTMLDivElement>(null)
  const prevStepRef = useRef<1 | 2>(1)

  const mutation = useMutation({
    mutationFn: async (data: {
      username: string
      displayName: string
      password: string
      avatarFile?: File
    }) => {
      const { avatarFile: _af, ...payload } = data
      const response = await api.post('/auth/register', payload)
      return response.data
    },
    onSuccess: async (data: any, variables) => {
      setSession({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? undefined,
      })
      if (variables.avatarFile) {
        try {
          const form = new FormData()
          form.append('file', variables.avatarFile)
          const { data: uploadData } = await api.post<{ url: string }>('/upload', form, {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
          if (uploadData?.url) {
            await api.patch('/status/me', { avatarUrl: uploadData.url })
          }
        } catch {
          // ignore avatar upload failure
        }
      }
      setTimeout(() => window.location.replace('/'), 0)
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
      setStep2Error('Имя не менее 2 символов')
      return
    }
    mutation.mutate({ username, password, displayName, avatarFile: avatarFile ?? undefined })
  }

  const handleAvatarClick = () => avatarInputRef.current?.click()
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = URL.createObjectURL(file)
      setAvatarEditingUrl(url)
    } catch {
      setAvatarEditingUrl(null)
    }
    e.target.value = ''
  }
  const handleAvatarCropConfirm = (blob: Blob) => {
    const file = new File([blob], 'avatar.png', { type: 'image/png' })
    if (avatarEditingUrl) URL.revokeObjectURL(avatarEditingUrl)
    setAvatarEditingUrl(null)
    setAvatarFile(file)
    try {
      setAvatarPreviewUrl(URL.createObjectURL(file))
    } catch {
      setAvatarPreviewUrl(null)
    }
  }
  const handleAvatarCropCancel = () => {
    if (avatarEditingUrl) URL.revokeObjectURL(avatarEditingUrl)
    setAvatarEditingUrl(null)
  }
  const handleAvatarClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setAvatarFile(null)
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
    setAvatarPreviewUrl(null)
  }

  const goBack = () => {
    setStep2Error(null)
    setStep(1)
  }

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
    return () => cancelAnimationFrame(id)
  }, [step])

  useEffect(() => {
    return () => {
      if (avatarPreviewUrlRef.current) URL.revokeObjectURL(avatarPreviewUrlRef.current)
      if (avatarEditingUrlRef.current) URL.revokeObjectURL(avatarEditingUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (!avatarEditingUrl) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleAvatarCropCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [avatarEditingUrl])

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
              Логин
              <input
                name="username"
                type="text"
                required
                minLength={MIN_USERNAME}
                placeholder="Что вы будете вводить при входе"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label style={labelBlockStyle}>
              Пароль
              <input
                name="password"
                type="password"
                required
                minLength={MIN_PASSWORD}
                placeholder="Введите пароль"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
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
                  style={{
                    position: 'relative',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  className="register-avatar-pick"
                >
                  <Avatar
                    name={displayNameInput || username || '?'}
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
                      pointerEvents: avatarPreviewUrl ? 'auto' : 'none',
                    }}
                    className="register-avatar-hover"
                    aria-hidden
                    onClick={avatarPreviewUrl ? handleAvatarClear : undefined}
                  >
                    {avatarPreviewUrl ? (
                      <X size={32} color="#fff" strokeWidth={2.5} />
                    ) : (
                      <UploadCloud size={28} color="#fff" strokeWidth={2} />
                    )}
                  </div>
                </div>
              </div>
            </div>
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
            <label style={labelBlockStyle}>
              Имя (как видят другие)
              <input
                name="displayName"
                type="text"
                required
                minLength={MIN_DISPLAY_NAME}
                placeholder="Как вас будут видеть"
                autoComplete="name"
                value={displayNameInput}
                onChange={(e) => setDisplayNameInput(e.target.value)}
              />
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
        </div>
      </div>
    </div>
  )
}
