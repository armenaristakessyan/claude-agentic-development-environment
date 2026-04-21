import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const isElectron = process.env.BUILD_TARGET === 'electron';

// Root package.json is the shipped-app version (electron-builder uses it too).
const rootPkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  // Use terser for minification — esbuild mangles xterm.js's compiled const-enum
  // IIFE in requestMode (CSI DECRQM), causing a ReferenceError when TUIs like the
  // claude CLI query terminal capabilities on startup.
  build: {
    minify: 'terser',
    ...(isElectron ? {
      outDir: '../../electron/dist/renderer',
      emptyOutDir: true,
    } : {}),
  },
  plugins: [
    react(),
    tailwindcss(),
    // Skip PWA in Electron builds — Electron handles offline/caching natively
    ...(!isElectron ? [VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true,
      },
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'Agentic Development Environment',
        short_name: 'ADE',
        description: 'Agentic Development Environment — orchestrate multiple Claude Code instances',
        theme_color: '#0d0d0d',
        background_color: '#0d0d0d',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Don't cache API calls or websocket — only static assets
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/localhost.*\/api\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https?:\/\/localhost.*\/socket\.io/,
            handler: 'NetworkOnly',
          },
        ],
      },
    })] : []),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3200',
      '/socket.io': {
        target: 'http://localhost:3200',
        ws: true,
      },
    },
  },
});
