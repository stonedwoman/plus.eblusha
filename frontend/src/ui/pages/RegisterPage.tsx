import { type FormEvent, useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../utils/api'

const MIN_USERNAME = 3
const MIN_PASSWORD = 8
const MIN_DISPLAY_NAME = 2

export default function RegisterPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<1 | 2>(1)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [step1Error, setStep1Error] = useState<string | null>(null)
  const [step2Error, setStep2Error] = useState<string | null>(null)
  const heightWrapperRef = useRef<HTMLDivElement>(null)
  const stepContainerRef = useRef<HTMLDivElement>(null)
  const prevStepRef = useRef<1 | 2>(1)

  const mutation = useMutation({
    mutationFn: async (data: {
      username: string
      displayName: string
      password: string
    }) => {
      const response = await api.post('/auth/register', data)
      return response.data
    },
    onSuccess: () => {
      navigate('/auth', { replace: true })
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
    const form = new FormData(e.currentTarget)
    const displayName = String(form.get('displayName') ?? '').trim()
    if (displayName.length < MIN_DISPLAY_NAME) {
      setStep2Error('Отображаемое имя не менее 2 символов')
      return
    }
    mutation.mutate({ username, password, displayName })
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
                placeholder="Введите логин"
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
            <label style={labelBlockStyle}>
              Отображаемое имя
              <input
                name="displayName"
                type="text"
                required
                minLength={MIN_DISPLAY_NAME}
                placeholder="Как вас будут видеть"
                autoComplete="name"
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
