// Exact author answer to our seller question; never infer a seller from a brand.
export const SELLER_QUESTION='Подскажите, пожалуйста, название продавца товара.';
export const normalizeSeller=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function sellerAnswerForBasket(messages,basket,policy,handle){
 const when=Date.parse(String(basket?.created_at??''));if(!Number.isFinite(when)||!Array.isArray(policy?.sellers))return null;
 const ordered=[...messages].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
 let question=null,answer=null;
 for(const m of ordered){
  const at=Date.parse(String(m.created_at??''));if(!Number.isFinite(at)||at<=when)continue;
  if(m.direction==='out'&&(String(m.text??'').trim()===SELLER_QUESTION||(/продав(?:ец|ц)/iu.test(String(m.text??''))&&/(?:подскаж|назван|называ|как\s+зов)/iu.test(String(m.text??''))&&/\?/u.test(String(m.text??''))))){question=m;answer=null;continue;}
  if(question&&m.direction==='in'){if(!answer)answer=m;else if(/продавец|магазин/iu.test(String(m.text??'')))return null;}
 }
 if(!question||!answer||!answer.id||!question.id||String(answer.from_username??'').toLocaleLowerCase()!==String(handle??'').toLocaleLowerCase())return null;
 const text=String(answer.text??'').trim().split(/\r?\n/u)[0].trim().replace(/^(?:продавец|магазин)\s*[:—-]\s*/iu,'');const normalized=normalizeSeller(text);
 if(!normalized||/[?]/u.test(text)||/^(?:не\s+знаю|не\s+вижу|не\s+помню|не\s+нашла|не\s+нашёл)$/iu.test(text))return null;
 const matching=policy.sellers.filter(s=>normalizeSeller(s?.legal_name)===normalized);
 return {question_id:question.id,answer_id:answer.id,name:text,normalized_name:normalized,registry_match:matching.length>0};
}
