// Local-only read adapter. WB authentication and rate limits stay in ERP.
const products = { schwarz: [34396247, 198719422], termo: [34456493, 805033249] };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const product = products[url.searchParams.get('sku')];
    const kind = url.searchParams.get('kind');
    if (request.method !== 'GET' || url.pathname !== '/inspect' || !product || !['min', 'config', 'limits'].includes(kind)) {
      return new Response('Unsupported read', { status: 400 });
    }
    if (!env.WB_GATEWAY) return new Response('ERP gateway unavailable', { status: 503 });
    const [advertId, nmId] = product;
    let target = 'https://advert-api.wildberries.ru/api/advert/v1/config';
    let init = { method: 'GET' };
    if (kind === 'limits') target = `https://advert-api.wildberries.ru/api/advert/v0/daily-limits?advertIds=${advertId}`;
    if (kind === 'min') {
      target = 'https://advert-api.wildberries.ru/api/advert/v1/bids/min';
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ advert_id: advertId, nm_ids: [nmId], payment_type: 'cpc', placement_types: ['search'] }) };
    }
    const response = await env.WB_GATEWAY.fetch(target, init);
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } });
  }
};
