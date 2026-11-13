// Owner 2026-11-13: when a payment detail is missing, Diana asks for exactly that, in one short line,
// in the same words she already uses («Елена, подскажите, пожалуйста, название банка для перевода по СБП?»).
const PART={phone:'номер телефона',bank:'название банка',name:'имя получателя'};
export function requisitesQuestion({missing_fields,first_name,foreign}={}){
 const lead=first_name?String(first_name).trim()+', ':'';
 if(foreign)return lead+'сейчас мы переводим только на карты российских банков по СБП. Если у вас или у близкого человека есть российская карта, пришлите, пожалуйста, номер телефона, банк и имя получателя.';
 const want=['phone','bank','name'].filter(k=>(missing_fields??[]).includes(k)).map(k=>PART[k]);
 if(!want.length)return null;
 const list=want.length===1?want[0]:want.slice(0,-1).join(', ')+' и '+want[want.length-1];
 const q='подскажите, пожалуйста, '+list+' для перевода по СБП?';
 return lead?lead+q:q.charAt(0).toUpperCase()+q.slice(1);
}
