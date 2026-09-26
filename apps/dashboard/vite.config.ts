import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, Vite forwards requests: /api → ingest, /gw1 → gateway 1, /gw2 → gateway 2
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/gw1': { target: 'ws://127.0.0.1:8081', ws: true, rewrite: (p) => p.replace(/^\/gw1/, '/ws') },
      '/gw2': { target: 'ws://127.0.0.1:8082', ws: true, rewrite: (p) => p.replace(/^\/gw2/, '/ws') },
    },
  },
});
