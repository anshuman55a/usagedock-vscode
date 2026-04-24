import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'webview'),
  build: {
    outDir: path.resolve(__dirname, 'dist', 'webview'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
