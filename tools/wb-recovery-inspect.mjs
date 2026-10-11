// Local recovery adapter. WB authentication and rate limits stay in ERP.
const products = { schwarz: [34396247, 198719422], termo: [34456493, 805033249] };
let draftCreated = false;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Preparation only: fixed unfunded draft; never top up or launch here.
    if (request.method === 'POST' && url.pathname === '/draft-schwarz' && url.search === '' && request.headers.get('X-Recovery-Action') === 'unfunded-schwarz-261011') {
      if (draftCreated) return new Response('Draft creation already attempted; inspect result before retry', { status: 409 });
      if (!env.WB_GATEWAY) return new Response('ERP gateway unavailable', { status: 503 });
      draftCreated = true;
      const result = await env.WB_GATEWAY.fetch('https://advert-api.wildberries.ru/adv/v2/seacat/save-ad', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SCHWARZ recovery 261011 unfunded test', nms: [198719422], bid_type: 'manual', payment_type: 'cpc', placement_types: ['search'] })
      });
      return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    // One explicit cost reduction, never a budget increase or campaign restart.
    if (request.method === 'POST' && url.pathname === '/reduce-termo' && url.search === '' && request.headers.get('X-Recovery-Action') === 'termo-10-to-7') {
      if (!env.WB_GATEWAY) return new Response('ERP gateway unavailable', { status: 503 });
      const current = await env.WB_GATEWAY.fetch('https://advert-api.wildberries.ru/api/advert/v2/adverts?ids=34456493');
      if (!current.ok) return new Response(await current.text(), { status: current.status });
      const campaign = (await current.json()).adverts?.find(x => x.id === 34456493);
      const item = campaign?.nm_settings?.find(x => x.nm_id === 805033249);
      if (item?.bids_kopecks?.search === 700) return Response.json({ alreadyReduced: true });
      if (campaign?.status !== 9 || campaign?.settings?.payment_type !== 'cpc' || item?.bids_kopecks?.search !== 1000) return new Response('Campaign changed; inspect before acting', { status: 409 });
      const result = await env.WB_GATEWAY.fetch('https://advert-api.wildberries.ru/api/advert/v1/bids', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bids: [{ advert_id: 34456493, nm_bids: [{ nm_id: 805033249, bid_kopecks: 700, placement: 'search' }] }] })
      });
      return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    const product = products[url.searchParams.get('sku')];
    const kind = url.searchParams.get('kind');
    if (request.method !== 'GET' || url.pathname !== '/inspect' || !product || !['min', 'config', 'limits', 'campaign'].includes(kind)) {
      return new Response('Unsupported read', { status: 400 });
    }
    if (!env.WB_GATEWAY) return new Response('ERP gateway unavailable', { status: 503 });
    const [advertId, nmId] = product;
    let target = 'https://advert-api.wildberries.ru/api/advert/v1/config';
    let init = { method: 'GET' };
    if (kind === 'campaign') target = `https://advert-api.wildberries.ru/api/advert/v2/adverts?ids=${advertId}`;
    if (kind === 'limits') target = `https://advert-api.wildberries.ru/api/advert/v0/daily-limits?advertIds=${advertId}`;
    if (kind === 'min') {
      target = 'https://advert-api.wildberries.ru/api/advert/v1/bids/min';
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ advert_id: advertId, nm_ids: [nmId], payment_type: 'cpc', placement_types: ['search'] }) };
    }
    const response = await env.WB_GATEWAY.fetch(target, init);
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } });
  }
};
