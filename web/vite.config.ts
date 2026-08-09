import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    // In dev the dashboard runs on Vite and talks to the Bun service.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
