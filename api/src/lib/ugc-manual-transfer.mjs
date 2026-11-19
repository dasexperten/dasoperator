// Owner 2026-11-18 (o__kseniaa, 489 ₽): Konsol could not pay, Diana told the blogger the director
// would send the money himself from his own number, and the Owner then writes in the same chat
// «перевод отправили». That message is the payment fact: the declined button turns green
// (paid outside the ERP), the creator's status follows, and Diana carries on with the scenarios.
// Owner 2026-11-19: his real words were «Отправили частным переводом» and the button stayed red;
// one or two words between the verb and «перевод(ом)» are now read as the same fact.
// Only our own outgoing message written after the bank decline counts; a question, a promise
// («отправим», «директор отправит») or a denial («не перевели») never does.
import {followPayoutStage} from './ugc-payout-stage.mjs';

const SENT=/(?:перевод\S*\s+(?:вам\s+)?(?:уже\s+)?отправ(?:или|ил|ила|лен)(?![а-яё])|отправ(?:или|ил|ила)\s+(?:вам\s+)?(?:[а-яё]+\s+){0,2}перевод(?:ом)?(?![а-яё])|перев(?:ели|ёл|ел|ела)(?![а-яё])|оплат(?:или|ил|ила)(?![а-яё])|деньги\s+(?:вам\s+)?(?:уже\s+)?отправ(?:или|ил|ила|лены)(?![а-яё]))/i;
// Diana's own «банк отклонил перевод» notice also contains the words; a decline is never a payment.
const NOT=/\?|отклон|отказ|не\s+прош|не\s+удал|не\s+получил|вернул|другой\s+банк|(?:^|[^а-яё])(?:не|ещ[её]\s+не|пока\s+не)\s+(?:перев|оплат|отправ)|отправ(?:им|ит|лю|ят)(?![а-яё])|перевед(?:[её]м|[её]т|у|ут)(?![а-яё])|оплат(?:им|ит|ят)(?![а-яё])/i;

export function saysTransferSent(text){
  const t=String(text??'').trim();
  return Boolean(t)&&t.length<=300&&!NOT.test(t)&&SENT.test(t);
}

/** The newest of our messages written after the decline that says the transfer was sent. */
export function transferMessage(messages,ourIds,failedAt,skipIds=[]){
  const since=Date.parse(String(failedAt??''));
  if(!Number.isFinite(since))return null;
  return (messages??[])
    .filter(m=>m?.id&&!skipIds.includes(String(m.id))&&ourIds.includes(String(m.from?.id??''))&&Date.parse(m.created_time)>since&&saysTransferSent(m.message))
    .sort((a,b)=>Date.parse(b.created_time)-Date.parse(a.created_time))[0]??null;
}

/** Bank-declined payouts that are still each blogger's newest payout, with the chat they belong to. */
export async function declinedPayouts(db,now=Date.now(),limit=10){
  const rows=(await db.prepare(`SELECT p.id,p.creator_id,p.handle,p.amount_minor,p.failed_at,p.notice_message_id FROM ugc_payouts p
    WHERE p.status='failed' AND p.amount_minor>=5000 AND p.failed_at>=?1
      AND NOT EXISTS (SELECT 1 FROM ugc_payouts n WHERE n.creator_id=p.creator_id AND n.created_at>p.created_at)
    ORDER BY p.failed_at DESC LIMIT ?2`).bind(new Date(now-14*86400000).toISOString(),limit).all()).results??[];
  const out=[];
  for(const row of rows){
    const handle=String(row.handle??'').toLowerCase().replace(/^@/,'');
    let cid=null;
    const link=await db.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_payout_cid:'+row.id).first();
    try{cid=JSON.parse(link?.value??'null')?.cid??null;}catch{}
    if(!cid&&handle){
      const alarm=await db.prepare(`SELECT value FROM crm_sync_state WHERE (key LIKE 'diana_round_alarm:%' OR key LIKE 'diana_payout_cid:%') AND json_valid(value) AND lower(json_extract(value,'$.handle'))=?1 ORDER BY updated_at DESC LIMIT 1`).bind(handle).first();
      try{cid=JSON.parse(alarm?.value??'null')?.cid??null;}catch{}
    }
    if(cid)out.push({...row,handle,cid:String(cid)});
  }
  return out;
}

/** Turns the declined payout green. Returns true only when this call changed it. */
export async function markManualTransfer(db,payout,message,now=Date.now()){
  const paidAt=new Date(Date.parse(message.created_time)).toISOString();
  const day=new Date(Date.parse(paidAt)+4*3600000).toISOString().slice(0,16).replace('T',' ');
  const changed=await db.prepare(`UPDATE ugc_payouts SET status='paid',konsol_status='paid_outside',paid_at=?2,paid_notice_at=COALESCE(paid_notice_at,?2),
      note=TRIM(COALESCE(note,'')||' Оплачено директором вручную: сообщение в чате '||?3||'.'),updated_at=?4
    WHERE id=?1 AND status='failed'`).bind(payout.id,paidAt,day,now).run();
  if(!Number(changed?.meta?.changes??0))return false;
  await db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING`)
    .bind('manual_transfer:'+payout.id,JSON.stringify({payout_id:payout.id,message_id:String(message.id),conversation_id:payout.cid,paid_at:paidAt,amount_minor:payout.amount_minor}),now).run();
  await followPayoutStage(db,payout.creator_id,'paid',now);
  return true;
}
