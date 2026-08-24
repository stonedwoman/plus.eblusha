/**
 * Отпечаток файла для докачки — в том числе на ДРУГОМ компьютере.
 *
 * Считать SHA-256 от 30 ГБ в браузере перед стартом загрузки нельзя: это минуты
 * работы и подвисший интерфейс. Поэтому берём размер, mtime и хеш трёх выборок
 * (начало, середина, конец). Коллизия такого отпечатка для двух разных файлов
 * одинакового размера практически исключена, а криптографическую целостность
 * всё равно обеспечивает сервер: он считает настоящий SHA-256 после приёма
 * последнего байта.
 */
const SAMPLE_SIZE = 256 * 1024

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function fileFingerprint(file: File): Promise<string> {
  const size = file.size
  const parts: Blob[] = []

  if (size <= SAMPLE_SIZE * 3) {
    parts.push(file)
  } else {
    parts.push(file.slice(0, SAMPLE_SIZE))
    const mid = Math.floor(size / 2 - SAMPLE_SIZE / 2)
    parts.push(file.slice(mid, mid + SAMPLE_SIZE))
    parts.push(file.slice(size - SAMPLE_SIZE, size))
  }

  const buf = await new Blob(parts).arrayBuffer()
  const sample = await sha256Hex(buf)
  // Имя намеренно НЕ входит в отпечаток: переименованный файл — тот же файл,
  // и докачка должна его узнать.
  return `v1-${size}-${file.lastModified}-${sample.slice(0, 32)}`
}

export type FileIdentity = {
  fingerprint: string
  size: number
  lastModified: number
  name: string
  type: string
}

export async function identify(file: File): Promise<FileIdentity> {
  return {
    fingerprint: await fileFingerprint(file),
    size: file.size,
    lastModified: file.lastModified,
    name: file.name,
    type: file.type || 'application/octet-stream',
  }
}
