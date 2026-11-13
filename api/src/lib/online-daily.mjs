// Owner 13.11.2026: online-daily, 09:00 Asia/Yerevan; mail stays model-free.
export const dayKey = now => `online-daily:${new Date(new Date(now).getTime()+4*3600000).toISOString().slice(0,10)}`;
export const safe = (value, n=300) => Array.from(String(value??'').replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim()).slice(0,n).join('');
export function brief(value,n=200){const full=safe(value,10000);if(full.length<=n)return full;const cut=safe(full,n),end=[...cut.matchAll(/[.!?](?=\s|$)/g)].at(-1)?.index;return end>60?cut.slice(0,end+1):safe(full,n-1).replace(/\s+\S*$/,'')+'…';}
export const relevant = text => /ozon|wildberries|вайлдберриз|detmir|детский мир|magnit|магнит|a-plus\.ru|аптеки|aptek|аптек|ozon@dasexperten|wb@dasexperten/i.test(text);
export const sensitive = text => /verification code|one.time password|password reset|reset your password|код (?:входа|подтверждения|авторизации)|сброс пароля|восстановлени[ея] пароля/i.test(text);
export const plainMail = value => String(value??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<\/(?:p|div|tr|h[1-6])>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
export function classifyMail(mail) {
 const text=`${mail.from} ${mail.to} ${mail.subject} ${mail.text??''}`;
 const groups=[];
 if(/wildberries|вайлдберриз|@wb\.ru|wb@dasexperten/i.test(text))groups.push('arina');
 if(/ozon|detmir|детский мир|magnit|магнит|a-plus\.ru|аптек/i.test(text))groups.push('dasha');
 if(/сч[её]т|инвойс|invoice|оплат|плат[её]ж|удержан|комисси|акт.*сверк|sales|продаж|отч[её]т|возврат|остатк/i.test(text))groups.push('justina');
 if(/договор|оферт|offer|contract|подпис|соглашен|изменени|правил|утилизац|претензи|санкц|маркировк|сертификат/i.test(text))groups.push('valentina');
 return [...new Set(groups.length?groups:['dasha'])];
}
export function mailLine(mail) {
 const date=new Date(mail.at);const stamp=Number.isFinite(date.getTime())?date.toLocaleDateString('en-GB',{timeZone:'Asia/Yerevan',day:'2-digit',month:'2-digit'}):'date unknown';
 const paragraphs=plainMail(mail.text).split(/\n+/).map(x=>x.replace(/\s+/g,' ').trim()).filter(x=>x&&!/^https?:|^\[|^Уважаем|^Здравствуйте/i.test(x));
 const excerpt=paragraphs.find(x=>/последн|утилизац|вступ|действ|остатк|срок|подпис|\d{1,2}[./]\d{1,2}/i.test(x));
 return `📩 ${stamp} · ${safe(mail.from,35)} — ${safe(mail.subject,90)}${mail.attachments?` · 📎 ${mail.attachments}`:''}${excerpt?`\n«${safe(excerpt,150)}»`:''}`;
}
export function renderReport({at,mails,coverage,news,newsError}) {
 const sections={dasha:[],arina:[],justina:[],valentina:[]};
 const urgency=m=>/последн|утилизац|изменени.*договор|возврат.*остат|last.*day/i.test(`${m.subject} ${m.text}`)?1:0;
 for(const mail of [...mails].sort((a,b)=>urgency(b)-urgency(a)))for(const key of classifyMail(mail))sections[key].push(mailLine(mail));
 for(const key of Object.keys(sections))if(news?.[key])sections[key].unshift(`📰 ${brief(news[key],200)}`);
 const title=`🛒 ONLINE DAILY · ${new Date(at).toLocaleDateString('en-GB',{timeZone:'Asia/Yerevan',day:'numeric',month:'long',year:'numeric'})}`;
 const headings={dasha:'🛍️ Dasha:',arina:'🛒 Arina:',justina:'💰 Justina:',valentina:'⚖️ Valentina:'};
 const out=[title];
 // Telegram is one message. Keep omitted counts explicit; all source evidence remains in ERP.
 for(const key of Object.keys(headings)){
  const rows=sections[key],shown=rows.slice(0,2);
  out.push(`${headings[key]}\n${shown.join('\n')||(coverage.every(s=>s.ok)?'Новых сообщений по этому разделу не найдено.':'Полная проверка источников не подтверждена.')}${rows.length>shown.length?`\n📚 Ещё ${rows.length-shown.length} сообщений в ERP.`:''}`);
 }
 const gaps=coverage.filter(s=>!s.ok).map(s=>`${s.name}: ${s.reason}`);
 if(newsError)gaps.push('Разбор новостей Terra не завершён');
 if(gaps.length)out.push(`⚠️ ${gaps.map(x=>safe(x,140)).join('; ')}`);
 out.push('🔎 Даша, Арина, Джастина и Валентина, изучите открытые вопросы выше по свежим письмам и новостям площадок и пришлите обновлённый отчёт в Telegram.');
 return out.join('\n\n');
}
