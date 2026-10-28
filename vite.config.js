import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/tests/**'] },
    // used only by the browser tests; the desktop app talks to Rust directly
    proxy: { '/api': 'http://127.0.0.1:5174' },
  },
  build: { target: 'es2022' },
});
