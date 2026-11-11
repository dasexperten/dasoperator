import {detectRequisites} from './ugc-requisites-detect.mjs';
import {cleanRequisites} from './ig-dm-reply-guard.mjs';
const PHONE=/(?:\+?7|8)[\s()-]*9(?:[\s()-]*\d){9}/;
const BANK=/сбер|т[-\s]?банк|тинькоф|тиньков|tbank|tinkoff|втб|vtb|озон|ozon|альфа|alfa|райф|газпром|совком|мтс|mts|почта|росбанк|яндекс|yandex|открыти|уралсиб|россельхоз/ig;
function singleBank(text){
 const ids=[...new Set((text.match(BANK)??[]).map(bank=>cleanRequisites({phone:'+79990000000',bank,first_name:'Анна',amount_rub:100})?.bank).filter(Boolean))];
 return ids.length===1?ids[0]:null;
}
/** Only short original detail clusters. A later explicit single-bank correction wins.
 * No profile name, outgoing acknowledgement or amount is interpreted as requisites. */
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
  if(!singleBank(text))continue;
  let r=detectRequisites(selected.map(m=>m.text));
  // Owner 2026-11-11: Russian names often come surname first («Улубегова Севда»). A first
  // name that looks like a surname swaps with the other word; only the first name is kept.
  const surnameLike=v=>String(v??'').length>4&&/(?:ова|ева|ёва|ина|ская|цкая|ов|ев|ин)$/i.test(String(v??''));
  if(r&&surnameLike(r.first_name)&&/^[А-ЯЁ][а-яё]{2,}$/.test(String(r.last_name??''))&&!surnameLike(r.last_name))r={...r,first_name:r.last_name,last_name:null};
  if(r && !surnameLike(r.first_name))result={...r,source_message_ids:selected.map(m=>m.id),source_at:Math.max(...selected.map(m=>Date.parse(m.created_at))),cycle_message_id:rows[i].id};
 }
 if(!result)return null;
 for(const row of rows){
  if(Date.parse(row.created_at)<=result.source_at||row.text.length>100||/\?|или|либо|можно|могу/i.test(row.text))continue;
  const phone=row.text.match(PHONE)?.[0].replace(/\D/g,'').replace(/^8/,'7');
  if(phone&&phone!==result.phone.replace(/\D/g,''))continue;
  if(!/банк|сбер|тинькофф|тиньков|втб|альфа|совком/i.test(row.text)&&!/^\s*(?:озон|ozon)\s*$/i.test(row.text))continue;
  const bank=singleBank(row.text);
  if(bank){result.bank=bank;result.source_message_ids.push(row.id);result.source_at=Date.parse(row.created_at);}
 }
 result.source_message_ids=[...new Set(result.source_message_ids)].slice(-20);
 return result;
}
