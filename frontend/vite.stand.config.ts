/**
 * Vite dev для ЖИВОГО СТЕНДА бота (test/bot-client-stand.ts): прокси /api и /socket.io идут на
 * backend стенда (127.0.0.1:$STAND_PORT, по умолчанию 55491), а НЕ на боевой :4000, как в vite.config.ts.
 *
 *   STAND_VITE_CACHE=/DATA/eb-secret-test-<имя>/vite-cache npx vite --config vite.stand.config.ts
 *
 * STAND_VITE_CACHE — свой кэш зависимостей: в worktree node_modules обычно ссылка на боевое дерево,
 * и общий node_modules/.vite перезаписывать не стоит. Веб ходит в '/api' через прокси только на
 * порту 5173 (core/api/httpClient.ts), поэтому с ПК открывать через туннель на ЛОКАЛЬНЫЙ 5173:
 *   ssh -N -L 127.0.0.1:5173:127.0.0.1:5181 root@stoned.local   →   http://localhost:5173/
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const target = `http://127.0.0.1:${process.env.STAND_PORT || 55491}`

export default defineConfig({
  plugins: [react()],
  ...(process.env.STAND_VITE_CACHE ? { cacheDir: process.env.STAND_VITE_CACHE } : {}),
  server: {
    port: Number(process.env.STAND_VITE_PORT || 5181),
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target, changeOrigin: true, secure: false },
      '/socket.io': { target, ws: true, changeOrigin: true, secure: false },
    },
  },
})
