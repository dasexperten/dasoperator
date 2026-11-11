/** Parse money only from a structured observed price or an explicit amount statement. */
export function rubMinor(price,currency='RUB'){
 if(!/^(RUB|₽|руб\.?|рублей|р\.?|р)$/iu.test(String(currency).trim()))return null;
 const s=String(price??'').trim().replace(/\s/gu,'').replace(/(?:₽|RUB|руб\.?|рублей|р\.?)$/iu,'').replace(',','.');
 if(!/^\d+(?:\.\d{1,2})?$/.test(s))return null;
 const n=Math.round(Number(s)*100);return n>=5000&&n<=99900?n:null;
}
export function incomingAmount(messages){
 let result=null,lastQuestion=null;
 for(const m of [...messages].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))){
  if(m.direction==='out'){lastQuestion=m.text&&/(?:сумм|цен[ауые]|стоимост|сколько.*корзин)/iu.test(m.text)&&/[?]/.test(m.text)?m:null;continue;}
  if(m.direction!=='in'||!m.text)continue;
  const text=m.text.trim();let values=[...text.matchAll(/(?<!\d)(\d{2,3}(?:[.,]\d{1,2})?)\s*(₽|руб(?:лей|ля|ль|\.)?|р\.?(?![\p{L}]))/giu)].map(v=>rubMinor(v[1]));
  if(!values.length)values=[...text.matchAll(/(?:сумма|к оплате|итого|цена|стоимость|корзина)\s*[:=—-]?\s*(\d{2,3}(?:[.,]\d{1,2})?)(?!\d)/giu)].map(v=>rubMinor(v[1]));
  // Bare digits are never authority. Keep an isolated small numeric line only as a conflict warning.
  const bare=text.split('\n').map(v=>v.trim()).filter(v=>/^\d{2,3}(?:[.,]\d{1,2})?$/.test(v)).map(v=>rubMinor(v)).filter(Boolean);
  const unique=[...new Set(values.filter(Boolean))];
  if(unique.length&&(/(?:или|либо|вместо)\s*\d{2,3}(?!\d)|(?:^|\s)(?:можно|может|если|сколько|старая|раньше)\s+(?:[\p{L}]+\s+){0,2}\d{2,3}(?!\d)/iu.test(text)||/(?<!\d)\d{2,3}(?:[.,]\d{1,2})?\s*(?:₽|руб(?:лей|ля|ль|\.)?|р\.?)?\s*\?(?:\s|$)/iu.test(text))){result={source_message_id:m.id,created_at:m.created_at,amount_minor:null,explicit:false};continue;}
  if(unique.length===1)result={source_message_id:m.id,created_at:m.created_at,amount_minor:unique[0],explicit:true};
  else if(unique.length>1)result={source_message_id:m.id,created_at:m.created_at,amount_minor:null,explicit:false};
  else if(bare.length===1)result={source_message_id:m.id,created_at:m.created_at,amount_minor:bare[0],explicit:Boolean(lastQuestion&&Date.parse(m.created_at)>=Date.parse(lastQuestion.created_at)&&Date.parse(m.created_at)-Date.parse(lastQuestion.created_at)<=86400000),question_message_id:lastQuestion?.id??null};
 }
 return result;
}
// Owner 2026-10-18/2026-11-11: a marketplace cart never shows the seller; only a
// visible different seller (seller==='no') stops it. Slight difference between the
// screenshot and the creator's typed amount (marketplace prices move): take the larger.
const NEAR=0.15;
const AMOUNT_KINDS=new Set(['basket','checkout','order','listing']);
const near=(a,b)=>Math.abs(a-b)<=Math.max(a,b)*NEAR;
export function decideCart(checks,quote){
 const ordered=[...checks].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.attachment_index-b.attachment_index);
 let basket=null,blocked=false;
 for(const c of ordered){
  if(['other','product_photo'].includes(c.kind))continue;
  basket=c;blocked=true;
  const unresolved=(c.unresolved_required??[]).filter(v=>v!=='seller');
  if(AMOUNT_KINDS.has(c.kind)&&c.product==='yes'&&c.amount==='yes'&&c.seller!=='no'&&!unresolved.length){
   const minor=rubMinor(c.observed?.price,c.observed?.currency??'');
   if(minor){basket={...c,amount_minor:minor};blocked=false;}
  }
 }
 if(AMOUNT_KINDS.has(basket?.kind)&&basket.seller==='no')return {status:'pending',reason:'seller_different',source_message_id:basket.source_message_id,amount_minor:null};
 const typed=quote?.explicit&&quote.amount_minor?quote:null;
 // A later unclear price question from the creator ("Можно 492руб?") is answered, never guessed.
 const unclearLater=quote&&!typed&&basket&&Date.parse(quote.created_at)>Date.parse(basket.created_at);
 if(basket&&!blocked&&unclearLater)return{status:'pending',reason:'amount_conflict',source_message_id:basket.source_message_id,amount_minor:null,quote};
 if(basket&&!blocked){
  if(typed){
   if(typed.amount_minor===basket.amount_minor||near(typed.amount_minor,basket.amount_minor)){
    const larger=Math.max(typed.amount_minor,basket.amount_minor);
    return larger===basket.amount_minor
     ?{status:'confirmed',authority:'image',source_message_id:basket.source_message_id,attachment_index:basket.attachment_index,amount_minor:larger}
     :{status:'confirmed',authority:'incoming_text',source_message_id:typed.source_message_id,amount_minor:larger};
   }
   return{status:'pending',reason:'amount_conflict',source_message_id:basket.source_message_id,amount_minor:null,quote:typed};
  }
  return{status:'confirmed',authority:'image',source_message_id:basket.source_message_id,attachment_index:basket.attachment_index,amount_minor:basket.amount_minor};
 }
 if(typed)return{status:'confirmed',authority:'incoming_text',source_message_id:typed.source_message_id,amount_minor:typed.amount_minor};
 if(blocked)return{status:'pending',reason:'current_image_unresolved',amount_minor:null};
 return{status:'pending',reason:'amount_unconfirmed',amount_minor:null};
}
