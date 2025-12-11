export type VoiceRecorderState = 'idle' | 'recording' | 'paused' | 'stopped'

export interface VoiceRecorderCallbacks {
  onStateChange?: (state: VoiceRecorderState) => void
  onDurationUpdate?: (duration: number) => void
  onError?: (error: Error) => void
  onAmplitudeUpdate?: (amplitude: number) => void
}

export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private dataArray: Uint8Array | null = null
  private amplitudeTimer: number | null = null
  private state: VoiceRecorderState = 'idle'
  private duration = 0
  private durationTimer: number | null = null
  private startTime = 0
  private callbacks: VoiceRecorderCallbacks = {}

  constructor(callbacks: VoiceRecorderCallbacks = {}) {
    this.callbacks = callbacks
  }

  async start(): Promise<void> {
    if (this.state === 'recording') {
      return
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const options: MediaRecorderOptions = {
        mimeType: this.getSupportedMimeType(),
      }
      
      this.mediaRecorder = new MediaRecorder(this.stream, options)
      this.audioChunks = []

      // Настраиваем Web Audio API для анализа амплитуды в реальном времени
      try {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
        
        // Активируем контекст, если он приостановлен (требуется для некоторых браузеров)
        if (this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {})
        }
        
        const source = this.audioContext.createMediaStreamSource(this.stream)
        this.analyser = this.audioContext.createAnalyser()
        this.analyser.fftSize = 2048 // Увеличиваем для лучшего разрешения
        this.analyser.smoothingTimeConstant = 0.3 // Меньше сглаживания для более отзывчивой визуализации
        source.connect(this.analyser)
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount)
        this.startAmplitudeAnalysis()
      } catch (err) {
        console.error('Failed to setup audio analysis:', err)
        // Продолжаем без анализа амплитуды, но логируем ошибку
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data)
        }
      }

      this.mediaRecorder.onstop = () => {
        this.stopDurationTimer()
        this.stopAmplitudeAnalysis()
        if (this.audioContext) {
          this.audioContext.close().catch(() => {})
          this.audioContext = null
        }
        if (this.stream) {
          this.stream.getTracks().forEach((track) => track.stop())
        }
      }

      this.mediaRecorder.onerror = (event) => {
        const error = new Error('MediaRecorder error')
        this.callbacks.onError?.(error)
      }

      this.mediaRecorder.start(100) // Collect data every 100ms
      this.state = 'recording'
      this.startTime = Date.now()
      this.startDurationTimer()
      this.callbacks.onStateChange?.(this.state)
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to start recording')
      this.callbacks.onError?.(err)
      throw err
    }
  }

  stop(): Blob | null {
    if (this.state !== 'recording') {
      return null
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }

    this.state = 'stopped'
    this.stopDurationTimer()
    this.callbacks.onStateChange?.(this.state)

    if (this.audioChunks.length === 0) {
      return null
    }

    const audioBlob = new Blob(this.audioChunks, { type: this.getSupportedMimeType() || 'audio/webm' })
    return audioBlob
  }

  cancel(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    this.stopAmplitudeAnalysis()
    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
    }
    this.audioChunks = []
    this.state = 'idle'
    this.duration = 0
    this.stopDurationTimer()
    this.callbacks.onStateChange?.(this.state)
  }

  getState(): VoiceRecorderState {
    return this.state
  }

  getDuration(): number {
    return this.duration
  }

  private startDurationTimer(): void {
    this.stopDurationTimer()
    // Обновляем каждую секунду, а не каждые 100ms, чтобы избежать лишних обновлений
    this.durationTimer = window.setInterval(() => {
      if (this.state === 'recording') {
        this.duration = Math.floor((Date.now() - this.startTime) / 1000)
        this.callbacks.onDurationUpdate?.(this.duration)
      }
    }, 1000)
  }

  private stopDurationTimer(): void {
    if (this.durationTimer !== null) {
      clearInterval(this.durationTimer)
      this.durationTimer = null
    }
  }

  private startAmplitudeAnalysis(): void {
    this.stopAmplitudeAnalysis()
    if (!this.analyser || !this.dataArray || !this.audioContext) return

    let lastUpdate = 0
    const minIntervalMs = 50 // ~20 FPS: снижаем нагрузку на мобильных

    const analyze = (timestamp?: number) => {
      if (!this.analyser || !this.dataArray || this.state !== 'recording') return
      
      // Проверяем состояние AudioContext
      if (!this.audioContext) return
      
      if (this.audioContext.state === 'closed') {
        // Контекст закрыт, прекращаем анализ
        return
      }
      
      // Реактивируем AudioContext, если он приостановлен (важно для мобильных)
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {})
        // Пропускаем этот кадр, даем контексту время на реактивацию
        if (this.state === 'recording') {
          this.amplitudeTimer = window.requestAnimationFrame(analyze)
        }
        return
      }

      // Троттлим обновления по времени кадра
      if (typeof timestamp === 'number') {
        if (timestamp - lastUpdate < minIntervalMs) {
          if (this.state === 'recording') {
            this.amplitudeTimer = window.requestAnimationFrame(analyze)
          }
          return
        }
        lastUpdate = timestamp
      }
      
      // Используем getByteTimeDomainData для получения амплитуды (не частоты)
      try {
        this.analyser.getByteTimeDomainData(this.dataArray)
      } catch (err) {
        // Если analyser недоступен, прекращаем анализ
        console.warn('Analyser error:', err)
        return
      }
      
      // Вычисляем максимальную амплитуду и среднюю для более стабильной визуализации
      let max = 0
      let sum = 0
      for (let i = 0; i < this.dataArray.length; i++) {
        // Преобразуем байт (0-255) в амплитуду (-128 до 127)
        const value = Math.abs(this.dataArray[i] - 128)
        max = Math.max(max, value)
        sum += value
      }
      const average = sum / this.dataArray.length
      
      // Используем комбинацию максимума и среднего для более стабильной визуализации
      const combined = (max * 0.7 + average * 0.3)
      
      // Нормализуем к 0-100, увеличиваем чувствительность
      // 128 - это максимальное отклонение от центра
      const normalized = (combined / 128) * 100
      
      // Усиливаем сигнал и добавляем минимальную видимость
      const amplified = Math.min(100, normalized * 2.5)
      const minVisible = 15
      const adjusted = Math.max(minVisible, amplified)
      
      this.callbacks.onAmplitudeUpdate?.(adjusted)
      
      if (this.state === 'recording') {
        this.amplitudeTimer = window.requestAnimationFrame(analyze)
      }
    }
    
    this.amplitudeTimer = window.requestAnimationFrame(analyze)
  }

  private stopAmplitudeAnalysis(): void {
    if (this.amplitudeTimer !== null) {
      window.cancelAnimationFrame(this.amplitudeTimer)
      this.amplitudeTimer = null
    }
  }

  private getSupportedMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/mpeg',
    ]

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type
      }
    }

    return '' // Browser will use default
  }

  cleanup(): void {
    this.cancel()
  }
}




