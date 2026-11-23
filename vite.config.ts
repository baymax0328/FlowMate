import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.FLOWMATE_API_TARGET || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: true, target: 'es2022' },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.FLOWMATE_DEV_PORT || 5173),
    proxy: {
      '/api/live': { target: API, ws: true, changeOrigin: true },
      '/api': { target: API, changeOrigin: true },
    },
  },
});
