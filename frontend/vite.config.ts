import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// public/updates/ (гигабайты VPN-инсталляторов) nginx раздаёт напрямую из public/
// (location ^~ /updates/), копия в dist/ не используется никогда. У Vite нет фильтра
// для copyPublicDir, поэтому копируем publicDir в dist сами, пропуская updates/.
function copyPublicDirWithoutUpdates(): Plugin {
  let publicDir = ''
  let outDir = ''
  return {
    name: 'copy-public-dir-without-updates',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      if (!publicDir || !fs.existsSync(publicDir)) return
      const skip = path.join(publicDir, 'updates')
      fs.cpSync(publicDir, outDir, {
        recursive: true,
        filter: (src) => src !== skip && !src.startsWith(skip + path.sep),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), copyPublicDirWithoutUpdates()],
  build: {
    // копирование public/ делает copyPublicDirWithoutUpdates (без updates/)
    copyPublicDir: false,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react'
          }
          if (id.includes('node_modules/socket.io-client')) {
            return 'vendor-socket'
          }
          if (id.includes('node_modules/tweetnacl') || id.includes('node_modules/@noble/hashes')) {
            return 'vendor-crypto'
          }
          if (id.includes('node_modules/@tanstack/react-query')) {
            return 'vendor-query'
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: 'localhost',
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
