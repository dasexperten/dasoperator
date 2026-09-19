import { wbRead } from "./wb-egress.mjs";
/**
 * Read-only marketplace API helpers for fleet craft Workers.
 * Secrets stay in Worker env (wrangler secret) — never hardcode.
 */

export function hasWbSecrets(env) {
  return Boolean(env.WB_GATEWAY || String(env.WB_API_TOKEN || "").trim());
}

/** Ozon client id may be number-like string */
export function ozonClientId(env) {
  return String(env.OZON_CLIENT_ID || "").trim();
}

export async function wbFetch(env, base, path, { method = "GET", query = "" } = {}) {
  const token = env.WB_GATEWAY ? "erp-managed" : String(env.WB_API_TOKEN || "").trim();
  if (!token) throw new Error("WB_API_TOKEN missing");
  const url = `${base}${path}${query ? (path.includes("?") ? "&" : "?") + query : ""}`;
  const res = await wbRead(env, url, {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "arina-wb/1.0 (+dasexperten fleet)",
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { ok: res.ok, status: res.status, body };
}


export async function ozonFetch(env, path, body) {
  const key = String(env.OZON_API_KEY || "").trim();
  const clientId = ozonClientId(env);
  if (!key || !clientId) throw new Error("OZON_API_KEY or OZON_CLIENT_ID missing");
  const res = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": key,
      "Content-Type": "application/json",
      "User-Agent": "dasha-ozon/1.0 (+dasexperten fleet)",
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

