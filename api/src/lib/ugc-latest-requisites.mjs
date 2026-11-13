import {detectRequisites} from './ugc-requisites-detect.mjs';
import {cleanRequisites} from './ig-dm-reply-guard.mjs';
const PHONE=/(?:\+?7|8)[\s()-]*9(?:[\s()-]*\d){9}/;
const BANK=/сбер|т[-\s]?банк|тинькоф|тиньков|tbank|tinkoff|втб|vtb|озон|ozon|альфа|alfa|райф|газпром|совком|мтс|mts|почта|росбанк|яндекс|yandex|открыти|уралсиб|россельхоз/ig;
function singleBank(text){
 const ids=[...new Set((text.match(BANK)??[]).map(bank=>cleanRequisites({phone:'+79990000000',bank,first_name:'Анна',amount_rub:100})?.bank).filter(Boolean))];
 return ids.length===1?ids[0]:null;
}
// Owner 2026-11-12 (svetlanakogai2018, «сбер озон»): a blogger who names two banks means either works.
// Owner 2026-11-12: «if tinkov is named then tinkof or t-bank, if not then the first one». The button
// appears at once; she is not asked to choose.
const TBANK=/т[-\s]?банк|тинькоф|тиньков|tbank|tinkoff/i;
function firstBank(text){
 const t=text.match(TBANK);
 if(t){const id=cleanRequisites({phone:'+79990000000',bank:t[0],first_name:'Анна',amount_rub:100})?.bank;if(id)return id;}
 for(const m of text.matchAll(BANK)){const id=cleanRequisites({phone:'+79990000000',bank:m[0],first_name:'Анна',amount_rub:100})?.bank;if(id)return id;}
 return null;
}
/** Only short original detail clusters. A later explicit single-bank correction wins.
 * No profile name, outgoing acknowledgement or amount is interpreted as requisites. */
// Owner 2026-11-12 (shh_aze, madi___na111): «when paid is paid». Our own transfer message after
// the details means they are used up — whatever the ERP list says (a misspelled card, a payment
// from before the list existed). Old details never make a new button either.
const PAID_NOTICE=/перевел\S*\s+(?:вам\s+)?(?:\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:₽|руб)|деньги)/i;
export const REQUISITES_MAX_AGE_MS=14*86400000;
export function paidAfter(messages,at){
 return (messages??[]).some(m=>m.direction==='out'&&Date.parse(m.created_at)>at&&PAID_NOTICE.test(String(m.text??'')));
}
// Owner 2026-11-13: «one detail missing — she must ask for the next one, not ignore it».
// A blogger often sends the phone, then the bank twenty minutes later after our question, then the
// name. The details of the current round count wherever they are: after our last transfer notice and
// within three days of her newest message. Whatever is still missing is named, so Diana asks for it.
const ROUND_MS=72*3600000;
const BANK_HINT=/банк|сбер|тинькоф|тиньков|т[-\s]?банк|tbank|tinkoff|втб|vtb|альфа|alfa|совком|райф|газпром|росбанк|открыти|уралсиб|россельхоз/i;
const BANK_ALONE=/^\s*(?:озон|ozon|яндекс|yandex|мтс|mts|почта)(?:\s*банк)?\s*[.!]?\s*$/i;
const FOREIGN_PHONE=/(?:^|[^\d])(?:\+?(?:375|380|996|998|992|994|374|995|373|993)[\d\s()-]{7,}|(?:\+?7|8)[\s()-]*7(?:[\s()-]*\d){9})/;
const NAME_SHAPE=/^\s*[А-ЯЁ][а-яё]+(?:[\s-]+[А-ЯЁ][а-яё]*\.?){0,2}\s*[.!]?\s*$/;
const ASKED_NAME=/имя|имени|реквизит|получател|номер телефона/i;
const at=m=>Date.parse(m.created_at);
function nameIn(text){
 const cased=String(text).replace(/(^|[\s,.;:])([а-яё])([а-яё]{2,})/g,(_,a,b,c)=>a+b.toUpperCase()+c);
 const r=detectRequisites(['+79990000000','сбер',cased.replace(PHONE,' ')]);
 const n=r?String(r.first_name??'').trim():'';
 // Verbs and adverbs are never a name («Сделаю», «Скинется», «Удобно», «Есть»).
 return n&&!/(?:но|ся|сь|ю|ть|ем|ет|ит|ут|ют|ло|ли|ьму|жу|шу)$/i.test(n)&&!/^(?:москва|люберцы|петербург|санкт|спб|казань|саранск|ростов|краснодар|екатеринбург|новосибирск|самара|уфа|пермь|воронеж|россия|область|город)$/i.test(n)?n:null;
}
/** The current round's details: complete, or exactly which of phone, bank and name are missing. */
export function roundRequisites(messages){
 const all=(messages??[]).filter(m=>Number.isFinite(at(m))).sort((a,b)=>at(a)-at(b));
 const incoming=all.filter(m=>m.direction==='in'&&String(m.text??'').trim());
 if(!incoming.length)return{complete:null,missing:['phone','bank','name'],first_name:null,foreign:false};
 const newest=at(incoming[incoming.length-1]);
 const paid=all.filter(m=>m.direction==='out'&&PAID_NOTICE.test(String(m.text??''))).map(at);
 const from=Math.max(newest-ROUND_MS,paid.length?Math.max(...paid)+1:-Infinity);
 const rows=incoming.filter(m=>at(m)>=from&&m.text.length<=240);
 const foreign=rows.some(m=>FOREIGN_PHONE.test(m.text)&&!PHONE.test(m.text));
 const phoneRow=[...rows].reverse().find(m=>PHONE.test(m.text))??null;
 const bankRow=[...rows].reverse().find(m=>(PHONE.test(m.text)||BANK_HINT.test(m.text)||BANK_ALONE.test(m.text))&&!/\?/.test(m.text)&&firstBank(m.text))??null;
 const askedBefore=m=>{const prev=all.filter(x=>x.direction==='out'&&at(x)<at(m)).pop();return Boolean(prev&&ASKED_NAME.test(String(prev.text??'')));};
 let nameRow=null,first=null;
 for(const m of [...rows].reverse()){
  // A name counts only beside the phone or bank, within ten minutes of the phone, or as her answer
  // right after we asked for it.
  if(!(PHONE.test(m.text)||(BANK_HINT.test(m.text)&&m.text.length<=80)||(NAME_SHAPE.test(m.text)&&(askedBefore(m)||(phoneRow&&Math.abs(at(m)-at(phoneRow))<=600000)))))continue;
  const n=nameIn(m.text);if(n){nameRow=m;first=n;break;}
 }
 const missing=[];
 if(!phoneRow)missing.push('phone');if(!bankRow)missing.push('bank');if(!first)missing.push('name');
 if(missing.length)return{complete:null,missing,first_name:first,foreign};
 const phone=phoneRow.text.match(PHONE)[0].replace(/\D/g,'').replace(/^8/,'7');
 const used=[phoneRow,bankRow,nameRow];
 return{complete:{phone:'+'+phone,bank:firstBank(bankRow.text),first_name:first,last_name:null,source_message_ids:[...new Set(used.map(m=>m.id))],source_at:Math.max(...used.map(at)),cycle_message_id:phoneRow.id},missing:[],first_name:first,foreign:false};
}
export function latestRequisites(messages){
 const rows=messages.filter(m=>m.direction==='in'&&m.text?.trim()).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
 let result=null;
 for(let i=0;i<rows.length;i++){
  if(!PHONE.test(rows[i].text))continue;
  const at=Date.parse(rows[i].created_at);
  result=null; // Never fall back to older details after a newer incomplete/ambiguous phone.
  const phone=rows[i].text.match(PHONE)[0].replace(/\D/g,'').replace(/^8/,'7');
  const cluster=rows.slice(Math.max(0,i-2),i+3).filter(m=>Math.abs(Date.parse(m.created_at)-at)<=600000&&m.text.length<=240).filter(m=>!m.text.match(BANK)||PHONE.test(m.text)||/банк|сбер|тинькофф|тиньков|втб|альфа|совком/i.test(m.text)||/^\s*(?:озон|ozon)\s*$/i.test(m.text));
  const selected=cluster.filter(m=>{const p=m.text.match(PHONE)?.[0].replace(/\D/g,'').replace(/^8/,'7');return !p||p===phone;});
  const text=selected.map(m=>m.text).join('\n');
  if(!firstBank(text))continue;
  // Owner 2026-11-11 (elwira.karimova2013): «Каримова эльвира васфирахмановна» — a name
  // typed in lowercase is still a name. Capitalise Cyrillic words before reading names.
  const cased=t=>t.replace(/(^|[\s,.;:])([а-яё])([а-яё]{2,})/g,(_,a,b,c)=>a+b.toUpperCase()+c);
  let r=detectRequisites(selected.map(m=>m.text));
  if(!r?.first_name)r=detectRequisites(selected.map(m=>cased(m.text)))??r;
  // Owner 2026-11-12: «remove the name rule» — no surname guessing. Phone, bank and any name
  // in the cluster make the button; the Owner checks the name himself before paying.
  if(r&&String(r.first_name??r.last_name??'').trim())result={...r,bank:firstBank(text)??r.bank,first_name:String(r.first_name??r.last_name).trim(),source_message_ids:selected.map(m=>m.id),source_at:Math.max(...selected.map(m=>Date.parse(m.created_at))),cycle_message_id:rows[i].id};
 }
 if(!result){
  const round=roundRequisites(messages);
  if(!round.complete||paidAfter(messages,round.complete.source_at))return null;
  return round.complete;
 }
 for(const row of rows){
  if(Date.parse(row.created_at)<=result.source_at||row.text.length>100||/\?|или|либо|можно|могу/i.test(row.text))continue;
  const phone=row.text.match(PHONE)?.[0].replace(/\D/g,'').replace(/^8/,'7');
  if(phone&&phone!==result.phone.replace(/\D/g,''))continue;
  if(!/банк|сбер|тинькофф|тиньков|втб|альфа|совком/i.test(row.text)&&!/^\s*(?:озон|ozon)\s*$/i.test(row.text))continue;
  const bank=singleBank(row.text);
  if(bank){result.bank=bank;result.source_message_ids.push(row.id);result.source_at=Date.parse(row.created_at);}
 }
 result.source_message_ids=[...new Set(result.source_message_ids)].slice(-20);
 if(paidAfter(messages,result.source_at))return null;
 // Age is measured against the newest message in the chat, so the check is the same in every run.
 const newest=Math.max(...(messages??[]).map(m=>Date.parse(m.created_at)).filter(Number.isFinite));
 if(newest-result.source_at>REQUISITES_MAX_AGE_MS)return null;
 return result;
}
