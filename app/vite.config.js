import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    // app/dist/.gitkeep is tracked (Task 1 added it so Docker's bind mount
    // to /app/public/spa never creates a root-owned directory on first
    // `docker compose up`). Vite's default emptyOutDir wipes the whole
    // directory — .gitkeep included — before every build. Everything else
    // in app/dist/ is already gitignored, so disabling emptyOutDir is safe
    // and avoids silently deleting a tracked file on every build.
    emptyOutDir: false,
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
