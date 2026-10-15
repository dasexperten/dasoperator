// Local task reader. Authentication and throttling stay in ERP WbGateway.
// Read-only; no lifecycle changes, funding, bid changes or token copies.
const routes = new Map([
  ['campaigns', ['GET','/adv/v1/promotion/count']],
  ['details', ['GET','/api/advert/v2/adverts']],
  ['clusters', ['POST','/adv/v0/normquery/list']],
  ['minus', ['POST','/adv/v0/normquery/get-minus']],
  ['bids', ['POST','/adv/v0/normquery/get-bids']],
  ['stats', ['POST','/adv/v0/normquery/stats']],
]);
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(request.method==='POST'&&url.pathname==='/catalog'&&!url.search) {
      const response=await env.WB_GATEWAY.fetch('https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          selectedPeriod:{start:'2026-10-08',end:'2026-10-14'},pastPeriod:{start:'2026-10-01',end:'2026-10-07'},
          nmIds:[],brandNames:[],subjectIds:[],tagIds:[],skipDeletedNm:false,limit:1000,offset:0
        })
      });
      return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')||'application/json','Cache-Control':'no-store'}});
    }
    if(request.method!=='POST'||url.pathname!=='/read'||url.search) return new Response('Unsupported read',{status:400});
    let input;try{input=await request.json();}catch{return new Response('Invalid JSON',{status:400});}
    const route=routes.get(input.kind);
    if(!route||!env.WB_GATEWAY)return new Response('Unsupported read or missing ERP binding',{status:400});
    let target='https://advert-api.wildberries.ru'+route[1];
    const init={method:route[0]};
    if(input.kind==='details') {
      if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>50||!input.ids.every(x=>Number.isSafeInteger(x)&&x>0))return new Response('Invalid ids',{status:400});
      target+='?ids='+input.ids.join(',');
    }
    if(route[0]==='POST') {
      const body=input.body;
      if(!body||!Array.isArray(body.items)||!body.items.length||body.items.length>100)return new Response('Invalid items',{status:400});
      if(input.kind==='stats'&&(!/^\d{4}-\d{2}-\d{2}$/.test(body.from)||!/^\d{4}-\d{2}-\d{2}$/.test(body.to)))return new Response('Invalid dates',{status:400});
      for(const x of body.items){const a=x.advert_id??x.advertId,n=x.nm_id??x.nmId;if(!Number.isSafeInteger(a)||a<=0||!Number.isSafeInteger(n)||n<0)return new Response('Invalid pair',{status:400});}
      init.headers={'Content-Type':'application/json'};init.body=JSON.stringify(body);
    }
    const response=await env.WB_GATEWAY.fetch(target,init);
    return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')||'application/json','Cache-Control':'no-store','Retry-After':response.headers.get('Retry-After')||'','X-WB-Gateway':response.headers.get('X-WB-Gateway')||''}});
  }
};
