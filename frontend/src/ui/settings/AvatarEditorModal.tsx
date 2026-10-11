/**
 * Редактор кадра для нового фото профиля (0.1–10, жесты). Раньше жил внутри окна «Профиль»; теперь «Заменить фото»
 * в разделе «Профиль» центра настроек открывает выбор файла, а сам редактор — отдельным слоем поверх центра.
 * Логика прежняя: состояние (crop, refs, предпросмотр) остаётся в ChatsPage, жесты навешивает её эффект на editorRef;
 * загрузка — upload → PATCH /status/me {avatarUrl}, сервер рассылает profile:update.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { X } from 'lucide-react'
import { api, getUploadUrl } from '../../utils/api'
import { useAppStore } from '../../domain/store/appStore'

export interface AvatarEditorProps {
  isMobile: boolean
  avatarPreviewUrl: string
  selectedAvatarFile: File | null
  crop: { x: number; y: number; scale: number }
  setCrop: (next: any) => void
  editorRef: RefObject<HTMLDivElement | null>
  imageRef: RefObject<HTMLImageElement | null>
  cropCanvasRef: RefObject<HTMLCanvasElement | null>
  uploadingAvatar: boolean
  uploadProgress: number
  setSelectedAvatarFile: (f: File | null) => void
  setAvatarPreviewUrl: (u: string | null) => void
  setUploadingAvatar: (v: boolean) => void
  setUploadProgress: (v: number) => void
  setUploadMessage: (m: string | null) => void
  refetchMe: () => void
}

export function AvatarEditorModal(props: AvatarEditorProps) {
  const { isMobile, avatarPreviewUrl, selectedAvatarFile, crop, setCrop, editorRef, imageRef, cropCanvasRef, uploadingAvatar, uploadProgress, setSelectedAvatarFile, setAvatarPreviewUrl, setUploadingAvatar, setUploadProgress, setUploadMessage } = props
  const meInfoQuery = { refetch: props.refetchMe }
  const [uploadError, setUploadError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const cancel = () => {
    if (uploadingAvatar) return
    setSelectedAvatarFile(null)
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
    setAvatarPreviewUrl(null)
  }

  // Esc закрывает редактор (центр настроек под ним Esc не получает: у слоя aria-modal)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadingAvatar, avatarPreviewUrl])

  return (
    <div
      ref={rootRef}
      className="eb-no-drag"
      role="dialog"
      aria-modal="true"
      aria-label="Настройка аватара"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(10,12,16,0.62)',
        backdropFilter: 'blur(6px) saturate(110%)',
        display: 'flex',
        alignItems: isMobile ? 'flex-start' : 'center',
        justifyContent: 'center',
        padding: isMobile ? '16px 12px' : 16,
        overflowY: 'auto',
      }}
      onClick={cancel}
    >
      <div
        style={{ width: isMobile ? '100%' : 440, maxWidth: '96vw', background: 'var(--surface-200)', border: '1px solid var(--surface-border)', borderRadius: 16, padding: isMobile ? 12 : 16, boxShadow: 'var(--shadow-medium)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button type="button" className="btn btn-icon btn-ghost" aria-label="Закрыть" onClick={cancel}><X size={18} /></button>
        </div>
    <div style={{ border: '1px solid var(--surface-border)', borderRadius: 16, padding: 16, background: 'var(--surface-100)' }}>
      <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12, fontWeight: 600 }}>Настройка аватара</div>
      <div 
        ref={editorRef}
        onWheel={(e) => {
          e.preventDefault()
          const delta = -e.deltaY * 0.001
          const newScale = Math.max(0.1, Math.min(10, crop.scale * (1 + delta)))
          const rect = editorRef.current?.getBoundingClientRect()
          if (rect) {
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const scaleChange = newScale / crop.scale
            const newX = x - (x - crop.x) * scaleChange
            const newY = y - (y - crop.y) * scaleChange
            setCrop({ x: newX, y: newY, scale: newScale })
          }
        }}
          onPointerDown={(e) => {
          if (e.pointerType === 'touch') return // Touch обрабатывается в addEventListener
          const rect = editorRef.current?.getBoundingClientRect()
          if (!rect) return
          const editorWidth = rect.width
          const editorHeight = rect.height
          const centerX = editorWidth / 2
          const centerY = editorHeight / 2
          const cropSizeValue = 240
          const radius = cropSizeValue / 2
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          
          // Проверяем, что клик внутри круга
          const dx = x - centerX
          const dy = y - centerY
          if (dx * dx + dy * dy > radius * radius) {
            return
          }
          
            try { (e.currentTarget as any).setPointerCapture?.((e as any).pointerId) } catch {}
          const startX = e.clientX
          const startY = e.clientY
          const start = { ...crop }
            const onMove = (ev: PointerEvent) => {
              ev.preventDefault()
            const deltaX = ev.clientX - startX
            const deltaY = ev.clientY - startY
            setCrop({ ...start, x: start.x + deltaX, y: start.y + deltaY })
            }
            const onUp = () => {
              window.removeEventListener('pointermove', onMove as any)
              window.removeEventListener('pointerup', onUp)
            }
            window.addEventListener('pointermove', onMove as any, { passive: false } as any)
            window.addEventListener('pointerup', onUp, { passive: true } as any)
        }}
        style={{ 
        position: 'relative', 
        width: '100%', 
        height: 320, 
        background: 'var(--surface-200)', 
        overflow: 'hidden', 
        borderRadius: 12, 
        touchAction: 'none',
        border: '1px solid var(--surface-border)',
        boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
        cursor: 'move'
      }}>
        <img 
          ref={imageRef}
          src={avatarPreviewUrl} 
          alt="preview" 
          style={{ 
            position: 'absolute', 
            left: crop.x, 
            top: crop.y, 
            transform: `scale(${crop.scale})`, 
            transformOrigin: 'top left',
            willChange: 'transform',
            pointerEvents: 'none'
          }} 
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget
            const editor = editorRef.current
            if (!editor) return
            const editorWidth = editor.clientWidth
            const editorHeight = editor.clientHeight
            const cropSizeValue = 240
            const imgWidth = img.naturalWidth
            const imgHeight = img.naturalHeight
            const centerX = editorWidth / 2
            const centerY = editorHeight / 2
            
            // Рассчитываем масштаб, чтобы изображение максимально заполняло круг
            const scaleX = cropSizeValue / imgWidth
            const scaleY = cropSizeValue / imgHeight
            const initialScale = Math.max(scaleX, scaleY) * 1.2 // 1.2 для запаса
            
            // Центрируем изображение относительно центра круга
            const initialX = centerX - (imgWidth * initialScale) / 2
            const initialY = centerY - (imgHeight * initialScale) / 2
            
            setCrop({ x: initialX, y: initialY, scale: initialScale })
          }}
        />
        {/* Маска с градиентом для более плавного эффекта */}
        <div style={{ 
          position: 'absolute', 
          inset: 0, 
          pointerEvents: 'none', 
          borderRadius: '50%', 
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)', 
          width: 240, 
          height: 240, 
          margin: 'auto',
          border: '2px solid rgba(255,255,255,0.3)',
          boxSizing: 'border-box'
        }} />
        {/* Сетка для лучшего позиционирования */}
        <div style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          borderRadius: '50%',
          width: 240,
          height: 240,
          margin: 'auto',
          background: `
            linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
          opacity: 0.5
        }} />
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Масштаб</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface-200)', padding: '4px 8px', borderRadius: 6 }}>
            {Math.round(crop.scale * 100)}%
      </div>
        </div>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c: any) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}>−</div>
          <input 
            type="range" 
            min={0.1} 
            max={10} 
            step={0.05} 
            value={crop.scale} 
            onChange={(e) => setCrop((c: any) => ({ ...c, scale: parseFloat(e.target.value) }))} 
            style={{ 
              flex: 1, 
              height: 6,
              background: 'var(--surface-200)',
              borderRadius: 3,
              outline: 'none',
              cursor: 'pointer'
            }}
          />
          <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c: any) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}>+</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          <div style={{ flex: 1, textAlign: 'center', padding: '6px', background: 'var(--surface-200)', borderRadius: 6 }}>
            {isMobile ? 'Два пальца для масштаба, один для перемещения' : 'Перетащите для перемещения, колесико мыши для масштаба'}
          </div>
        </div>
      </div>
      <canvas ref={cropCanvasRef} width={240} height={240} style={{ display: 'none' }} />
    </div>
  {selectedAvatarFile && (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
      <button className="btn btn-secondary" onClick={cancel}>Отмена</button>
      <button className="btn btn-primary" disabled={uploadingAvatar} onClick={async () => {
        if (!selectedAvatarFile) return
        setUploadingAvatar(true)
        setUploadProgress(0)
        try {
          let blobToSend: Blob | null = null
          if (cropCanvasRef.current && avatarPreviewUrl) {
            const img = await new Promise<HTMLImageElement>((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.src = avatarPreviewUrl })
            const ctx = cropCanvasRef.current.getContext('2d')!
            const size = 240
            ctx.clearRect(0,0,size,size)
            ctx.save()
            ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.closePath(); ctx.clip()
            const vw = editorRef.current?.clientWidth ?? 320
            const vh = editorRef.current?.clientHeight ?? 320
            const viewportCenter = { x: vw / 2, y: vh / 2 }
            const viewRect = { x: viewportCenter.x - size/2, y: viewportCenter.y - size/2, w: size, h: size }
            const srcX = (viewRect.x - crop.x) / crop.scale
            const srcY = (viewRect.y - crop.y) / crop.scale
            const srcW = viewRect.w / crop.scale
            const srcH = viewRect.h / crop.scale
            ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size)
            ctx.restore()
            blobToSend = await new Promise<Blob | null>((resolve) => cropCanvasRef.current!.toBlob((b: any) => resolve(b), 'image/png'))
          }
          const form = new FormData()
          form.append('file', blobToSend ?? selectedAvatarFile)
            const url = await new Promise<string>((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', getUploadUrl())
            try { const token = useAppStore.getState().session?.accessToken; if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`) } catch {}
            xhr.upload.onprogress = (e) => {
              const total = e.lengthComputable ? e.total : ((blobToSend ?? selectedAvatarFile)?.size ?? 0)
              if (total > 0) setUploadProgress(Math.min(100, Math.round(100 * e.loaded / total)))
            }
            xhr.onreadystatechange = () => {
              if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                  try { const resp = JSON.parse(xhr.responseText); resolve(resp.url) } catch (err) { reject(err) }
                } else reject(new Error('upload failed'))
              }
            }
            xhr.onerror = () => reject(new Error('upload failed'))
            xhr.send(form)
          })
          await api.patch('/status/me', { avatarUrl: url })
          setSelectedAvatarFile(null)
          if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
          setAvatarPreviewUrl(null)
          meInfoQuery.refetch()
          setUploadMessage('Готово')
          setTimeout(() => setUploadMessage(null), 2200)
        } catch {
          // Раньше сбой молча объявлялся «Готово»; теперь честно говорим, что не вышло.
          setUploadError('Не удалось загрузить фото. Попробуйте ещё раз.')
        }
        setUploadingAvatar(false)
      }}>{uploadingAvatar ? 'Загрузка...' : 'Загрузить'}</button>
    </div>
  )}
  {uploadingAvatar && (
    <div style={{ height: 8, background: 'var(--surface-100)', borderRadius: 6, overflow: 'hidden', marginTop: 12 }}>
      <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--brand)', transition: 'width 0.2s ease' }} />
    </div>
  )}
        {uploadError ? (
          <div role="alert" style={{ marginTop: 10, color: '#fecaca', fontSize: 14 }}>{uploadError}</div>
        ) : null}
      </div>
    </div>
  )
}
