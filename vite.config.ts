import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API_PORT = Number(process.env.PORT || 8787);

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/client'),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true } },
  },
  worker: { format: 'es' },
});
