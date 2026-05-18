export async function copyPlainText(text: string): Promise<boolean> {
  const value = String(text ?? '')
  if (!value) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {}

  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    textarea.style.inset = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to load image'))
    image.src = src
  })
}

async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  if (typeof document === 'undefined') throw new Error('Document is unavailable')

  let width = 0
  let height = 0
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D context is unavailable')

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try {
      width = bitmap.width
      height = bitmap.height
      canvas.width = width
      canvas.height = height
      context.drawImage(bitmap, 0, 0)
    } finally {
      bitmap.close()
    }
  } else {
    const objectUrl = URL.createObjectURL(blob)
    try {
      const image = await loadImageElement(objectUrl)
      width = image.naturalWidth || image.width
      height = image.naturalHeight || image.height
      canvas.width = width
      canvas.height = height
      context.drawImage(image, 0, 0)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  if (!width || !height) {
    throw new Error('Image has invalid dimensions')
  }

  const pngBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png')
  })
  if (!pngBlob) throw new Error('Failed to encode PNG')
  return pngBlob
}

async function fetchClipboardImageBlob(url: string): Promise<Blob> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`Image fetch failed with status ${response.status}`)
  }
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) {
    throw new Error('Clipboard source is not an image')
  }
  return blobToPng(blob)
}

export async function copyImageFromUrl(url: string | null | undefined): Promise<boolean> {
  const value = String(url ?? '').trim()
  if (!value) return false
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    return false
  }

  try {
    const item = new ClipboardItem({
      'image/png': fetchClipboardImageBlob(value),
    })
    await navigator.clipboard.write([item])
    return true
  } catch {
    return false
  }
}
