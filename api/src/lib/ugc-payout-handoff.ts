import type {Env} from '../types';
import {queueDianaAction} from './diana-compose';
import {mapKonsolStatus} from './ugc-payouts.mjs';

// Read after the provider result was saved: orchestration's row may still be pre-transition.
export async function queueConfirmedPayoutNotice(env:Env,id:string,kind:'paid'|'failed'){
 const row=await env.DB.prepare(`SELECT id,handle,status,konsol_payment_id,konsol_status,paid_at,failed_at,amount_minor,currency,notice_status FROM ugc_payouts WHERE id=?1`).bind(id).first<any>();
 if(!row)throw Error('payout_notice_source_missing');
 if(['delivered','reviewed'].includes(row.notice_status))return{ok:true,completed:true};
 const validDate=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
 if(kind==='paid'&&(row.status!=='paid'||!row.konsol_payment_id||mapKonsolStatus(row.konsol_status)!=='paid'||!validDate(row.paid_at)))throw Error('confirmed_paid_payout_required');
 if(kind==='failed'&&(row.status!=='failed'||!validDate(row.failed_at)||mapKonsolStatus(row.konsol_status)==='paid'))throw Error('confirmed_failed_payout_required');
 const metadata={task:kind==='paid'?'payout_paid_notice':'payout_failed_notice',payout_id:row.id,status:row.status,konsol_status:row.konsol_status??'',...(row.konsol_payment_id?{konsol_payment_id:row.konsol_payment_id}:{}),amount_minor:row.amount_minor,currency:row.currency,...(kind==='paid'?{paid_at:row.paid_at}:{failed_at:row.failed_at})};
 const action=await queueDianaAction(env,row.handle,'',`payout:${row.id}:${kind}`,metadata);
 if(!action.ok)throw Error(action.error);
 if(action.completed)return{ok:true,completed:true};
 await env.DB.prepare(`UPDATE ugc_payouts SET paid_notice_at=NULL,notice_status='queued',notice_error=?2,notice_at=NULL
   WHERE id=?1 AND status=?3 AND COALESCE(notice_status,'') NOT IN ('delivered','reviewed')`)
  .bind(row.id,'Задача Диане: проверить выплату и отправить сообщение',row.status).run();
 return{ok:true,queued:true,eventId:action.eventId,dispatch:action.dispatch};
}
