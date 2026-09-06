import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, 'desktop'),
  base: './',
  publicDir: path.join(root, 'public'),
  resolve: { alias: { '@': root } },
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
  build: {
    outDir: path.join(root, 'desktop-dist'),
    emptyOutDir: true,
  },
});
