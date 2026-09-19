// Owner 2026-09-19: WB is FBS-only. No warehouse-stock API calls.
export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, retired: true, reason: 'WB is FBS-only; warehouse-stock sync disabled' });
    return Response.json({ ok: false, error: 'WB warehouse-stock sync retired; FBS-only' }, { status: 410 });
  },
  scheduled() { console.log('WB warehouse-stock sync retired; no outbound requests'); },
};
