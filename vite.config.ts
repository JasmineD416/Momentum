import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development: Vite serves the web app on :5173 and passes server routes to the Node server on :8787 (npm run dev starts both).
const server = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': server, '/auth': server, '/u': server, '/hooks': server, '/healthz': server },
  },
});