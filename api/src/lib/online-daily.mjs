// Owner 13.11.2026: online-daily, 09:00 Asia/Yerevan; mail stays model-free.
export const dayKey = now => `online-daily:${new Date(new Date(now).getTime()+4*3600000).toISOString().slice(0,10)}`;
export const safe = (value, n=300) => Array.from(String(value??'').replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim()).slice(0,n).join('');
export function brief(value,n=200){const full=safe(value,10000);if(full.length<=n)return full;const cut=safe(full,n),end=[...cut.matchAll(/[.!?](?=\s|$)/g)].at(-1)?.index;return end>60?cut.slice(0,end+1):safe(full,n-1).replace(/\s+\S*$/,'')+'…';}
export const relevant = text => /ozon|wildberries|вайлдберриз|detmir|детский мир|magnit|магнит|a-plus\.ru|аптеки|aptek|аптек|ozon@dasexperten|wb@dasexperten/i.test(text);
export const sensitive = text => /verification code|one.time password|password reset|reset your password|код (?:входа|подтверждения|авторизации)|сброс пароля|восстановлени[ея] пароля/i.test(text);
export const plainMail = value => String(value??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<\/(?:p|div|tr|h[1-6])>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
export const senderAddress = value => (String(value??'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]??String(value??'')).toLowerCase();
const policy = /(?:нов|измен|меня|обнов|редакци|вступ|услови).{0,70}(?:договор|оферт|тариф|комисси|лимит|скид|акци|бустинг)|(?:договор|оферт|тариф|комисси|лимит).{0,70}(?:нов|измен|меня|обнов|редакци|вступ)|автоакци|скидк.{0,40}автоматическ|автоматическ.{0,45}(?:скид|акци|бустинг)|штраф|блокировк|претензи|утилизац|задолжен|неоплачен|нарушен/i;
export function materialMail(mail){
 const subject=safe(mail.subject,1000),text=plainMail(mail.text);
 if(sensitive(subject+' '+text))return false;
 if(/(?:заберите|вывоз|пункт.{0,15}вывоза|возврат.{0,20}остатк|при[её]мка|отгрузк|поставк|поступлени[ея]).*/i.test(subject)&&!/(?:договор|оферт|тариф|комисси|претензи|начислен.{0,15}штраф)/i.test(subject))return false;
 if(/отч[её]т агента|отч[её]т.*(?:за период|о продажах|продаж и возврат)|при[её]мка.*завершена|поступлени[ея] товаров|вебинар|приглашаем|дайджест/i.test(subject)&&!policy.test(subject))return false;
 return policy.test(subject)||policy.test(text);
}
export function classifyMail(mail){
 const text=`${mail.subject} ${plainMail(mail.text)}`;
 if(/договор|оферт|новая редакци|вступ.{0,20}силу|претензи|утилизац|санкци|нарушени|сертификат|маркировк/i.test(text))return ['valentina'];
 if(/тариф|комисси|штраф|задолжен|неоплачен|лимит|удержан|резерв.{0,20}баланс/i.test(text))return ['justina'];
 return /wildberries|вайлдберриз|@wb\.ru|wb@dasexperten/i.test(`${mail.from} ${text}`)?['arina']:['dasha'];
}
export function distinctMails(mails){
 const seen=new Set();return mails.filter(mail=>{
  const fingerprint=[senderAddress(mail.from),safe(mail.subject,2000).toLowerCase().replace(/^(?:re|fw|fwd):\s*/g,''),String(mail.at).slice(0,10),safe(plainMail(mail.text),5000).toLowerCase()].join('|');
  if(seen.has(fingerprint))return false;seen.add(fingerprint);return true;
 });
}
export function mailLine(mail){
 const stamp=new Date(mail.at).toLocaleDateString('en-GB',{timeZone:'Asia/Yerevan',day:'2-digit',month:'2-digit'});
 const paragraphs=plainMail(mail.text).split(/\n+|(?<=[.!?])\s+(?=[А-ЯA-Z])/).map(x=>x.replace(/\s+/g,' ').trim()).filter(x=>x&&!/^https?:|^\[|^Уважаем|^Здравствуйте/i.test(x));
 const excerpt=paragraphs.find(x=>policy.test(x)&&!/отпис|подписк.*рассылк|политик.*конфиденц/i.test(x));
 const source=/ozon/i.test(mail.from)?'Ozon':/wildberries|@wb\./i.test(mail.from)?'WB':/a-plus|aptekiplus/i.test(mail.from)?'АптекиПлюс':/magnit/i.test(mail.from)?'Магнит':/detmir/i.test(mail.from)?'Детмир':senderAddress(mail.from);
 return `📌 ${source}, ${stamp}: ${brief(excerpt||mail.subject,280)}`;
}
export function materialNews(value){return policy.test(String(value??''));}
export function renderReport({at,mails,coverage,news,newsError}){
 const sections={dasha:[],arina:[],justina:[],valentina:[]};
 for(const mail of distinctMails(mails).filter(materialMail))sections[classifyMail(mail)[0]].push(mailLine(mail));
 const seenNews=new Set();for(const key of Object.keys(sections))if(news?.[key]&&materialNews(news[key])){const text=brief(news[key],240);if(!seenNews.has(text)){sections[key].unshift(`📰 ${text}`);seenNews.add(text);}}
 const title=`🛒 ONLINE DAILY · ${new Date(at).toLocaleDateString('en-GB',{timeZone:'Asia/Yerevan',day:'numeric',month:'long',year:'numeric'})}`;
 const headings={dasha:'🛍️ Dasha:',arina:'🛒 Arina:',justina:'💰 Justina:',valentina:'⚖️ Valentina:'};const out=[title];
 for(const key of Object.keys(headings))if(sections[key].length)out.push(`${headings[key]}\n${sections[key].slice(0,2).join('\n')}`);
 const gaps=coverage.filter(s=>!s.ok).map(s=>`${s.name}: ${s.reason}`);if(newsError)gaps.push('Разбор новостей Terra не завершён');
 if(out.length===1)out.push(gaps.length?'Полная проверка значимых изменений пока не подтверждена.':'Существенных изменений нет.');
 if(gaps.length)out.push(`⚠️ ${gaps.map(x=>safe(x,130)).join('; ')}`);
 out.push('🔎 Даша, Арина, Джастина и Валентина, изучите значимые вопросы выше по свежим письмам и новостям площадок и пришлите обновлённый отчёт в Telegram.');
 return out.join('\n\n');
}
