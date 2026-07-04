// browser-run-bridge — Cloudflare Browser Rendering REST gateway for Das Experten
// Action-based dispatcher. Auth: Bearer BRIDGE_SECRET.
// Actions: screenshot, extract_text
// Uses Browser Rendering REST API (Quick Actions). Cloudflare wraps /content responses
// in {success, result, meta} envelope — we unwrap before HTML→text conversion.

const PUBLIC_R2_BASE = "https://pub-6cf4bb0064824477882515a6afa6e43f.r2.dev";
const MAX_WAIT_MS = 10000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const ACCOUNT_ID = "081ddb85cb399ad62a70210328d744fc";
const BR_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/browser-rendering`;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.BRIDGE_SECRET}`) return json({ error: "unauthorized" }, 401);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "bad_request", detail: "invalid_json" }, 400); }

    const { action, url, options } = body || {};
    if (!action) return json({ error: "bad_request", detail: "missing_action" }, 400);
    if (!url) return json({ error: "bad_request", detail: "missing_url" }, 400);
    if (!isValidUrl(url)) return json({ error: "bad_request", detail: "invalid_url" }, 400);

    const opts = sanitizeOptions(options);

    try {
      if (action === "screenshot") return await doScreenshot(env, url, opts);
      if (action === "extract_text") return await doExtractText(env, url, opts);
      return json({ error: "bad_request", detail: `unknown_action:${action}` }, 400);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const isRateLimit = /rate.?limit|429/i.test(msg);
      const isBrowserErr = /browser|navigation|timeout|net::|render/i.test(msg);
      const status = isRateLimit ? 429 : (isBrowserErr ? 502 : 500);
      const code = isRateLimit ? "rate_limited" : (isBrowserErr ? "browser_failed" : "internal");
      return json({ error: code, detail: msg }, status);
    }
  }
};

async function doScreenshot(env, url, opts) {
  const t0 = Date.now();

  const payload = {
    url,
    viewport: opts.viewport,
    screenshotOptions: { fullPage: true, type: "png" }
  };
  if (opts.wait_ms > 0) payload.waitForTimeout = opts.wait_ms;

  const res = await fetch(`${BR_BASE}/screenshot`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_BROWSER_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const browserMs = parseInt(res.headers.get("X-Browser-Ms-Used") || "0", 10) || (Date.now() - t0);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`browser_render_${res.status}: ${errText.slice(0, 300)}`);
  }

  const png = new Uint8Array(await res.arrayBuffer());
  const key = buildKey("screenshot", url, "png");
  await env.OUTPUT.put(key, png, {
    httpMetadata: { contentType: "image/png" }
  });

  return json({
    ok: true,
    action: "screenshot",
    url: `${PUBLIC_R2_BASE}/${key}`,
    key,
    size_bytes: png.byteLength,
    browser_ms_used: browserMs
  });
}

async function doExtractText(env, url, opts) {
  const t0 = Date.now();

  const payload = { url, viewport: opts.viewport };
  if (opts.wait_ms > 0) payload.waitForTimeout = opts.wait_ms;

  const res = await fetch(`${BR_BASE}/content`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_BROWSER_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const browserMs = parseInt(res.headers.get("X-Browser-Ms-Used") || "0", 10) || (Date.now() - t0);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`browser_render_${res.status}: ${errText.slice(0, 300)}`);
  }

  // Cloudflare /content returns either raw HTML OR JSON envelope { success, result, meta }
  const ctype = res.headers.get("Content-Type") || "";
  let html;
  if (ctype.includes("application/json")) {
    const env_ = await res.json();
    if (env_ && env_.success && typeof env_.result === "string") {
      html = env_.result;
    } else {
      throw new Error(`browser_render_envelope: ${JSON.stringify(env_).slice(0,300)}`);
    }
  } else {
    html = await res.text();
  }

  const text = htmlToText(html);

  return json({
    ok: true,
    action: "extract_text",
    url,
    text,
    char_count: text.length,
    browser_ms_used: browserMs
  });
}

function htmlToText(html) {
  let s = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|article|section)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ")
       .replace(/&amp;/g, "&")
       .replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function sanitizeOptions(o) {
  const out = { viewport: { ...DEFAULT_VIEWPORT }, wait_ms: 0 };
  if (o && typeof o === "object") {
    if (o.viewport && typeof o.viewport === "object") {
      const w = Number(o.viewport.width);
      const h = Number(o.viewport.height);
      if (Number.isFinite(w) && w > 0 && w <= 3840) out.viewport.width = Math.floor(w);
      if (Number.isFinite(h) && h > 0 && h <= 2160) out.viewport.height = Math.floor(h);
    }
    const wait = Number(o.wait_ms);
    if (Number.isFinite(wait) && wait > 0) out.wait_ms = Math.min(MAX_WAIT_MS, Math.floor(wait));
  }
  return out;
}

function buildKey(prefix, url, ext) {
  const date = new Date().toISOString().slice(0, 10);
  const hash = simpleHash(url);
  const ts = Date.now();
  return `${prefix}/${date}/${hash}-${ts}.${ext}`;
}

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(8, "0");
}

function isValidUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
