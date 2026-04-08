import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const isElectron = process.env.BUILD_TARGET === 'electron';

export default defineConfig({
  // For Electron, output to electron/dist/renderer so electron-builder can bundle it
  build: isElectron ? {
    outDir: '../../electron/dist/renderer',
    emptyOutDir: true,
  } : undefined,
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
