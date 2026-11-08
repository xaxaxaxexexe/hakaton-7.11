import { defineConfig } from 'vite';

// Локально /api проксируется на Edge Function, запущенную через Deno (порт 8000).
// На Vercel тот же путь переписывается на Supabase (см. vercel.json).
const api = { '/api': { target: process.env.API_URL || 'http://localhost:8000', changeOrigin: true } };
export default defineConfig({
  server: { proxy: api },
  preview: { proxy: api },
  build: { chunkSizeWarningLimit: 900 },
});
