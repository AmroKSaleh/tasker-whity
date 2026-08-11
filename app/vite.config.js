import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
  },
  server: {
    // TDE-816: src/lib/flowExceptions.js imports the MCP's own exception derivation from
    // supabase/functions/mcp/ so the web and the agent cannot drift. That path is outside
    // this Vite root, so the dev server has to be allowed to serve the repo root.
    fs: { allow: ['..'] },
  },
})
