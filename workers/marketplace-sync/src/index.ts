// Legacy pre-ERP synchronizer. Its public/manual path must not fetch WB or Ozon.
export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, retired: true, successor: 'ERP timer workers' });
    return Response.json({ error: 'Legacy marketplace sync retired; use authenticated ERP jobs' }, { status: 410 });
  },
  scheduled() { console.log('Legacy marketplace sync retired; no outbound calls'); },
};
