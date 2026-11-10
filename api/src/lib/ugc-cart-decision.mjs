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
export function decideCart(checks,quote){
 // New seller-only screens do not replace a basket. A new uncertain image does.
 const ordered=[...checks].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||a.attachment_index-b.attachment_index);
 let basket=null,blocked=false;
 for(const c of ordered){
  if(['other','product_photo'].includes(c.kind))continue;
  basket=c;blocked=true;
  if(c.kind==='basket'&&c.product==='yes'&&c.amount==='yes'&&(c.seller==='yes'||c.seller==='unknown'&&c.seller_evidence==='creator_answer'&&!!c.seller_source?.answer_id)&&!(c.unresolved_required??[]).length){
   const minor=rubMinor(c.observed?.price,c.observed?.currency??'');
   if(minor){basket={...c,amount_minor:minor};blocked=false;}
  }
 }
 const currentQuote=quote&&(!basket||Date.parse(quote.created_at)>=Date.parse(basket.created_at))?quote:null;
 if(basket?.kind==='basket'&&basket.seller!=='yes'&&!(basket.seller==='unknown'&&basket.seller_evidence==='creator_answer'&&basket.seller_source?.answer_id))return {status:'pending',reason:'seller_unconfirmed',source_message_id:basket.source_message_id,amount_minor:null};
 if(currentQuote?.explicit&&currentQuote.amount_minor&&(!basket||Date.parse(currentQuote.created_at)>Date.parse(basket.created_at)))return{status:'confirmed',authority:'incoming_text',source_message_id:currentQuote.source_message_id,amount_minor:currentQuote.amount_minor};
 if(basket&&!blocked){
  if(currentQuote&&(currentQuote.amount_minor!==basket.amount_minor))return{status:'pending',reason:'amount_conflict',source_message_id:basket.source_message_id,amount_minor:null,quote:currentQuote};
  return{status:'confirmed',authority:'image',source_message_id:basket.source_message_id,attachment_index:basket.attachment_index,amount_minor:basket.amount_minor};
 }
 if(blocked)return{status:'pending',reason:'current_image_unresolved',amount_minor:null};
 if(currentQuote?.explicit&&currentQuote.amount_minor)return{status:'confirmed',authority:'incoming_text',source_message_id:currentQuote.source_message_id,amount_minor:currentQuote.amount_minor};
 return{status:'pending',reason:'amount_unconfirmed',amount_minor:null};
}
