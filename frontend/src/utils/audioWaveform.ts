/**
 * Генерирует waveform данные из аудио файла
 * Возвращает массив значений амплитуды (0-100) для визуализации
 */
export async function generateWaveform(audioUrl: string, bars: number = 60): Promise<number[]> {
  try {
    const response = await fetch(audioUrl)
    const arrayBuffer = await response.arrayBuffer()
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

    const channelData = audioBuffer.getChannelData(0) // Берем первый канал
    const samplesPerBar = Math.floor(channelData.length / bars)
    const waveform: number[] = []

    for (let i = 0; i < bars; i++) {
      let sum = 0
      let max = 0
      const start = i * samplesPerBar
      const end = Math.min(start + samplesPerBar, channelData.length)

      for (let j = start; j < end; j++) {
        const value = Math.abs(channelData[j])
        sum += value
        max = Math.max(max, value)
      }

      // Используем среднее значение и максимум для более точной визуализации
      const avg = sum / (end - start)
      const amplitude = Math.max(avg, max * 0.7)
      
      // Нормализуем к 0-100, но делаем минимальную высоту для видимости
      const normalized = Math.max(20, Math.min(100, amplitude * 200))
      waveform.push(normalized)
    }

    audioContext.close()
    return waveform
  } catch (error) {
    console.error('Failed to generate waveform:', error)
    // Возвращаем случайные значения для fallback
    return Array(bars).fill(0).map(() => Math.random() * 40 + 30)
  }
}

/**
 * Кэш для waveform данных
 */
const waveformCache = new Map<string, number[]>()

/**
 * Получить waveform с кэшированием
 */
export async function getWaveform(audioUrl: string, bars: number = 60): Promise<number[]> {
  const cacheKey = `${audioUrl}:${bars}`
  
  if (waveformCache.has(cacheKey)) {
    return waveformCache.get(cacheKey)!
  }

  const waveform = await generateWaveform(audioUrl, bars)
  waveformCache.set(cacheKey, waveform)
  return waveform
}



