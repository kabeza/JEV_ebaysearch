import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxying keeps the browser same-origin: no CORS, and the API key stays
    // in the server process where it belongs.
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
})
