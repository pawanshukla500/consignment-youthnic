import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/chunk-[hash].js',
        assetFileNames: 'assets/asset-[hash][extname]',
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('firebase')) return 'firebase'
            if (id.includes('lucide-react')) return 'ui'
            if (/(react|react-dom|react-router-dom)/.test(id)) return 'vendor'
          }
        }
      }
    },
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        // Long-lived SSE (/api/sync/events) must not be killed by proxy timeouts
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.url?.includes('/sync/events')) {
              proxyReq.setHeader('Accept', 'text/event-stream')
              proxyReq.setHeader('Cache-Control', 'no-cache')
              proxyReq.setHeader('Connection', 'keep-alive')
            }
          })
          proxy.on('error', (err, req, res) => {
            // Avoid noisy crash dumps for expected SSE disconnects during backend restarts
            if (req.url?.includes('/sync/events') && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')) {
              if (res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' })
                res.end('SSE upstream unavailable')
              }
              return
            }
            console.warn('[vite proxy]', err.code || err.message, req.url)
          })
        },
      },
    },
  },
})
