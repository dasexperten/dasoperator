'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, Download, Inbox, Loader2, Mail, Menu, Paperclip, PenLine, RefreshCw, Search, Send, Star, Trash2, X } from 'lucide-react';
import { AGENT_MAILBOXES, DEPARTMENT_MAILBOXES, type UiMailbox } from './mailbox-registry';
import { gmailCounts, type MailCount, gmailAccounts, gmailAction, gmailBody, gmailDownload, gmailDraft, gmailDrafts, gmailFile, gmailIdentities, gmailList, gmailSave, gmailSend, type GmailAction, type GmailDraftInput, type GmailFile, type GmailMessage } from '@/lib/gmail-api';
import './google-mail.css';
import { mailDocument } from './mail-document';
import { MailBodyCache } from './mail-body-cache';

type Row = GmailMessage & { draftId?: string };
type Compose = { draftId?: string; message?: GmailMessage; mode: 'new' | 'reply' | 'all' | 'forward' | 'draft' };
const folders = [
  { id: 'INBOX', name: 'Входящие', icon: Inbox }, { id: 'STARRED', name: 'Важные', icon: Star },
  { id: 'SENT', name: 'Отправленные', icon: Send }, { id: 'DRAFT', name: 'Черновики', icon: PenLine },
  { id: 'archive', name: 'Архив', icon: Archive }, { id: 'all', name: 'Вся почта', icon: Mail },
  { id: 'TRASH', name: 'Корзина', icon: Trash2 },
];
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Запрос не выполнен. Повторите попытку.';
const addresses = (value?: string): string[] => (value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const fileSize = (n: number) => n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
function readableSnippet(value?: string): string {
  if (!value || typeof document === 'undefined') return value || '';
  const decoder = document.createElement('textarea');
  decoder.innerHTML = value.replace(/</g, '&lt;');
  return decoder.value;
}


function Correspondent({ value }: { value: string }) {
  const match = /^(.*?)\s*(<[^<>]+>.*)$/.exec(value.trim());
  const name = (match ? match[1] : value.includes('@') ? '' : value).trim().replace(/^"|"$/g, '');
  const address = match ? match[2] : name ? '' : value;
  return <span className="gm-correspondent" title={value}>{name && <b>{name}</b>}{name && address ? ' ' : ''}{address && <span>{address}</span>}</span>;
}

export default function GoogleMailApp() {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [account, setAccount] = useState('');
  const [counts, setCounts] = useState<Record<string, MailCount | null>>({});
  const [countRefresh, setCountRefresh] = useState(0);
  const [countsFailed, setCountsFailed] = useState(false);
  const [listReadyAccount,setListReadyAccount] = useState('');
  const [identities, setIdentities] = useState<string[]>([]);
  const [accountError, setAccountError] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [folder, setFolder] = useState('INBOX');
  const [scope, setScope] = useState<UiMailbox | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedPage, setFailedPage] = useState<string | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Row | null>(null);
  const [automaticPreview, setAutomaticPreview] = useState(false);
  const initialPreview = useRef(true);
  const [body, setBody] = useState<GmailMessage | null>(null);
  const [bodyError, setBodyError] = useState('');
  const [readError, setReadError] = useState('');
  const [bodyRetry, setBodyRetry] = useState(0);
  const bodyCache = useRef(new MailBodyCache((account,id)=>gmailBody(account,id).then(r=>r.message)));
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const cancelWarm = () => {if(hoverTimer.current)clearTimeout(hoverTimer.current);};
  useEffect(() => {bodyCache.current.clear();return ()=>{cancelWarm();bodyCache.current.clear();};},[account,refresh,bodyRetry]);
  const warmMessage = (message:Row) => {
    cancelWarm();
    if(message.draftId || !account)return;
    hoverTimer.current=setTimeout(()=>{
      if(bodyCache.current.pendingCount===0)void bodyCache.current.read(account,message.id).catch(()=>{});
    },120);
  };
  const [originalFormatting, setOriginalFormatting] = useState(false);
  useEffect(() => { setOriginalFormatting(false); }, [selected?.id]);
  const renderedHtml = useMemo(() => body?.html ? mailDocument(body.html, originalFormatting) : '', [body?.html, originalFormatting]);
  const [actionBusy, setActionBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const inlineCompose = !!compose && ['reply','all','forward'].includes(compose.mode);
  const request = useRef(0);
  const pageBusy = useRef(false);
  const drawerRef = useRef<HTMLElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  useEffect(() => { if (readerRef.current) readerRef.current.scrollTop = 0; }, [selected?.id]);
  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, [drawer]);

  useEffect(() => {
    setCounts({}); setCountsFailed(false);
    if (!account || listReadyAccount !== account) return;
    let current = true;
    const queries = [
      ...folders.map(f => ['archive','all'].includes(f.id) ? {key:f.id,q:f.id === 'archive' ? '-in:inbox -in:sent -in:drafts -in:trash -in:spam' : ''} : {key:f.id,label:f.id,unread:f.id === 'INBOX'}),
      ...[...AGENT_MAILBOXES,...DEPARTMENT_MAILBOXES].map(m => ({key:m.address,q:`is:unread -in:spam -in:trash {${[m.address,...(m.aliases || [])].flatMap(a => [`to:${a}`,`from:${a}`,`cc:${a}`,`deliveredto:${a}`]).join(' ')}}`}))
    ];
    void (async () => {
      for (let i=0;i<queries.length && current;i+=8) {
        try {
          const r=await gmailCounts(account,queries.slice(i,i+8));
          if (current) { setCounts(prev => ({...prev,...r.counts})); if (Object.values(r.counts).some(v => v === null)) setCountsFailed(true); }
        } catch { if (current) setCountsFailed(true); }
      }
    })();
    return () => { current=false; };
  }, [account,refresh,countRefresh,listReadyAccount]);
  const countBadge = (key: string, unread = false) => {
    const count=counts[key];
    const value=count ? `${count.value}${count.more ? '+' : ''}` : '—';
    const title=count ? `${unread ? 'Непрочитанных' : 'Писем'}: ${value}` : 'Счётчик пока недоступен';
    return <span className="gm-count" title={title} aria-label={title}>{value}</span>;
  };

  const loadAccounts = useCallback(async () => {
    setAccountError(''); setAccountsLoading(true);
    try { const r = await gmailAccounts(); const emails = r.accounts.map(a => a.email); setAccounts(emails); setAccount(prev => emails.includes(prev) ? prev : emails[0] || ''); }
    catch(e) { setAccountError(errorText(e)); }
    finally { setAccountsLoading(false); }
  }, []);
  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => {
    setIdentities([]); if (!account) return;
    let current = true;
    gmailIdentities(account).then(r => { if (current) { setIdentities(r.identities); setAccountError(''); } }).catch(() => { if (current) setAccountError('Не удалось загрузить адреса отправителя. Обновите подключение.'); });
    return () => { current = false; };
  }, [account, refresh]);

  const load = useCallback(async (pageToken?: string) => {
    if (!account || (pageToken && pageBusy.current)) return;
    const ticket = pageToken ? request.current : ++request.current;
    pageBusy.current = true; setBusy(true); setError(''); setFailedPage(pageToken);
    try {
      let incoming: Row[]; let cursor: string | undefined;
      if (folder === 'DRAFT') {
        const r = await gmailDrafts(account, pageToken); incoming = r.drafts.map(d => ({ ...d.message, draftId: d.id })); cursor = r.nextPageToken;
      } else {
        const aliases = scope ? [scope.address, ...(scope.aliases || [])] : [];
        const scopeQuery = aliases.length ? `{${aliases.flatMap(a => [`to:${a}`, `from:${a}`, `cc:${a}`, `deliveredto:${a}`]).join(' ')}}` : '';
        const q = [search, scopeQuery, folder === 'archive' ? '-in:inbox -in:sent -in:drafts -in:trash -in:spam' : ''].filter(Boolean).join(' ');
        const r = await gmailList(account, { q, label: ['all', 'archive'].includes(folder) ? undefined : folder, pageToken }); incoming = r.messages; cursor = r.nextPageToken;
      }
      if (ticket !== request.current) return;
      setRows(prev => pageToken ? Array.from(new Map([...prev, ...incoming].map(m => [m.id, m])).values()) : incoming);
      setNext(cursor);
      if (!pageToken && initialPreview.current && incoming.length) {
        initialPreview.current = false;
        if (folder !== 'DRAFT' && window.matchMedia('(min-width:769px)').matches) {
          setAutomaticPreview(true);
          setSelected(incoming[0]);
        }
      }
    } catch(e) { if (ticket === request.current) setError(errorText(e)); }
    finally { if (ticket === request.current) { pageBusy.current = false; setBusy(false); setListReadyAccount(account); } }
  }, [account, folder, scope, search]);
  useEffect(() => { setRows([]); setNext(undefined); setSelected(null); setBody(null); void load(); return () => { request.current++; pageBusy.current = false; }; }, [load]);
  useEffect(() => { if (refresh) void load(); }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBody(null); setBodyError(''); setReadError(''); if (!selected || !account) return;
    let current = true;
    bodyCache.current.read(account,selected.id).then(message=>{if(current)setBody(message);}).catch(e=>{if(current)setBodyError(errorText(e));});
    if (!automaticPreview && selected.labelIds?.includes('UNREAD')) gmailAction(account, selected.id, 'read').then(() => { if (current) { setRows(prev => prev.map(m => m.id === selected.id ? { ...m, labelIds: m.labelIds.filter(l => l !== 'UNREAD') } : m)); setCountRefresh(v => v + 1); } }).catch(() => { if (current) setReadError('Не удалось отметить письмо прочитанным. Содержимое письма доступно.'); });
    return () => { current = false; };
  }, [account, selected?.id, bodyRetry, automaticPreview, refresh]);

  const action = async (name: GmailAction) => {
    if (!selected || actionBusy) return;
    setActionBusy(true); setBodyError('');
    try { await gmailAction(account, selected.id, name); setCountRefresh(v => v + 1); if (['archive','trash','untrash','inbox','unread'].includes(name)) { setSelected(null); setBody(null); } else setSelected(prev => prev ? { ...prev, labelIds: name === 'star' ? [...prev.labelIds, 'STARRED'] : name === 'unstar' ? prev.labelIds.filter(l => l !== 'STARRED') : prev.labelIds } : prev); void load(); }
    catch(e) { setBodyError(errorText(e)); } finally { setActionBusy(false); }
  };
  const download = async (m: GmailMessage, partId: string, filename: string) => {
    try { const blob = await gmailDownload(account, m.id, partId); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename.replace(/[\\/\u0000-\u001f]/g, '_'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch(e) { setBodyError(errorText(e)); }
  };
  const visibleRows = folder === 'DRAFT' ? rows.filter(m => (!search || `${m.subject} ${m.to}`.toLowerCase().includes(search.toLowerCase())) && (!scope || [scope.address,...(scope.aliases || [])].some(a => `${m.from} ${m.to} ${m.cc}`.includes(a)))) : rows;
  const label = scope?.label || folders.find(f => f.id === folder)?.name;
  return <div className="dxmail gmail-client">
    <header className="gm-header"><button className="gm-mobile" onClick={() => setDrawer(true)} aria-label="Папки и ящики"><Menu size={21}/></button><div><strong>Почта</strong><small>Google Workspace</small></div><label className="gm-account"><span className="sr-only">Аккаунт Gmail</span><select value={account} disabled={!!compose} onChange={e => { setAccount(e.target.value); setAccountError(''); }}>{accounts.map(a => <option key={a}>{a}</option>)}</select></label><button onClick={() => setRefresh(v => v + 1)} disabled={busy} aria-label="Обновить почту"><RefreshCw size={18}/></button></header>
    {accountError && <div className="gm-error" role="alert">{accountError} <button onClick={() => { void loadAccounts(); setRefresh(v => v + 1); }}>Повторить</button></div>}
    {accountsLoading && <p className="gm-empty" role="status">Подключение к Gmail…</p>}
    {!account && !accountError && !accountsLoading && <p className="gm-empty">Нет подключённых аккаунтов Gmail. <a href="/emailer/workspace">Подключить Google Workspace</a></p>}
    <div className="gm-layout">
      {drawer && <button className="gm-shade" aria-label="Закрыть папки" onClick={() => setDrawer(false)}/>}
      <aside className={`gm-sidebar ${drawer ? 'gm-drawer-open' : ''}`} aria-label="Папки и ящики" ref={drawerRef} role={drawer ? 'dialog' : undefined} aria-modal={drawer || undefined} onKeyDown={e => {
        if (!drawer) return;
        if (e.key === 'Escape') { e.preventDefault(); setDrawer(false); }
        if (e.key === 'Tab') {
          const controls = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary') || []).filter(el => el.getClientRects().length > 0);
          const first = controls[0], last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}><button className="gm-mobile gm-close" onClick={() => setDrawer(false)} aria-label="Закрыть папки"><X size={20}/></button><button className="gm-primary" disabled={!identities.length || !!compose} onClick={() => { setCompose({ mode: 'new' }); setDrawer(false); }}><PenLine size={17}/>Написать</button>
        {folders.map(f => <button key={f.id} className={folder === f.id && !scope ? 'gm-active' : ''} onClick={() => { setFolder(f.id); setScope(null); setDrawer(false); }}><f.icon size={17}/><span>{f.name}</span>{countBadge(f.id,f.id === 'INBOX')}</button>)}
        <small className="gm-count-note">Входящие и ящики — непрочитанные</small>{countsFailed && <button onClick={() => setCountRefresh(v => v + 1)}>Обновить счётчики</button>}<a className="gm-legacy" href="/emailer/archive">История до перехода в Google</a>
        {[["Agents", AGENT_MAILBOXES], ["Departments", DEPARTMENT_MAILBOXES]].map(([heading, boxes]) => <details key={heading as string} open><summary>{heading as string}</summary>{(boxes as UiMailbox[]).map(m => <button key={m.address} className={scope?.address === m.address ? 'gm-active' : ''} title={m.address} onClick={() => { setScope(m); setFolder('all'); setDrawer(false); }}><span>{m.label}<small>{m.address}</small></span>{countBadge(m.address,true)}</button>)}</details>)}
      </aside>
      <section className={`gm-list ${selected || inlineCompose ? 'gm-mobile-hidden' : ''}`} aria-label="Список писем"><form className="gm-search" onSubmit={e => { e.preventDefault(); setSearch(query); }}><input aria-label="Поиск писем" placeholder={folder === 'DRAFT' ? 'Поиск в загруженных черновиках' : 'Поиск в Gmail'} value={query} onChange={e => setQuery(e.target.value)}/><button aria-label="Искать"><Search size={18}/></button></form><div className="gm-list-title"><strong>{label}</strong><small>{visibleRows.length} загружено</small><button className="gm-mobile" disabled={!identities.length || !!compose} onClick={() => setCompose({ mode: 'new' })} aria-label="Написать письмо"><PenLine size={20}/></button></div>
        <div className="gm-rows">{error && <div className="gm-error" role="alert">{error}<button onClick={() => void load(failedPage)}>Повторить</button></div>}{busy && !rows.length && <div className="gm-empty" role="status"><Loader2 className="dxmail-spin"/>Загрузка…</div>}{!busy && !error && !visibleRows.length && <div className="gm-empty">Писем не найдено</div>}
          {visibleRows.map(m => <button onPointerEnter={e=>{if(e.pointerType==='mouse')warmMessage(m);}} onPointerLeave={cancelWarm} onFocus={()=>warmMessage(m)} onBlur={cancelWarm} disabled={!!compose && !!m.draftId} key={m.id} className={`gm-row ${m.labelIds?.includes('UNREAD') ? 'gm-unread' : ''} ${selected?.id === m.id ? 'gm-selected' : ''}`} onClick={() => { setAutomaticPreview(false); m.draftId ? setCompose({ mode: 'draft', draftId: m.draftId }) : setSelected(m); }}><span className="gm-row-top"><Correspondent value={m.labelIds?.includes('SENT') ? m.to : m.from}/><time>{date(m.timestamp)}</time></span><strong>{m.subject || '(Без темы)'}</strong><span className="gm-snippet">{readableSnippet(m.snippet)}</span>{m.labelIds?.includes('STARRED') && <span aria-label="Важное">★</span>}</button>)}
          {next && <button className="gm-more" disabled={busy} onClick={() => void load(next)}>{busy ? 'Загрузка…' : 'Загрузить ещё'}</button>}
        </div>
      </section>
      <section ref={readerRef} className={`gm-detail ${selected || inlineCompose ? 'gm-open' : ''}`} aria-label="Письмо">{!selected ? <div className="gm-empty">Выберите письмо, чтобы прочитать и ответить.</div> : <><div className="gm-tools"><button onClick={() => setSelected(null)} aria-label="Назад"><ArrowLeft size={19}/></button><button disabled={actionBusy} onClick={() => void action(selected.labelIds.includes('STARRED') ? 'unstar' : 'star')} aria-label="Переключить важность"><Star size={18} fill={selected.labelIds.includes('STARRED') ? 'currentColor' : 'none'}/></button><button disabled={actionBusy} onClick={() => void action('unread')}>Не прочитано</button><button disabled={actionBusy} onClick={() => void action(selected.labelIds.includes('INBOX') ? 'archive' : 'inbox')} aria-label={selected.labelIds.includes('INBOX') ? 'В архив' : 'Во входящие'}><Archive size={18}/></button><button disabled={actionBusy} onClick={() => void action(selected.labelIds.includes('TRASH') ? 'untrash' : 'trash')} aria-label={selected.labelIds.includes('TRASH') ? 'Восстановить' : 'В корзину'}><Trash2 size={18}/></button></div><div className="gm-message"><h2>{selected.subject || '(Без темы)'}</h2><p><b>От:</b> {selected.from}<br/><b>Кому:</b> {selected.to}{body?.cc && <><br/><b>Копия:</b> {body.cc}</>}<br/><small>{date(selected.timestamp)}</small></p>{readError && <div className="gm-error" role="status">{readError}</div>}{bodyError && <div className="gm-error" role="alert">{bodyError}<button onClick={() => setBodyRetry(v => v + 1)}>Повторить</button></div>}{!body && !bodyError && <p role="status">Загрузка письма…</p>}{body?.html && <div className="gm-format"><button aria-pressed={originalFormatting} onClick={() => setOriginalFormatting(v => !v)}>{originalFormatting ? 'Читаемый вид' : 'Исходное оформление'}</button><small>{originalFormatting ? 'Цвета отправителя' : 'Контрастный текст на белом фоне'}</small></div>}{body?.html ? <iframe title="Содержимое письма" sandbox="" referrerPolicy="no-referrer" srcDoc={renderedHtml}/> : <pre>{body?.text || readableSnippet(body?.snippet)}</pre>}{body?.attachments?.length ? <div className="gm-files">{body.attachments.map(f => <button key={f.partId} onClick={() => void download(body, f.partId, f.filename)}><Download size={16}/><span>{f.filename || 'Вложение'}<small>{fileSize(f.size)}</small></span></button>)}</div> : null}<div className="gm-replies">{(['reply','all','forward'] as const).map((mode,i) => <button key={mode} disabled={!body || !identities.length || !!compose} onClick={() => setCompose({ mode, message: body! })}>{['Ответить','Ответить всем','Переслать'][i]}</button>)}</div></div></>}{inlineCompose && compose && <GmailComposer inline key={`${account}:${compose.mode}:${compose.message?.id}`} account={account} identities={identities} initial={compose} onClose={() => setCompose(null)} onSaved={() => { setCompose(null); setCountRefresh(v => v + 1); void load(); }}/>}</section>
    </div>
    {compose && !inlineCompose && <GmailComposer key={`${account}:${compose.draftId || compose.mode}:${compose.message?.id || ''}`} account={account} identities={identities} initial={compose} onClose={() => setCompose(null)} onSaved={() => { setCompose(null); setCountRefresh(v => v + 1); void load(); }}/>}
  </div>;
}

export function GmailComposer({ account, identities, initial, onClose, onSaved, inline = false }: { account: string; identities: string[]; initial: Compose; onClose: () => void; onSaved: () => void; inline?: boolean }) {
  const original = initial.message;
  const own = new Set([account,...identities].map(a => a.toLowerCase()));
  const other = (list:string[]) => Array.from(new Set(list.filter(a => !own.has(a.toLowerCase()))));
  const reply = initial.mode === 'reply' || initial.mode === 'all';
  const target = addresses(original?.from).some(a => own.has(a.toLowerCase())) ? original?.to : original?.replyTo || original?.from;
  const [draftId,setDraftId] = useState(initial.draftId);
  const [from,setFrom] = useState(identities.find(a => addresses(original?.to).includes(a)) || identities[0] || account);
  const [to,setTo] = useState(reply ? other(addresses(target)).join(', ') : '');
  const [cc,setCc] = useState(initial.mode === 'all' ? other([...addresses(original?.to),...addresses(original?.cc)]).filter(a => !addresses(target).includes(a)).join(', ') : '');
  const [bcc,setBcc] = useState('');
  const [subject,setSubject] = useState(original ? `${initial.mode === 'forward' ? 'Fwd: ' : /^re:/i.test(original.subject) ? '' : 'Re: '}${original.subject}` : '');
  const [text,setText] = useState('');
  const quote = original ? `--- ${original.from} · ${date(original.timestamp)} ---\n${original.text || (original.html ? new DOMParser().parseFromString(original.html, 'text/html').body.textContent || '' : '')}` : '';
  const [includeQuote,setIncludeQuote] = useState(!!original);
  const [showCc,setShowCc] = useState(initial.mode === 'all');
  const [showBcc,setShowBcc] = useState(false);
  const [showSubject,setShowSubject] = useState(!reply);
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [originalHtml,setOriginalHtml] = useState<string | undefined>();
  const [bodyEdited,setBodyEdited] = useState(false);
  const [files,setFiles] = useState<(GmailFile & {size:number})[]>([]);
  const [thread,setThread] = useState<Pick<GmailDraftInput,'gmailThreadId'|'inReplyTo'|'references'>>(reply && original ? {gmailThreadId:original.gmailThreadId,inReplyTo:original.messageId,references:[...(Array.isArray(original.references) ? original.references : (original.references || '').split(/\s+/)),original.messageId || ''].filter(Boolean)} : {});
  const [ready,setReady] = useState(initial.mode !== 'draft' && initial.mode !== 'forward');
  const [loading,setLoading] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [uncertain,setUncertain] = useState(false);
  const lock = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => {});
  const loadOriginal = useCallback(async () => {
    if(initial.mode !== 'draft' && initial.mode !== 'forward') return;
    setLoading(true);setError('');setReady(false);
    try {
      const m = initial.draftId ? (await gmailDraft(account,initial.draftId)).draft.message : initial.message!;
      if(initial.mode === 'draft') {setOriginalHtml(m.html);setBodyEdited(false);setFrom(addresses(m.from)[0] || account);setTo(m.to || '');setCc(m.cc || '');setShowCc(!!m.cc);setBcc(m.bcc || '');setShowBcc(!!m.bcc);setSubject(m.subject || '');setText(m.text || (m.html ? new DOMParser().parseFromString(m.html,'text/html').body.textContent || '' : ''));setThread({gmailThreadId:m.gmailThreadId,inReplyTo:m.inReplyTo,references:m.references});}
      const restored:(GmailFile & {size:number})[]=[];
      for(const f of m.attachments || []) {const blob=await gmailDownload(account,m.id,f.partId);restored.push({...await gmailFile(blob,f.filename || 'Вложение',f.mimeType),contentId:f.contentId,inline:f.inline,size:blob.size});}
      setFiles(restored);setReady(true);
    } catch {setError('Не удалось загрузить черновик или вложения. Оригинал в Gmail сохранён; повторите загрузку.');}
    finally {setLoading(false);}
  },[account,initial]);
  useEffect(() => {void loadOriginal();},[loadOriginal]);
  useEffect(() => {const previous=document.activeElement as HTMLElement|null;if (inline) { dialog.current?.scrollIntoView({block:'nearest'}); editor.current?.focus({preventScroll:true}); } else dialog.current?.focus();const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>{window.removeEventListener('beforeunload',warn);previous?.focus();};},[]);
  useEffect(() => {if(ready && document.activeElement===dialog.current)dialog.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();},[ready]);
  const save=async(send:boolean)=>{
    if(lock.current || !ready || uncertain)return;
    if(send && !addresses(to).length){setError('Укажите получателя.');return;}
    lock.current=true;setBusy(true);setError('');let sendStarted=false;
    try {const r=await gmailSave(account,{id:draftId,from,to,cc,bcc,subject,text: text + (includeQuote && quote ? `\n\n${quote}` : ''),html:bodyEdited ? undefined : originalHtml,...thread,attachments:files.map(({filename,mimeType,content,contentId,inline})=>({filename,mimeType,content,contentId,inline}))});setDraftId(r.draft.id);if(send){sendStarted=true;await gmailSend(account,r.draft.id);}onSaved();}
    catch(e){if(sendStarted){setUncertain(true);setError('Подтверждение отправки не получено. Проверьте «Отправленные» в Gmail перед повторной отправкой.');}else setError(`${errorText(e)} Текст и вложения остаются здесь.`);}
    finally{lock.current=false;setBusy(false);}
  };
  closeRef.current=()=>{if(busy || loading)return;if(uncertain || !ready)onClose();else void save(false);};
  const upload=async(chosen:FileList|null)=>{
    if(!chosen?.length || lock.current)return;const selected=Array.from(chosen);
    if(files.length+selected.length>20 || selected.some(f=>f.size>10*1048576) || [...files,...selected].reduce((n,f)=>n+f.size,0)>20*1048576){setError('Максимум 20 файлов, 10 МБ на файл и 20 МБ всего.');return;}
    lock.current=true;setBusy(true);setError('');
    try{const added:(GmailFile & {size:number})[]=[];for(const f of selected)added.push({...await gmailFile(f,f.name,f.type),size:f.size});setFiles(prev=>[...prev,...added]);}catch{setError('Не удалось прочитать файл. Текст и другие вложения остаются в форме.');}finally{lock.current=false;setBusy(false);}
  };
  return <div className={inline ? 'gm-inline-composer' : 'gm-modal-backdrop'}><div className={`gm-modal gm-compose-surface ${inline ? 'gm-compose-inline' : ''}`} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-labelledby="gm-compose-title" tabIndex={-1} ref={dialog} onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();closeRef.current();}
    if(!inline && e.key==='Tab'){const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type=file]),textarea:not(:disabled),select:not(:disabled),a[href]') || []).filter(el=>el.getClientRects().length>0);const first=controls[0],last=controls[controls.length-1];if(!first){e.preventDefault();return;}if(document.activeElement===dialog.current){e.preventDefault();(e.shiftKey?last:first)?.focus();}else if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}}
  }}><div className="gm-compose-header"><h2 id="gm-compose-title">{initial.mode==='draft' ? 'Черновик Gmail' : reply ? `Ответ: ${original?.subject || '(Без темы)'}` : initial.mode==='forward' ? 'Переслать письмо' : 'Новое письмо'}</h2><button disabled={busy || loading} aria-label={ready && !uncertain?'Сохранить и закрыть':'Закрыть'} onClick={()=>closeRef.current()}><X size={20}/></button></div>
    {loading && <p role="status">Загрузка черновика и вложений…</p>}{error && <div className="gm-error" role="alert">{error}{!ready && !loading && <button onClick={()=>void loadOriginal()}>Повторить загрузку</button>}</div>}
    <fieldset disabled={!ready || busy || uncertain}>
      <label className="gm-compose-line"><span>От</span><select value={from} onChange={e=>setFrom(e.target.value)} aria-label="От кого">{Array.from(new Set([from,...identities])).map(a=><option key={a}>{a}</option>)}</select></label>
      <div className="gm-recipient-line"><label className="gm-compose-line"><span>Кому</span><input value={to} onChange={e=>setTo(e.target.value)} placeholder="Получатели" aria-label="Кому"/></label><button type="button" aria-expanded={showCc} onClick={()=>setShowCc(v=>!v || !!cc)}>Копия</button><button type="button" aria-expanded={showBcc} onClick={()=>setShowBcc(v=>!v || !!bcc)}>Скрытая</button></div>
      {showCc && <label className="gm-compose-line"><span>Копия</span><input value={cc} onChange={e=>setCc(e.target.value)} aria-label="Копия (CC)"/></label>}
      {showBcc && <label className="gm-compose-line"><span>Скрытая</span><input value={bcc} onChange={e=>setBcc(e.target.value)} aria-label="Скрытая копия (BCC)"/></label>}
      {reply && <button type="button" className="gm-subject-toggle" aria-expanded={showSubject} onClick={()=>setShowSubject(v=>!v)}>Изменить тему</button>}
      {showSubject && <label className="gm-compose-line"><span>Тема</span><input value={subject} onChange={e=>setSubject(e.target.value)} aria-label="Тема"/></label>}
      <textarea ref={editor} className="gm-compose-editor" rows={7} value={text} placeholder={reply ? 'Напишите ответ…' : 'Напишите письмо…'} aria-label="Текст письма" onChange={e=>{setText(e.target.value);setBodyEdited(true);}}/>
      {includeQuote && quote && <details className="gm-quoted-history"><summary aria-label="Показать цитируемое письмо">•••</summary><pre>{quote}</pre><button type="button" onClick={()=>setIncludeQuote(false)}>Убрать цитату из ответа</button></details>}
      <input ref={fileInput} type="file" className="gm-file-input" aria-label="Прикрепить файлы" multiple onChange={e=>{void upload(e.target.files);e.target.value='';}}/>
      <div className="gm-compose-files">{files.map((f,i)=><div key={`${i}:${f.filename}`}><span>{f.filename}<small>{fileSize(f.size)}</small></span><button type="button" aria-label={`Удалить вложение ${f.filename}`} onClick={()=>setFiles(prev=>prev.filter((_,j)=>j!==i))}>Удалить</button></div>)}</div>
    </fieldset>
    <div className="gm-compose-actions">{uncertain?<button onClick={onClose}>Закрыть и проверить отправку</button>:<><button className="gm-primary" disabled={!ready || busy} onClick={()=>void save(true)}><Send size={16}/>{busy?'Сохранение…':'Отправить'}</button><button type="button" disabled={!ready || busy} aria-label="Прикрепить файлы" title="До 20 файлов · 10 МБ на файл · 20 МБ всего" onClick={()=>fileInput.current?.click()}><Paperclip size={19}/></button><button disabled={!ready || busy} onClick={()=>void save(false)}>Сохранить черновик</button></>}</div>
  </div></div>;
}
