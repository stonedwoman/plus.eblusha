import React, { useEffect, useMemo, useRef } from 'react'

type Props = {
  placeholder?: string
  onSubmit: (text: string) => void
  onPasteImage?: (file: File) => void
  iframeRef?: React.RefObject<HTMLIFrameElement>
  className?: string
  style?: React.CSSProperties
}

export default function ChatComposerFrame({ placeholder = 'Напишите сообщение...', onSubmit, onPasteImage, iframeRef: externalIframeRef, className, style }: Props) {
  const internalIframeRef = useRef<HTMLIFrameElement | null>(null)
  const iframeRef = externalIframeRef || internalIframeRef

  const srcDoc = useMemo(() => {
    const pasteHandler = onPasteImage ? `const handlePaste=(e)=>{const items=e.clipboardData?.items;if(items){for(let j=0;j<items.length;j++){const item=items[j];if(item.type.indexOf('image')!==-1){e.preventDefault();e.stopPropagation();const file=item.getAsFile();if(file){const reader=new FileReader();reader.onload=()=>{parent.postMessage({type:'composer:pasteImage',file:reader.result,fileName:file.name||'image.png',fileType:file.type||'image/png'},'*');};reader.readAsDataURL(file);break;}}}};i.addEventListener('paste',handlePaste);document.addEventListener('paste',handlePaste,true);` : ''
    const html = `<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no\"><style>html,body{margin:0;background:#232731;color:#f4f5f7;font:16px/1.4 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif}form{display:flex;gap:8px;align-items:center;padding:0}input{flex:1;padding:12px;border-radius:8px;border:1px solid #313643;background:#1b1f27;color:#f4f5f7;font-size:16px}button{display:none}</style></head><body><form autocomplete=\"off\"><input id=\"m\" type=\"text\" inputmode=\"text\" autocorrect=\"off\" autocapitalize=\"off\" spellcheck=\"false\" placeholder=${JSON.stringify(
      placeholder,
    )} /><button type=\"submit\">send</button></form><script>const f=document.querySelector('form');const i=document.getElementById('m');f.addEventListener('submit',e=>{e.preventDefault();parent.postMessage({type:'composer:submit',text:i.value},'*');i.value='';});i.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.dispatchEvent(new Event('submit',{cancelable:true}));}});${pasteHandler}</script></body></html>`
    return html
  }, [placeholder, onPasteImage])

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      const data = e.data || {}
      if (data && data.type === 'composer:submit') {
        const text = String(data.text || '').trim()
        if (text) onSubmit(text)
      } else if (data && data.type === 'composer:pasteImage' && onPasteImage) {
        try {
          // Конвертируем dataURL обратно в File
          const byteString = atob(data.file.split(',')[1])
          const mimeString = data.file.split(',')[0].split(':')[1].split(';')[0]
          const ab = new ArrayBuffer(byteString.length)
          const ia = new Uint8Array(ab)
          for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i)
          }
          const blob = new Blob([ab], { type: mimeString })
          const file = new File([blob], data.fileName || 'image.png', { type: mimeString })
          onPasteImage(file)
        } catch (err) {
          console.error('Failed to process pasted image:', err)
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onSubmit, onPasteImage])

  // Добавляем обработчик paste на уровне iframe после его загрузки
  useEffect(() => {
    if (!onPasteImage || !iframeRef.current) return
    
    const iframe = iframeRef.current
    const handleLoad = () => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document
        if (!iframeDoc) return
        
        const handlePaste = (e: ClipboardEvent) => {
          const items = e.clipboardData?.items
          if (!items) return
          
          for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (item.type.indexOf('image') !== -1) {
              e.preventDefault()
              e.stopPropagation()
              const file = item.getAsFile()
              if (file) {
                onPasteImage(file)
              }
              break
            }
          }
        }
        
        iframeDoc.addEventListener('paste', handlePaste, true)
        const input = iframeDoc.getElementById('m')
        if (input) {
          input.addEventListener('paste', handlePaste, true)
        }
      } catch (err) {
        // Игнорируем ошибки доступа к iframe (CORS/sandbox)
      }
    }
    
    iframe.addEventListener('load', handleLoad)
    // Если iframe уже загружен
    if (iframe.contentDocument?.readyState === 'complete') {
      handleLoad()
    }
    
    return () => {
      iframe.removeEventListener('load', handleLoad)
    }
  }, [onPasteImage, iframeRef])

  return (
    <iframe
      ref={iframeRef}
      className={className}
      sandbox="allow-scripts allow-same-origin"
      srcDoc={srcDoc}
      style={{ width: '100%', height: 52, border: 0, borderRadius: 8, overflow: 'hidden', background: 'transparent', ...style }}
      aria-label="Composer"
    />
  )
}



