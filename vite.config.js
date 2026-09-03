import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Dev-only proxy: keeps the Anthropic API key server-side. The browser calls
// same-origin '/api/claude'; this middleware attaches the key and forwards
// to Anthropic. The key is read from .env (ANTHROPIC_API_KEY) and never
// reaches client-side code.
function claudeProxyPlugin(apiKey) {
  return {
    name: 'claude-proxy',
    configureServer(server) {
      server.middlewares.use('/api/claude', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        if (!apiKey) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set in .env' }));
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString('utf8');

          const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body,
          });

          const text = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(text);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      react(),
      claudeProxyPlugin(env.ANTHROPIC_API_KEY),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        // Never let the service worker cache /api/claude — it must always hit
        // the network (the dev proxy or Netlify function), never a stale scan result.
        workbox: {
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: /^\/api\/claude/,
              handler: 'NetworkOnly',
            },
          ],
        },
        manifest: {
          name: 'LDC Digitizer',
          short_name: 'LDC Digitizer',
          description: 'Digitize Bureau of Lands Lot Data Computation forms into AutoCAD, QGIS, and KML outputs.',
          start_url: '/',
          display: 'standalone',
          background_color: '#020617',
          theme_color: '#020617',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
      }),
    ],
  };
});
