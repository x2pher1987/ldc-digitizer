// Production equivalent of the dev-only Vite proxy in vite.config.js: keeps
// ANTHROPIC_API_KEY server-side. The client calls same-origin '/api/claude'
// (rewritten to this function by the redirect in netlify.toml); this forwards
// to Anthropic with the key attached, so the key never reaches the browser.
// Requests must come from this site itself (browser fetches always send Origin
// on cross-origin-capable requests; same-origin fetches send it too in modern
// browsers). Without this, the function is a free, unauthenticated proxy to
// your Anthropic key for anyone who finds the URL. Matching must be specific
// to THIS site's hostnames — a bare ".netlify.app" suffix would let any other
// Netlify-hosted site (including an attacker's) pass the check too.
const SITE_NAME = 'ldc-digitizer';
const ALLOWED_HOSTS = [`${SITE_NAME}.netlify.app`, 'localhost:5173'];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const { host } = new URL(origin);
    if (ALLOWED_HOSTS.includes(host)) return true;
    // Deploy previews / branch subdomains: "<hash>--ldc-digitizer.netlify.app"
    return host.endsWith(`--${SITE_NAME}.netlify.app`);
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!isAllowedOrigin(req.headers.get('origin'))) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.text();
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
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
