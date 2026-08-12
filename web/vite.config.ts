import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /**
   * Absolute, not './'.
   *
   * Relative asset URLs resolve against the current path, which was harmless
   * while every page was served at '/', but breaks the moment a route has
   * depth: reloading /batch/<id> asks for /batch/assets/index-*.js and gets a
   * 404 and a blank page. The app is always served from the domain root, so
   * '/' is correct and depth-proof.
   */
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    // In dev the dashboard runs on Vite and talks to the Bun service.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
