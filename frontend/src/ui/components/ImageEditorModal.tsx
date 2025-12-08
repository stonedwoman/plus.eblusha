import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, PenSquare, RotateCcw, Undo2, X } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'

type DrawingPoint = { x: number; y: number }
type DrawingPath = { color: string; size: number; points: DrawingPoint[] }
type CropRect = { x: number; y: number; width: number; height: number }

export type EditableImage = {
  id: string
  file: File
  previewUrl: string
  fileName?: string
  edited?: boolean
}

type Props = {
  open: boolean
  image: EditableImage | null
  onClose: () => void
  onApply: (payload: { file: File; previewUrl: string }) => void
}

const BRUSH_COLORS = ['#ff4d4f', '#ff9f0a', '#ffd60a', '#34c759', '#0a84ff', '#a855f7']
const BRUSH_SIZES = [4, 8, 14]
const CROP_HANDLE_SIZE = 24
const MIN_CROP_SIZE = 80

export function ImageEditorModal({ open, image, onClose, onApply }: Props) {
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [imageScale, setImageScale] = useState(1)
  const [imageTranslate, setImageTranslate] = useState({ x: 0, y: 0 })
  const [displayedImageSize, setDisplayedImageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, width: 0, height: 0 })
  const [mode, setMode] = useState<'crop' | 'draw'>('crop')
  const [brushColor, setBrushColor] = useState(BRUSH_COLORS[0])
  const [brushSize, setBrushSize] = useState(BRUSH_SIZES[1])
  const [paths, setPaths] = useState<DrawingPath[]>([])
  const [currentPath, setCurrentPath] = useState<DrawingPath | null>(null)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768)
  const [isAnimating, setIsAnimating] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const cropDragRef = useRef<{ type: 'move' | 'resize' | null; handle?: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'; startX: number; startY: number; initial: CropRect }>({
    type: null,
    startX: 0,
    startY: 0,
    initial: { x: 0, y: 0, width: 0, height: 0 },
  })
  const drawingPointerRef = useRef<number | null>(null)
  const cleanupImg = useRef<(() => void) | null>(null)
  const animationRef = useRef<number | null>(null)

  const isReady = open && !!image && !!imgEl && viewport.width > 0 && viewport.height > 0

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768)
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const applyCrop = async () => {
    if (!imgEl || !cropCanvasRef.current || isAnimating) return
    
    setIsAnimating(true)
    
    // Use the cropRect aspect ratio directly - this is what user selected
    const selectedCropAspect = cropRect.width / cropRect.height
    
    // Calculate actual visible crop area in viewport coordinates (clamped to image bounds)
    const viewportCropX = Math.max(cropRect.x, imageTranslate.x)
    const viewportCropY = Math.max(cropRect.y, imageTranslate.y)
    const viewportCropRight = Math.min(cropRect.x + cropRect.width, imageTranslate.x + displayedImageSize.width)
    const viewportCropBottom = Math.min(cropRect.y + cropRect.height, imageTranslate.y + displayedImageSize.height)
    const viewportCropWidth = viewportCropRight - viewportCropX
    const viewportCropHeight = viewportCropBottom - viewportCropY
    
    // Calculate crop area in image coordinates (natural image size)
    const scaleX = imgEl.naturalWidth / displayedImageSize.width
    const scaleY = imgEl.naturalHeight / displayedImageSize.height
    
    let cropX = (viewportCropX - imageTranslate.x) * scaleX
    let cropY = (viewportCropY - imageTranslate.y) * scaleY
    let cropW = viewportCropWidth * scaleX
    let cropH = viewportCropHeight * scaleY
    
    // Preserve the selected aspect ratio - adjust dimensions to match cropRect aspect ratio
    const currentAspect = cropW / cropH
    if (currentAspect > selectedCropAspect) {
      // Current is wider than selected - reduce width
      cropW = cropH * selectedCropAspect
    } else {
      // Current is taller than selected - reduce height
      cropH = cropW / selectedCropAspect
    }
    
    // Clamp crop coordinates to image boundaries
    const imgNaturalWidth = imgEl.naturalWidth
    const imgNaturalHeight = imgEl.naturalHeight
    
    let finalCropX = Math.max(0, cropX)
    let finalCropY = Math.max(0, cropY)
    let finalCropW = Math.max(1, Math.min(cropW, imgNaturalWidth - finalCropX))
    let finalCropH = Math.max(1, Math.min(cropH, imgNaturalHeight - finalCropY))
    
    // If we had to adjust due to boundaries, recalculate to preserve aspect
    const actualAspect = finalCropW / finalCropH
    if (Math.abs(actualAspect - selectedCropAspect) > 0.01) {
      if (actualAspect > selectedCropAspect) {
        finalCropW = finalCropH * selectedCropAspect
      } else {
        finalCropH = finalCropW / selectedCropAspect
      }
      // Re-clamp
      finalCropW = Math.max(1, Math.min(finalCropW, imgNaturalWidth - finalCropX))
      finalCropH = Math.max(1, Math.min(finalCropH, imgNaturalHeight - finalCropY))
    }
    
    // Create output canvas with actual crop dimensions (preserving selected aspect ratio)
    const outputCanvas = document.createElement('canvas')
    const outputWidth = Math.max(1, Math.round(finalCropW))
    const outputHeight = Math.max(1, Math.round(finalCropH))
    outputCanvas.width = outputWidth
    outputCanvas.height = outputHeight
    const outputCtx = outputCanvas.getContext('2d')
    if (!outputCtx) {
      setIsAnimating(false)
      return
    }
    
    // Draw cropped image at actual size - preserve aspect ratio of selected crop area
    outputCtx.drawImage(imgEl, finalCropX, finalCropY, finalCropW, finalCropH, 0, 0, outputWidth, outputHeight)
    
    // Draw paths scaled to crop area - transform from viewport to canvas coordinates
    const pathScaleX = outputWidth / viewportCropWidth
    const pathScaleY = outputHeight / viewportCropHeight
    outputCtx.lineCap = 'round'
    outputCtx.lineJoin = 'round'
    const drawList = [...paths, ...(currentPath ? [currentPath] : [])]
    for (const path of drawList) {
      if (!path.points.length) continue
      outputCtx.strokeStyle = path.color
      outputCtx.lineWidth = path.size * ((pathScaleX + pathScaleY) / 2)
      outputCtx.beginPath()
      const firstPoint = path.points[0]
      // Transform from viewport coordinates to canvas coordinates
      const cropPointX = (firstPoint.x - viewportCropX) * pathScaleX
      const cropPointY = (firstPoint.y - viewportCropY) * pathScaleY
      outputCtx.moveTo(cropPointX, cropPointY)
      for (let i = 1; i < path.points.length; i++) {
        const p = path.points[i]
        outputCtx.lineTo((p.x - viewportCropX) * pathScaleX, (p.y - viewportCropY) * pathScaleY)
      }
      outputCtx.stroke()
    }
    
    // Create new image from cropped canvas
    const newImg = new Image()
    newImg.src = outputCanvas.toDataURL()
    
    await new Promise<void>((resolve) => {
      newImg.onload = () => {
        // Update image element
        setImgEl(newImg)
        
        // Adapt viewport to match cropped image aspect ratio
        const imageAspect = newImg.naturalWidth / newImg.naturalHeight
        
        let newViewportWidth: number
        let newViewportHeight: number
        
        if (isMobile) {
          // On mobile: adapt viewport to image proportions within available space
          const vw = window.innerWidth
          const vh = window.innerHeight
          const toolbarHeight = 200
          const headerHeight = 60
          const maxAvailableHeight = vh - toolbarHeight - headerHeight
          const maxAvailableWidth = vw
          
          // Calculate viewport size based on image aspect ratio
          if (imageAspect > maxAvailableWidth / maxAvailableHeight) {
            // Image is wider - use full width
            newViewportWidth = maxAvailableWidth
            newViewportHeight = maxAvailableWidth / imageAspect
          } else {
            // Image is taller - use full height
            newViewportHeight = maxAvailableHeight
            newViewportWidth = maxAvailableHeight * imageAspect
          }
        } else {
          // On desktop: adapt viewport to image proportions within max dimensions
          const maxWidth = Math.min(window.innerWidth - 64, 720)
          const maxHeight = Math.min(window.innerHeight - 200, 520)
          
          if (imageAspect > maxWidth / maxHeight) {
            // Image is wider - use max width
            newViewportWidth = Math.max(280, maxWidth)
            newViewportHeight = newViewportWidth / imageAspect
          } else {
            // Image is taller - use max height
            newViewportHeight = Math.max(220, maxHeight)
            newViewportWidth = newViewportHeight * imageAspect
          }
        }
        
        // Update viewport to match image proportions
        setViewport({ width: newViewportWidth, height: newViewportHeight })
        
        // Calculate scale - image should fill viewport exactly (1:1)
        const newScale = newViewportWidth / newImg.naturalWidth
        setImageScale(newScale)
        setDisplayedImageSize({ width: newViewportWidth, height: newViewportHeight })
        
        // Image fills viewport exactly, no translation needed
        setImageTranslate({ x: 0, y: 0 })
        
        // Set crop rect to cover full viewport with padding
        const padding = 2
        const cropWidth = Math.max(MIN_CROP_SIZE, newViewportWidth - padding * 2)
        const cropHeight = Math.max(MIN_CROP_SIZE, newViewportHeight - padding * 2)
        setCropRect({
          x: padding,
          y: padding,
          width: cropWidth,
          height: cropHeight,
        })
        
        // Transform paths to new coordinate system
        // From old viewport -> canvas -> new viewport
        const viewportScaleX = newViewportWidth / outputWidth
        const viewportScaleY = newViewportHeight / outputHeight
        const translatedPaths = drawList.map(path => ({
          ...path,
          points: path.points.map(p => {
            // Transform: old viewport -> canvas -> new viewport
            const canvasX = (p.x - viewportCropX) * pathScaleX
            const canvasY = (p.y - viewportCropY) * pathScaleY
            // newImageTranslate is {x: 0, y: 0} since image fills viewport exactly
            const newViewportX = canvasX * viewportScaleX
            const newViewportY = canvasY * viewportScaleY
            return {
              x: newViewportX,
              y: newViewportY,
            }
          }),
        }))
        setPaths(translatedPaths.filter(p => 
          p.points.every(pt => pt.x >= 0 && pt.x <= newViewportWidth && pt.y >= 0 && pt.y <= newViewportHeight)
        ))
        setCurrentPath(null)
        
        // Force canvas redraw after state updates
        setTimeout(() => {
          redrawCanvas()
        }, 0)
        
        // Animate transition
        const startTime = performance.now()
        const duration = 300
        
        const animate = (currentTime: number) => {
          const elapsed = currentTime - startTime
          const progress = Math.min(elapsed / duration, 1)
          const easeProgress = 1 - Math.pow(1 - progress, 3) // ease-out cubic
          
          if (progress < 1) {
            animationRef.current = requestAnimationFrame(animate)
          } else {
            setIsAnimating(false)
            animationRef.current = null
            // Redraw canvas after animation completes
            setTimeout(() => {
              redrawCanvas()
            }, 0)
          }
        }
        
        animationRef.current = requestAnimationFrame(animate)
        resolve()
      }
    })
  }

  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!open || !image) {
      setImgEl(null)
      setPaths([])
      setCurrentPath(null)
      setIsAnimating(false)
      return
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      setImgEl(img)
      if (isMobile) {
        const vw = window.innerWidth
        const vh = window.innerHeight
        const toolbarHeight = 200
        const headerHeight = 60
        const availableHeight = vh - toolbarHeight - headerHeight
        const availableWidth = vw
        
        let width = img.naturalWidth
        let height = img.naturalHeight
        
        const scaleX = availableWidth / width
        const scaleY = availableHeight / height
        const fittedScale = Math.min(scaleX, scaleY)
        
        width = img.naturalWidth * fittedScale
        height = img.naturalHeight * fittedScale
        
        setViewport({ width: availableWidth, height: availableHeight })
        setImageScale(fittedScale)
        setDisplayedImageSize({ width, height })
        const centered = {
          x: (availableWidth - width) / 2,
          y: (availableHeight - height) / 2,
        }
        setImageTranslate(centered)
        
        // Initialize crop rect to full viewport with padding for border visibility
        const padding = 2
        setCropRect({ x: padding, y: padding, width: availableWidth - padding * 2, height: availableHeight - padding * 2 })
      } else {
        const maxWidth = Math.min(window.innerWidth - 64, 720)
        const maxHeight = Math.min(window.innerHeight - 200, 520)
        let width = img.naturalWidth
        let height = img.naturalHeight
        if (width > maxWidth) {
          const ratio = maxWidth / width
          width *= ratio
          height *= ratio
        }
        if (height > maxHeight) {
          const ratio = maxHeight / height
          width *= ratio
          height *= ratio
        }
        width = Math.max(280, width)
        height = Math.max(220, height)
        setViewport({ width, height })
        const fittedScale = Math.max(width / img.naturalWidth, height / img.naturalHeight)
        setImageScale(fittedScale)
        const displayedWidth = img.naturalWidth * fittedScale
        const displayedHeight = img.naturalHeight * fittedScale
        setDisplayedImageSize({ width: displayedWidth, height: displayedHeight })
        const centered = {
          x: (width - displayedWidth) / 2,
          y: (height - displayedHeight) / 2,
        }
          setImageTranslate(centered)
          
          // Initialize crop rect to full viewport with padding for border visibility
          const padding = 2
          setCropRect({ x: padding, y: padding, width: width - padding * 2, height: height - padding * 2 })
      }
      setPaths([])
      setCurrentPath(null)
      setMode('crop')
      setIsAnimating(false)
    }
    img.src = image.previewUrl
    cleanupImg.current = () => {
      img.src = ''
    }
    return () => {
      cleanupImg.current?.()
      cleanupImg.current = null
    }
  }, [open, image?.id, image?.previewUrl, isMobile])

  useEffect(() => {
    if (!open) {
      setPaths([])
      setCurrentPath(null)
      setIsAnimating(false)
    }
  }, [open])

  const redrawCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas || viewport.width === 0 || viewport.height === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== viewport.width * ratio || canvas.height !== viewport.height * ratio) {
      canvas.width = viewport.width * ratio
      canvas.height = viewport.height * ratio
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
    }
    ctx.save()
    ctx.scale(ratio, ratio)
    ctx.clearRect(0, 0, viewport.width, viewport.height)
    const drawList = currentPath ? [...paths, currentPath] : paths
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const path of drawList) {
      if (path.points.length === 0) continue
      ctx.strokeStyle = path.color
      ctx.lineWidth = path.size
      ctx.beginPath()
      ctx.moveTo(path.points[0].x, path.points[0].y)
      for (let i = 1; i < path.points.length; i++) {
        ctx.lineTo(path.points[i].x, path.points[i].y)
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  useEffect(() => {
    redrawCanvas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, currentPath, viewport.width, viewport.height])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const getHandleAtPoint = (x: number, y: number, rect: CropRect): 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'move' | null => {
    const handleSize = CROP_HANDLE_SIZE
    const halfHandle = handleSize / 2
    
    // Check corners first
    if (Math.abs(x - rect.x) < halfHandle && Math.abs(y - rect.y) < halfHandle) return 'nw'
    if (Math.abs(x - (rect.x + rect.width)) < halfHandle && Math.abs(y - rect.y) < halfHandle) return 'ne'
    if (Math.abs(x - rect.x) < halfHandle && Math.abs(y - (rect.y + rect.height)) < halfHandle) return 'sw'
    if (Math.abs(x - (rect.x + rect.width)) < halfHandle && Math.abs(y - (rect.y + rect.height)) < halfHandle) return 'se'
    
    // Check edges
    if (Math.abs(x - rect.x) < halfHandle && y >= rect.y && y <= rect.y + rect.height) return 'w'
    if (Math.abs(x - (rect.x + rect.width)) < halfHandle && y >= rect.y && y <= rect.y + rect.height) return 'e'
    if (Math.abs(y - rect.y) < halfHandle && x >= rect.x && x <= rect.x + rect.width) return 'n'
    if (Math.abs(y - (rect.y + rect.height)) < halfHandle && x >= rect.x && x <= rect.x + rect.width) return 's'
    
    // Check if inside rect (for moving)
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return 'move'
    
    return null
  }

  const clampCropRect = (rect: CropRect): CropRect => {
    const BORDER_WIDTH = 2
    const padding = BORDER_WIDTH
    const minX = padding
    const minY = padding
    const maxX = viewport.width - padding
    const maxY = viewport.height - padding
    const clampedX = Math.max(minX, Math.min(maxX - rect.width, rect.x))
    const clampedY = Math.max(minY, Math.min(maxY - rect.height, rect.y))
    const clampedWidth = Math.max(MIN_CROP_SIZE, Math.min(maxX - clampedX, rect.width))
    const clampedHeight = Math.max(MIN_CROP_SIZE, Math.min(maxY - clampedY, rect.height))
    return { x: clampedX, y: clampedY, width: clampedWidth, height: clampedHeight }
  }

  const handleCropPointerDown = (e: ReactPointerEvent) => {
    if (mode !== 'crop' || isAnimating || !viewportRef.current) return
    e.preventDefault()
    const rect = viewportRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const handle = getHandleAtPoint(x, y, cropRect)
    if (!handle) return
    
    viewportRef.current.setPointerCapture(e.pointerId)
    cropDragRef.current = {
      type: handle === 'move' ? 'move' : 'resize',
      handle: handle !== 'move' ? handle : undefined,
      startX: e.clientX,
      startY: e.clientY,
      initial: { ...cropRect },
    }
  }

  const handleCropPointerMove = (e: ReactPointerEvent) => {
    if (mode !== 'crop' || !cropDragRef.current.type || isAnimating) return
    e.preventDefault()
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    
    const deltaX = e.clientX - cropDragRef.current.startX
    const deltaY = e.clientY - cropDragRef.current.startY
    const localDeltaX = deltaX
    const localDeltaY = deltaY
    
    if (cropDragRef.current.type === 'move') {
      const newRect = {
        x: cropDragRef.current.initial.x + localDeltaX,
        y: cropDragRef.current.initial.y + localDeltaY,
        width: cropDragRef.current.initial.width,
        height: cropDragRef.current.initial.height,
      }
      setCropRect(clampCropRect(newRect))
    } else if (cropDragRef.current.type === 'resize' && cropDragRef.current.handle) {
      const handle = cropDragRef.current.handle
      let newRect = { ...cropDragRef.current.initial }
      
      if (handle === 'nw') {
        newRect.x = cropDragRef.current.initial.x + localDeltaX
        newRect.y = cropDragRef.current.initial.y + localDeltaY
        newRect.width = cropDragRef.current.initial.width - localDeltaX
        newRect.height = cropDragRef.current.initial.height - localDeltaY
      } else if (handle === 'ne') {
        newRect.y = cropDragRef.current.initial.y + localDeltaY
        newRect.width = cropDragRef.current.initial.width + localDeltaX
        newRect.height = cropDragRef.current.initial.height - localDeltaY
      } else if (handle === 'sw') {
        newRect.x = cropDragRef.current.initial.x + localDeltaX
        newRect.width = cropDragRef.current.initial.width - localDeltaX
        newRect.height = cropDragRef.current.initial.height + localDeltaY
      } else if (handle === 'se') {
        newRect.width = cropDragRef.current.initial.width + localDeltaX
        newRect.height = cropDragRef.current.initial.height + localDeltaY
      } else if (handle === 'n') {
        newRect.y = cropDragRef.current.initial.y + localDeltaY
        newRect.height = cropDragRef.current.initial.height - localDeltaY
      } else if (handle === 's') {
        newRect.height = cropDragRef.current.initial.height + localDeltaY
      } else if (handle === 'w') {
        newRect.x = cropDragRef.current.initial.x + localDeltaX
        newRect.width = cropDragRef.current.initial.width - localDeltaX
      } else if (handle === 'e') {
        newRect.width = cropDragRef.current.initial.width + localDeltaX
      }
      
      // Ensure minimum size
      if (newRect.width < MIN_CROP_SIZE) {
        if (handle === 'nw' || handle === 'w' || handle === 'sw') {
          newRect.x = cropDragRef.current.initial.x + cropDragRef.current.initial.width - MIN_CROP_SIZE
        }
        newRect.width = MIN_CROP_SIZE
      }
      if (newRect.height < MIN_CROP_SIZE) {
        if (handle === 'nw' || handle === 'n' || handle === 'ne') {
          newRect.y = cropDragRef.current.initial.y + cropDragRef.current.initial.height - MIN_CROP_SIZE
        }
        newRect.height = MIN_CROP_SIZE
      }
      
      setCropRect(clampCropRect(newRect))
    }
  }

  const handleCropPointerUp = async (e: ReactPointerEvent) => {
    const wasDragging = cropDragRef.current.type !== null
    if (cropDragRef.current.type && viewportRef.current?.hasPointerCapture(e.pointerId)) {
      viewportRef.current.releasePointerCapture(e.pointerId)
    }
    cropDragRef.current.type = null
    
    // Auto-apply crop after drag ends
    if (wasDragging && mode === 'crop' && !isAnimating) {
      await applyCrop()
    }
  }

  const handleStartDrawing = (e: ReactPointerEvent) => {
    if (mode !== 'draw' || !canvasRef.current || isAnimating) return
    e.preventDefault()
    const rect = canvasRef.current.getBoundingClientRect()
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const newPath: DrawingPath = { color: brushColor, size: brushSize, points: [point] }
    drawingPointerRef.current = e.pointerId
    canvasRef.current.setPointerCapture(e.pointerId)
    setCurrentPath(newPath)
  }

  const handleDrawMove = (e: ReactPointerEvent) => {
    if (mode !== 'draw' || drawingPointerRef.current !== e.pointerId) return
    if (!canvasRef.current) return
    e.preventDefault()
    const rect = canvasRef.current.getBoundingClientRect()
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setCurrentPath((prev) => {
      if (!prev) return prev
      if (prev.points.length && prev.points[prev.points.length - 1].x === point.x && prev.points[prev.points.length - 1].y === point.y) {
        return prev
      }
      return { ...prev, points: [...prev.points, point] }
    })
  }

  const handleFinishDrawing = (e: ReactPointerEvent) => {
    if (mode !== 'draw' || drawingPointerRef.current !== e.pointerId) return
    drawingPointerRef.current = null
    if (canvasRef.current?.hasPointerCapture(e.pointerId)) {
      canvasRef.current.releasePointerCapture(e.pointerId)
    }
    setCurrentPath((prev) => {
      if (!prev) return null
      if (prev.points.length < 2) {
        const copy = { ...prev, points: [...prev.points, prev.points[0]] }
        setPaths((existing) => [...existing, copy])
      } else {
        setPaths((existing) => [...existing, prev])
      }
      return null
    })
  }

  const handleUndo = () => {
    setPaths((prev) => prev.slice(0, -1))
  }

  const handleClear = () => {
    setPaths([])
    setCurrentPath(null)
  }

  const resetCrop = async () => {
    if (!imgEl || isAnimating) return
    // Reload original image
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise<void>((resolve) => {
      img.onload = () => {
        setImgEl(img)
        if (isMobile) {
          const vw = window.innerWidth
          const vh = window.innerHeight
          const toolbarHeight = 200
          const headerHeight = 60
          const availableHeight = vh - toolbarHeight - headerHeight
          const availableWidth = vw
          
          let width = img.naturalWidth
          let height = img.naturalHeight
          
          const scaleX = availableWidth / width
          const scaleY = availableHeight / height
          const fittedScale = Math.min(scaleX, scaleY)
          
          const displayedWidth = width * fittedScale
          const displayedHeight = height * fittedScale
          
          setViewport({ width: availableWidth, height: availableHeight })
          setImageScale(fittedScale)
          setDisplayedImageSize({ width: displayedWidth, height: displayedHeight })
          const centered = {
            x: (availableWidth - displayedWidth) / 2,
            y: (availableHeight - displayedHeight) / 2,
          }
          setImageTranslate(centered)
          const padding = 2
          setCropRect({ x: padding, y: padding, width: availableWidth - padding * 2, height: availableHeight - padding * 2 })
        } else {
          const maxWidth = Math.min(window.innerWidth - 64, 720)
          const maxHeight = Math.min(window.innerHeight - 200, 520)
          let width = img.naturalWidth
          let height = img.naturalHeight
          if (width > maxWidth) {
            const ratio = maxWidth / width
            width *= ratio
            height *= ratio
          }
          if (height > maxHeight) {
            const ratio = maxHeight / height
            width *= ratio
            height *= ratio
          }
          width = Math.max(280, width)
          height = Math.max(220, height)
          setViewport({ width, height })
          const fittedScale = Math.max(width / img.naturalWidth, height / img.naturalHeight)
          setImageScale(fittedScale)
          const displayedWidth = img.naturalWidth * fittedScale
          const displayedHeight = img.naturalHeight * fittedScale
          setDisplayedImageSize({ width: displayedWidth, height: displayedHeight })
          const centered = {
            x: (width - displayedWidth) / 2,
            y: (height - displayedHeight) / 2,
          }
          setImageTranslate(centered)
          const padding = 2
          setCropRect({ x: padding, y: padding, width: width - padding * 2, height: height - padding * 2 })
        }
        setPaths([])
        setCurrentPath(null)
        resolve()
      }
      img.src = image!.previewUrl
    })
  }

  const exportEdited = async () => {
    if (!image || !imgEl) return
    
    // Use the cropRect aspect ratio directly - this is what user selected
    const cropAspect = cropRect.width / cropRect.height
    
    // Calculate actual visible crop area in viewport coordinates (clamped to image bounds)
    const viewportCropX = Math.max(cropRect.x, imageTranslate.x)
    const viewportCropY = Math.max(cropRect.y, imageTranslate.y)
    const viewportCropRight = Math.min(cropRect.x + cropRect.width, imageTranslate.x + displayedImageSize.width)
    const viewportCropBottom = Math.min(cropRect.y + cropRect.height, imageTranslate.y + displayedImageSize.height)
    const viewportCropWidth = viewportCropRight - viewportCropX
    const viewportCropHeight = viewportCropBottom - viewportCropY
    
    // Calculate crop area in image coordinates (natural image size)
    const scaleX = imgEl.naturalWidth / displayedImageSize.width
    const scaleY = imgEl.naturalHeight / displayedImageSize.height
    
    // Calculate the crop area in image coordinates
    const cropX = (viewportCropX - imageTranslate.x) * scaleX
    const cropY = (viewportCropY - imageTranslate.y) * scaleY
    let cropW = viewportCropWidth * scaleX
    let cropH = viewportCropHeight * scaleY
    
    // Preserve the selected aspect ratio - adjust dimensions to match cropRect aspect ratio
    const currentAspect = cropW / cropH
    if (currentAspect > cropAspect) {
      // Current is wider than selected - reduce width
      cropW = cropH * cropAspect
    } else {
      // Current is taller than selected - reduce height
      cropH = cropW / cropAspect
    }
    
    // Clamp crop coordinates to image boundaries
    const imgNaturalWidth = imgEl.naturalWidth
    const imgNaturalHeight = imgEl.naturalHeight
    
    let finalCropX = Math.max(0, cropX)
    let finalCropY = Math.max(0, cropY)
    let finalCropW = Math.max(1, Math.min(cropW, imgNaturalWidth - finalCropX))
    let finalCropH = Math.max(1, Math.min(cropH, imgNaturalHeight - finalCropY))
    
    // If we had to adjust due to boundaries, recalculate to preserve aspect
    const actualAspect = finalCropW / finalCropH
    if (Math.abs(actualAspect - cropAspect) > 0.01) {
      if (actualAspect > cropAspect) {
        finalCropW = finalCropH * cropAspect
      } else {
        finalCropH = finalCropW / cropAspect
      }
      // Re-clamp
      finalCropW = Math.max(1, Math.min(finalCropW, imgNaturalWidth - finalCropX))
      finalCropH = Math.max(1, Math.min(finalCropH, imgNaturalHeight - finalCropY))
    }
    
    // Calculate output dimensions - use the selected aspect ratio
    const outputWidth = Math.max(1, Math.round(finalCropW))
    const outputHeight = Math.max(1, Math.round(finalCropH))
    
    const canvas = document.createElement('canvas')
    canvas.width = outputWidth
    canvas.height = outputHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    // Draw cropped image - preserve aspect ratio of selected crop area
    ctx.drawImage(imgEl, finalCropX, finalCropY, finalCropW, finalCropH, 0, 0, outputWidth, outputHeight)
    
    // Draw paths scaled to crop area - transform from viewport to canvas coordinates
    const pathScaleX = outputWidth / viewportCropWidth
    const pathScaleY = outputHeight / viewportCropHeight
    const drawList = [...paths, ...(currentPath ? [currentPath] : [])]
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const path of drawList) {
      if (!path.points.length) continue
      ctx.strokeStyle = path.color
      ctx.lineWidth = path.size * ((pathScaleX + pathScaleY) / 2)
      ctx.beginPath()
      const firstPoint = path.points[0]
      // Transform from viewport coordinates to canvas coordinates
      const cropPointX = (firstPoint.x - viewportCropX) * pathScaleX
      const cropPointY = (firstPoint.y - viewportCropY) * pathScaleY
      ctx.moveTo(cropPointX, cropPointY)
      for (let i = 1; i < path.points.length; i++) {
        const p = path.points[i]
        ctx.lineTo((p.x - viewportCropX) * pathScaleX, (p.y - viewportCropY) * pathScaleY)
      }
      ctx.stroke()
    }
    
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png', 0.96))
    if (!blob) return
    const baseName = image.fileName?.replace(/\.[^.]+$/, '') || image.file.name.replace(/\.[^.]+$/, '') || 'image'
    const finalFile = new File([blob], `${baseName}-edited.png`, { type: 'image/png' })
    const previewUrl = URL.createObjectURL(blob)
    onApply({ file: finalFile, previewUrl })
  }

  const renderCropHandles = () => {
    if (mode !== 'crop' || isAnimating) return null
    const { x, y, width, height } = cropRect
    const handleStyle: React.CSSProperties = {
      position: 'absolute',
      width: CROP_HANDLE_SIZE,
      height: CROP_HANDLE_SIZE,
      background: '#fff',
      border: '2px solid rgba(0,0,0,0.3)',
      borderRadius: '2px',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    }
    
    return (
      <>
        <div style={{ ...handleStyle, left: x - CROP_HANDLE_SIZE / 2, top: y - CROP_HANDLE_SIZE / 2, cursor: 'nwse-resize' }} />
        <div style={{ ...handleStyle, left: x + width - CROP_HANDLE_SIZE / 2, top: y - CROP_HANDLE_SIZE / 2, cursor: 'nesw-resize' }} />
        <div style={{ ...handleStyle, left: x - CROP_HANDLE_SIZE / 2, top: y + height - CROP_HANDLE_SIZE / 2, cursor: 'nesw-resize' }} />
        <div style={{ ...handleStyle, left: x + width - CROP_HANDLE_SIZE / 2, top: y + height - CROP_HANDLE_SIZE / 2, cursor: 'nwse-resize' }} />
      </>
    )
  }

  if (!open || !image) return null

  if (isMobile) {
    return createPortal(
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: '#000',
          zIndex: 1300,
          display: 'flex',
          flexDirection: 'column',
          touchAction: 'none',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            background: 'rgba(0,0,0,0.8)',
            backdropFilter: 'blur(10px)',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            zIndex: 10,
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#fff',
              fontSize: 16,
              padding: '8px 0',
              cursor: 'pointer',
            }}
          >
            Отмена
          </button>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>Редактирование</div>
          <button
            onClick={exportEdited}
            disabled={!isReady || isAnimating}
            style={{
              background: !isReady || isAnimating ? 'rgba(255,255,255,0.2)' : '#ff9f0a',
              border: 'none',
              color: '#fff',
              fontSize: 16,
              fontWeight: 600,
              padding: '8px 16px',
              borderRadius: 8,
              cursor: isReady && !isAnimating ? 'pointer' : 'not-allowed',
            }}
          >
            Сохранить
          </button>
        </div>

        {/* Image Viewport */}
        <div
          ref={viewportRef}
          onPointerDown={handleCropPointerDown}
          onPointerMove={handleCropPointerMove}
          onPointerUp={handleCropPointerUp}
          onPointerLeave={handleCropPointerUp}
          style={{
            position: 'relative',
            flex: 1,
            background: '#000',
            overflow: 'hidden',
            touchAction: 'none',
          }}
        >
          {imgEl && (
            <img
              src={imgEl.src}
              draggable={false}
              alt="Редактируемое изображение"
              style={{
                position: 'absolute',
                left: imageTranslate.x,
                top: imageTranslate.y,
                width: displayedImageSize.width,
                height: displayedImageSize.height,
                userSelect: 'none',
                pointerEvents: 'none',
                transition: isAnimating ? 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s cubic-bezier(0.4, 0, 0.2, 1), left 0.3s cubic-bezier(0.4, 0, 0.2, 1), top 0.3s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
              }}
            />
          )}
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: mode === 'draw' ? 'auto' : 'none',
            }}
            onPointerDown={handleStartDrawing}
            onPointerMove={handleDrawMove}
            onPointerUp={handleFinishDrawing}
            onPointerLeave={handleFinishDrawing}
          />
          <canvas
            ref={cropCanvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              opacity: 0,
            }}
          />
          
          {/* Crop overlay */}
          {mode === 'crop' && !isAnimating && (
            <>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,0.5)',
                  clipPath: `polygon(
                    0% 0%, 0% 100%,
                    ${cropRect.x}px 100%,
                    ${cropRect.x}px ${cropRect.y}px,
                    ${cropRect.x + cropRect.width}px ${cropRect.y}px,
                    ${cropRect.x + cropRect.width}px ${cropRect.y + cropRect.height}px,
                    ${cropRect.x}px ${cropRect.y + cropRect.height}px,
                    ${cropRect.x}px 100%,
                    100% 100%, 100% 0%
                  )`,
                  pointerEvents: 'none',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: cropRect.x,
                  top: cropRect.y,
                  width: cropRect.width,
                  height: cropRect.height,
                  border: '2px solid #fff',
                  pointerEvents: 'none',
                }}
              />
              {renderCropHandles()}
            </>
          )}
        </div>

        {/* Toolbar */}
        <div
          style={{
            background: 'rgba(0,0,0,0.95)',
            backdropFilter: 'blur(10px)',
            borderTop: '1px solid rgba(255,255,255,0.1)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            maxHeight: '40vh',
            overflowY: 'auto',
          }}
        >
          {/* Mode Toggle */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setMode('crop')}
              style={{
                flex: 1,
                padding: '12px',
                borderRadius: 12,
                border: 'none',
                background: mode === 'crop' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)',
                color: '#fff',
                fontSize: 14,
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              Обрезать
            </button>
            <button
              onClick={() => setMode('draw')}
              style={{
                flex: 1,
                padding: '12px',
                borderRadius: 12,
                border: 'none',
                background: mode === 'draw' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)',
                color: '#fff',
                fontSize: 14,
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              <PenSquare size={18} />
              Рисовать
            </button>
          </div>

          <button
            onClick={resetCrop}
            disabled={isAnimating}
            style={{
              padding: '10px',
              borderRadius: 10,
              border: 'none',
              background: isAnimating ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)',
              color: isAnimating ? 'rgba(255,255,255,0.4)' : '#fff',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              cursor: isAnimating ? 'not-allowed' : 'pointer',
            }}
          >
            <RotateCcw size={16} />
            Сбросить
          </button>

          {mode === 'draw' && (
            <>
              {/* Colors */}
              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>Цвет кисти</div>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  {BRUSH_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setBrushColor(color)}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: '50%',
                        border: brushColor === color ? '3px solid #fff' : '2px solid rgba(255,255,255,0.3)',
                        background: color,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                      aria-label={`Выбрать цвет ${color}`}
                    />
                  ))}
                </div>
              </div>

              {/* Brush Size */}
              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>Толщина</div>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  {BRUSH_SIZES.map((size) => (
                    <button
                      key={size}
                      onClick={() => setBrushSize(size)}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 12,
                        border: brushSize === size ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)',
                        background: brushSize === size ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          width: size,
                          height: size,
                          borderRadius: '50%',
                          background: brushColor,
                          display: 'inline-block',
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>

              {/* Undo/Clear */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleUndo}
                  disabled={paths.length === 0}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: 10,
                    border: 'none',
                    background: paths.length === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)',
                    color: paths.length === 0 ? 'rgba(255,255,255,0.4)' : '#fff',
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    cursor: paths.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  <Undo2 size={16} />
                  Отменить
                </button>
                <button
                  onClick={handleClear}
                  disabled={paths.length === 0 && !currentPath}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: 10,
                    border: 'none',
                    background: paths.length === 0 && !currentPath ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)',
                    color: paths.length === 0 && !currentPath ? 'rgba(255,255,255,0.4)' : '#fff',
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    cursor: paths.length === 0 && !currentPath ? 'not-allowed' : 'pointer',
                  }}
                >
                  Очистить
                </button>
              </div>
            </>
          )}
        </div>
      </div>,
      document.body
    )
  }

  // Desktop version
  const modalBody = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2,4,10,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1300,
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'var(--surface-200)',
          border: '1px solid var(--surface-border)',
          borderRadius: 16,
          width: 'min(960px, 100%)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 20,
          gap: 16,
          color: 'var(--text-primary)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>
            Редактирование изображения
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{image.fileName || image.file.name}</div>
          </div>
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Закрыть редактор">
            <X size={18} />
          </button>
        </div>
        <div
          ref={viewportRef}
          onPointerDown={handleCropPointerDown}
          onPointerMove={handleCropPointerMove}
          onPointerUp={handleCropPointerUp}
          onPointerLeave={handleCropPointerUp}
          style={{
            position: 'relative',
            width: viewport.width,
            height: viewport.height,
            background: '#05070e',
            overflow: 'hidden',
            margin: '0 auto',
            touchAction: 'none',
            border: '1px solid rgba(255,255,255,0.08)',
            cursor: mode === 'crop' ? 'default' : 'crosshair',
          }}
        >
          {imgEl && (
            <img
              src={imgEl.src}
              draggable={false}
              alt="Редактируемое изображение"
              style={{
                position: 'absolute',
                left: imageTranslate.x,
                top: imageTranslate.y,
                width: displayedImageSize.width,
                height: displayedImageSize.height,
                userSelect: 'none',
                pointerEvents: 'none',
                transition: isAnimating ? 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s cubic-bezier(0.4, 0, 0.2, 1), left 0.3s cubic-bezier(0.4, 0, 0.2, 1), top 0.3s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
              }}
            />
          )}
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: mode === 'draw' ? 'auto' : 'none',
            }}
            onPointerDown={handleStartDrawing}
            onPointerMove={handleDrawMove}
            onPointerUp={handleFinishDrawing}
            onPointerLeave={handleFinishDrawing}
          />
          <canvas
            ref={cropCanvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              opacity: 0,
            }}
          />
          
          {/* Crop overlay */}
          {mode === 'crop' && !isAnimating && (
            <>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,0.5)',
                  clipPath: `polygon(
                    0% 0%, 0% 100%,
                    ${cropRect.x}px 100%,
                    ${cropRect.x}px ${cropRect.y}px,
                    ${cropRect.x + cropRect.width}px ${cropRect.y}px,
                    ${cropRect.x + cropRect.width}px ${cropRect.y + cropRect.height}px,
                    ${cropRect.x}px ${cropRect.y + cropRect.height}px,
                    ${cropRect.x}px 100%,
                    100% 100%, 100% 0%
                  )`,
                  pointerEvents: 'none',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: cropRect.x,
                  top: cropRect.y,
                  width: cropRect.width,
                  height: cropRect.height,
                  border: '2px solid #fff',
                  pointerEvents: 'none',
                }}
              />
              {renderCropHandles()}
            </>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className={mode === 'crop' ? 'btn btn-secondary' : 'btn btn-ghost'}
              onClick={() => setMode('crop')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              Обрезать
            </button>
            <button
              className={mode === 'draw' ? 'btn btn-secondary' : 'btn btn-ghost'}
              onClick={() => setMode('draw')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <PenSquare size={16} />
              Рисовать
            </button>
            <button className="btn btn-ghost" onClick={resetCrop} disabled={isAnimating} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RotateCcw size={16} />
              Сбросить
            </button>
            {mode === 'draw' && (
              <>
                <button
                  className="btn btn-ghost"
                  onClick={handleUndo}
                  disabled={paths.length === 0}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Undo2 size={16} />
                  Отменить штрих
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={handleClear}
                  disabled={paths.length === 0 && !currentPath}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  Очистить рисунок
                </button>
              </>
            )}
          </div>
          {mode === 'draw' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Цвет кисти</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {BRUSH_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setBrushColor(color)}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        border: brushColor === color ? '2px solid #fff' : '2px solid transparent',
                        background: color,
                        cursor: 'pointer',
                      }}
                      aria-label={`Выбрать цвет ${color}`}
                    />
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Толщина</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {BRUSH_SIZES.map((size) => (
                    <button
                      key={size}
                      onClick={() => setBrushSize(size)}
                      className={brushSize === size ? 'btn btn-secondary' : 'btn btn-ghost'}
                      style={{ width: 44, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <span
                        style={{
                          width: size,
                          height: size,
                          borderRadius: '50%',
                          background: brushColor,
                          display: 'inline-block',
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={exportEdited} disabled={!isReady || isAnimating} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Check size={16} />
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modalBody, document.body)
}
