import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

// Временный тест: рисует ли @tanstack/react-virtual вообще на этом React 19.2.6.
export function VirtualTest() {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: 50,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 5,
  })
  return (
    <div ref={parentRef} data-vtest style={{ height: 300, overflow: 'auto', border: '2px solid lime', background: '#111' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 40, transform: `translateY(${vi.start}px)`, borderBottom: '1px solid #444', padding: 8, color: 'lime' }}
          >
            VTEST ROW {vi.index}
          </div>
        ))}
      </div>
    </div>
  )
}
