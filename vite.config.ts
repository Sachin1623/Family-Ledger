import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(),
      tailwindcss(),
      // The Capacitor app loads its UI live from the Cloud Run backend on every launch
      // (server.url in capacitor.config.ts) rather than from a bundled local copy — that's what
      // lets JS/server fixes ship via a plain redeploy with no Play Store cycle, but it also
      // means the app previously couldn't open at all with zero network: there was nothing to
      // fall back to. This registers a service worker that precaches the app shell (HTML/JS/CSS)
      // and serves it from cache when offline, while still preferring a live network fetch
      // whenever one succeeds — see the networkFirst runtimeCaching entry below. Firestore/API
      // calls are explicitly excluded from caching (NetworkOnly) since serving stale group/
      // expense data offline would be actively wrong, not just unavailable.
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        workbox: {
          navigateFallback: '/index.html',
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
          // Default is 2MiB; the main JS chunk (which bundles the Sudoku puzzle bank for
          // guaranteed offline availability — see today's earlier note) is already ~2.3MB.
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkOnly',
            },
            {
              urlPattern: ({ request }) => request.mode === 'navigate',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'html-shell',
                networkTimeoutSeconds: 4,
              },
            },
          ],
        },
        manifest: false, // public/manifest.json already covers this, no need to generate a second one
      }),
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: false,
    },
  };
});
