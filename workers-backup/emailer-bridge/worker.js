/**
 * emailer-bridge — Cloudflare Worker that proxies POST requests
 * to Das Experten Apps Script Emailer (action-based dispatcher).
 *
 * Why this exists: Claude's sandbox has TLS inspection, which Google
 * Apps Script blocks. Cloudflare Workers run on regular infrastructure
 * that Google accepts. This Worker is a transparent pass-through.
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyYhBHfkhvU6anAJeP6l5u-kmWAbP11RhXt0JHHPTVHpGjebsC7Z9LWEy7EszIe8vIB/exec';

export default {
  async fetch(request, env, ctx) {
    // Only POST is meaningful here
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({
          ok: true,
          message: 'emailer-bridge is alive. Send POST with JSON payload to use Emailer.'
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    try {
      // Forward the JSON body as-is to Apps Script
      const body = await request.text();

      const upstream = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        redirect: 'follow'
      });

      const responseText = await upstream.text();

      return new Response(responseText, {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Bridge error: ' + (err.message || String(err))
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
};