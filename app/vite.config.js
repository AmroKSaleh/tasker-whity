import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8010',
        changeOrigin: false,
      },
    },
  },
})
