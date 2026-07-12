import React, { useState, useMemo } from "react";
import {
  Search, Star, Archive, Trash2, Send, Inbox as InboxIcon,
  FileText, Paperclip, Plus, Reply, Forward, ChevronLeft,
  MoreHorizontal, Mail, Clock, TrendingUp, AlertCircle
} from "lucide-react";

/* ---------- MPSTATS-style logo mark: rounded green circle + play-forward glyph ---------- */
function LogoMark({ size = 38 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="12" fill="#17BF50" />
      <path d="M27.19 14.92l-9.4-5.61c-.38-.23-.86.06-.86.51v11.21c0 .46.48.74.86.51l9.4-5.6c.38-.23.38-.8 0-1.02Z" fill="white" />
      <path d="M28.17 21.62l-3.4-2.03a.56.56 0 0 0-.57 0l-7.97 4.76c-.38.23-.86-.06-.86-.51v-8.82c0-.44-.34-.79-.76-.79s-.77.35-.77.79v15.15c0 .46.48.74.86.51l13.47-8.04c.38-.23.38-.8 0-1.02Z" fill="white" />
    </svg>
  );
}

const FOLDERS = [
  { id: "inbox", label: "Входящие", icon: InboxIcon },
  { id: "starred", label: "Важные", icon: Star },
  { id: "sent", label: "Отправленные", icon: Send },
  { id: "drafts", label: "Черновики", icon: FileText, count: 1 },
  { id: "archive", label: "Архив", icon: Archive },
];

const TAGS = {
  Производство: { bg: "#EAF9F0", fg: "#17BF50", dot: "#17BF50" },
  Маркетплейс: { bg: "#F0EDFF", fg: "#7B61FF", dot: "#7B61FF" },
  Юридическое: { bg: "#FFF4E5", fg: "#F5920A", dot: "#F5920A" },
  Сертификация: { bg: "#E8F4FF", fg: "#1B84FF", dot: "#1B84FF" },
  Развитие: { bg: "#FFEDF3", fg: "#F0447C", dot: "#F0447C" },
};

const EMAILS = [
  {
    id: 1, folder: "inbox",
    from: "Ellen Wei", org: "Guangzhou Honghui",
    initial: "EW", color: "#17BF50",
    subject: "MF01-DEE/MZ — печати проставлены, ждём USCC",
    preview: "Контракт OEM по 9 SKU подписан обеими сторонами. Ожидаем документ USCC перед передачей пакета в Pioneer для подачи по ТР ТС 009/2011...",
    body: "Контракт OEM по 9 SKU зубной пасты подписан и проштампован обеими сторонами. Ожидаем документ USCC с нашей стороны, после чего передадим полный пакет в Pioneer для подачи по ТР ТС 009/2011. Просим подтвердить ожидаемую дату старта сертификации, чтобы согласовать производственный слот.",
    time: "09:14", unread: true, starred: true, tag: "Производство", attachments: 2, priority: "high",
  },
  {
    id: 2, folder: "inbox",
    from: "Алёна", org: "Wildberries",
    initial: "АЛ", color: "#7B61FF",
    subject: "Доверенность M-2 принята складом",
    preview: "Подтверждаем получение доверенности на получение товара. Приёмка запланирована на завтра, окно с 10:00 до 14:00...",
    body: "Подтверждаем получение доверенности на получение товара со склада. Приёмка запланирована на завтра, окно с 10:00 до 14:00. Просим представителя прибыть с оригиналом паспорта.",
    time: "08:47", unread: true, starred: false, tag: "Маркетплейс", attachments: 1, priority: "normal",
  },
  {
    id: 3, folder: "inbox",
    from: "Виктор Белугин", org: "Pioneer Certification",
    initial: "ВБ", color: "#1B84FF",
    subject: "3 протокола паст — слот лаборатории подтверждён",
    preview: "Лаборатория подтвердила слот на тестирование трёх типов протоколов. Письма-подтверждения производителя нужны до четверга...",
    body: "Лаборатория подтвердила слот на тестирование трёх типов протоколов по ТР ТС 009/2011. Для сохранения слота нужны письма-подтверждения производителя (подписант Ellen Wei / WDAA) до четверга.",
    time: "Вчера", unread: false, starred: true, tag: "Сертификация", attachments: 3, priority: "high",
  },
  {
    id: 4, folder: "inbox",
    from: "Dora", org: "TikTok Shop Vietnam",
    initial: "DO", color: "#F0447C",
    subject: "Документы CNP — вторая апелляция подана",
    preview: "Вторая апелляция по DasExpertenVN подана с обновлённой документацией CNP. Рассмотрение занимает 3–5 рабочих дней...",
    body: "Вторая апелляция по DasExpertenVN подана с обновлённой документацией CNP от нас с Tran. Рассмотрение обычно занимает 3–5 рабочих дней. Сообщу сразу, как будет ответ.",
    time: "Вчера", unread: false, starred: false, tag: "Развитие", attachments: 0, priority: "normal",
  },
  {
    id: 5, folder: "drafts",
    from: "Вы", org: "Черновик",
    initial: "АБ", color: "#F5920A",
    subject: "Re: Рубен Даниелян — разрешение на ввод, Барбюса 62/1",
    preview: "Спасибо за подтверждение кадастровой справки. Прикладываю недостающие документы для ГАСК...",
    body: "Спасибо за подтверждение кадастровой справки (152 млн AMD). Прикладываю недостающие документы для ГАСК и УТФСИБ.",
    time: "Пн", unread: false, starred: false, tag: "Юридическое", attachments: 1, priority: "normal",
  },
];

export default function DasOperatorInboxMP() {
  const [activeFolder, setActiveFolder] = useState("inbox");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(1);
  const [emails, setEmails] = useState(EMAILS);
  const [showList, setShowList] = useState(true);

  const visible = useMemo(() => {
    let list = emails.filter((e) =>
      activeFolder === "starred" ? e.starred : e.folder === activeFolder
    );
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (e) =>
          e.subject.toLowerCase().includes(q) ||
          e.from.toLowerCase().includes(q) ||
          e.preview.toLowerCase().includes(q)
      );
    }
    return list;
  }, [emails, activeFolder, query]);

  const selected = emails.find((e) => e.id === selectedId);
  const unreadCount = emails.filter((e) => e.folder === "inbox" && e.unread).length;
  const urgentCount = emails.filter((e) => e.folder === "inbox" && e.priority === "high").length;

  const toggleStar = (id, ev) => {
    ev.stopPropagation();
    setEmails((p) => p.map((e) => (e.id === id ? { ...e, starred: !e.starred } : e)));
  };
  const openEmail = (id) => {
    setSelectedId(id);
    setShowList(false);
    setEmails((p) => p.map((e) => (e.id === id ? { ...e, unread: false } : e)));
  };

  return (
    <div className="shell">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&display=swap');

        :root {
          --green: #17BF50;
          --green-dark: #109A3F;
          --green-soft: #EAF9F0;
          --navy: #0E1F2E;
          --slate: #5B6B7A;
          --muted: #93A1AE;
          --line: #E7ECF0;
          --panel: #F5F7F9;
          --white: #FFFFFF;
        }
        .shell {
          font-family: 'Manrope', sans-serif;
          background: var(--panel);
          color: var(--navy);
          height: 100vh; width: 100%;
          display: flex; flex-direction: column;
          overflow: hidden;
        }

        /* Top bar */
        .topbar {
          background: var(--white);
          border-bottom: 1px solid var(--line);
          padding: 10px 20px;
          display: flex; align-items: center; gap: 14px;
          flex-shrink: 0;
        }
        .brand-name { font-size: 17px; font-weight: 800; letter-spacing: -0.3px; }
        .brand-tag {
          background: var(--green-soft); color: var(--green-dark);
          font-size: 10.5px; font-weight: 800; letter-spacing: 0.6px;
          padding: 3px 9px; border-radius: 999px; text-transform: uppercase;
        }
        .stats-strip { margin-left: auto; display: flex; gap: 10px; }
        .stat-chip {
          display: flex; align-items: center; gap: 7px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 6px 12px;
          font-size: 12px; font-weight: 700; color: var(--slate);
        }
        .stat-num { font-size: 14px; font-weight: 800; color: var(--navy); }

        .main { flex: 1; display: flex; overflow: hidden; }

        /* Sidebar */
        .sidebar {
          width: 216px; flex-shrink: 0;
          background: var(--white);
          border-right: 1px solid var(--line);
          display: flex; flex-direction: column;
          padding: 16px 12px;
        }
        .compose {
          background: var(--green);
          color: white;
          border: none;
          border-radius: 12px;
          padding: 12px;
          font-family: 'Manrope', sans-serif;
          font-weight: 800; font-size: 14px;
          display: flex; align-items: center; justify-content: center; gap: 8px;
          cursor: pointer;
          box-shadow: 0 6px 14px -6px rgba(23,191,80,0.55);
          transition: background 0.15s ease, transform 0.1s ease;
          margin-bottom: 18px;
        }
        .compose:hover { background: var(--green-dark); }
        .compose:active { transform: scale(0.97); }

        .folder {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 12px;
          border-radius: 10px;
          font-weight: 700; font-size: 13.5px;
          color: var(--slate);
          cursor: pointer;
          transition: all 0.12s ease;
          margin-bottom: 2px;
        }
        .folder:hover { background: var(--panel); color: var(--navy); }
        .folder.active { background: var(--green-soft); color: var(--green-dark); }
        .fcount {
          margin-left: auto;
          background: var(--green); color: white;
          font-size: 10.5px; font-weight: 800;
          padding: 1px 7px; border-radius: 999px;
        }
        .sidebar-note {
          margin-top: auto;
          background: linear-gradient(135deg, #EAF9F0, #E8F4FF);
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 12px;
          font-size: 11.5px; font-weight: 700; color: var(--slate); line-height: 1.45;
        }
        .sidebar-note b { color: var(--green-dark); }

        /* List */
        .list {
          width: 372px; flex-shrink: 0;
          background: var(--white);
          border-right: 1px solid var(--line);
          display: flex; flex-direction: column;
        }
        .search-wrap { padding: 14px 14px 10px 14px; border-bottom: 1px solid var(--line); }
        .search {
          display: flex; align-items: center; gap: 8px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 9px 12px;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .search:focus-within { border-color: var(--green); box-shadow: 0 0 0 3px rgba(23,191,80,0.12); }
        .search input {
          border: none; outline: none; background: transparent;
          font-family: 'Manrope', sans-serif; font-size: 13px; font-weight: 600;
          width: 100%; color: var(--navy);
        }
        .search input::placeholder { color: var(--muted); }

        .rows { overflow-y: auto; flex: 1; }
        .row {
          padding: 13px 16px;
          border-bottom: 1px solid var(--line);
          cursor: pointer;
          display: flex; gap: 11px;
          transition: background 0.1s ease;
          position: relative;
        }
        .row:hover { background: #FAFCFB; }
        .row.selected { background: var(--green-soft); }
        .row.selected::before {
          content: ""; position: absolute; left: 0; top: 0; bottom: 0;
          width: 3px; background: var(--green);
        }
        .ava {
          width: 38px; height: 38px; border-radius: 11px;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 800; color: white;
          flex-shrink: 0;
        }
        .rmain { flex: 1; min-width: 0; }
        .rtop { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; }
        .rfrom { font-weight: 800; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rfrom.read { font-weight: 700; color: var(--slate); }
        .rtime { font-size: 11px; font-weight: 700; color: var(--muted); flex-shrink: 0; }
        .rsub { font-size: 12.5px; font-weight: 700; margin-top: 2px; color: var(--navy); }
        .rsub.read { font-weight: 600; color: var(--slate); }
        .rprev { font-size: 11.5px; color: var(--muted); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
        .rtags { display: flex; align-items: center; gap: 7px; margin-top: 7px; }
        .pill {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 10px; font-weight: 800;
          padding: 2px 8px; border-radius: 999px;
        }
        .pill-dot { width: 5px; height: 5px; border-radius: 999px; }
        .prio {
          display: inline-flex; align-items: center; gap: 3px;
          font-size: 10px; font-weight: 800; color: #E5484D;
          background: #FFEEEE; padding: 2px 7px; border-radius: 999px;
        }
        .starb { background: none; border: none; cursor: pointer; margin-left: auto; padding: 1px; color: #CBD5DC; }
        .starb.on { color: #FFB020; }
        .unread-dot {
          width: 7px; height: 7px; border-radius: 999px; background: var(--green);
          flex-shrink: 0; margin-top: 15px;
        }
        .empty { text-align: center; padding: 48px 20px; color: var(--muted); font-weight: 700; font-size: 13px; }

        /* Detail */
        .detail { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--panel); }
        .dcard {
          margin: 16px; flex: 1;
          background: var(--white);
          border: 1px solid var(--line);
          border-radius: 16px;
          display: flex; flex-direction: column;
          overflow: hidden;
          box-shadow: 0 2px 8px -4px rgba(14,31,46,0.08);
        }
        .dhead {
          padding: 18px 22px;
          border-bottom: 1px solid var(--line);
          display: flex; align-items: center; gap: 14px;
        }
        .back-btn {
          background: var(--panel); border: 1px solid var(--line);
          border-radius: 9px; padding: 6px; cursor: pointer; color: var(--slate);
        }
        .dsub { font-size: 17px; font-weight: 800; letter-spacing: -0.2px; line-height: 1.25; }
        .dmeta { font-size: 12px; font-weight: 700; color: var(--muted); margin-top: 3px; }
        .dactions { margin-left: auto; display: flex; gap: 7px; flex-shrink: 0; }
        .ibtn {
          background: var(--white); border: 1px solid var(--line);
          border-radius: 9px; padding: 7px; cursor: pointer; color: var(--slate);
          transition: all 0.12s ease;
        }
        .ibtn:hover { border-color: var(--green); color: var(--green-dark); background: var(--green-soft); }

        .dbody { flex: 1; overflow-y: auto; padding: 22px; font-size: 14px; font-weight: 600; line-height: 1.75; color: #2C3E4C; }
        .attach {
          display: inline-flex; align-items: center; gap: 7px;
          margin-top: 16px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 8px 14px;
          font-size: 12px; font-weight: 700; color: var(--slate);
        }
        .replybar {
          margin: 0 16px 16px 16px;
          background: var(--white);
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 8px 8px 8px 16px;
          display: flex; align-items: center; gap: 10px;
          box-shadow: 0 2px 8px -4px rgba(14,31,46,0.08);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .replybar:focus-within { border-color: var(--green); box-shadow: 0 0 0 3px rgba(23,191,80,0.12); }
        .replybar input {
          flex: 1; border: none; outline: none;
          font-family: 'Manrope', sans-serif; font-size: 13.5px; font-weight: 600; color: var(--navy);
        }
        .replybar input::placeholder { color: var(--muted); }
        .sendb {
          background: var(--green); color: white;
          border: none; border-radius: 10px;
          padding: 10px 18px;
          font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 13px;
          display: flex; align-items: center; gap: 7px;
          cursor: pointer;
          transition: background 0.15s ease, transform 0.1s ease;
        }
        .sendb:hover { background: var(--green-dark); }
        .sendb:active { transform: scale(0.96); }

        .nosel {
          flex: 1; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 12px;
        }
        .nosel-t { font-size: 16px; font-weight: 800; }
        .nosel-s { font-size: 13px; font-weight: 600; color: var(--muted); max-width: 240px; text-align: center; }

        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      {/* Top bar */}
      <div className="topbar">
        <LogoMark size={34} />
        <div>
          <div className="brand-name">DASOPERATOR</div>
        </div>
        <span className="brand-tag">Почта</span>
        <div className="stats-strip">
          <div className="stat-chip">
            <Mail size={14} color="#17BF50" />
            Непрочитанные <span className="stat-num">{unreadCount}</span>
          </div>
          <div className="stat-chip">
            <AlertCircle size={14} color="#E5484D" />
            Срочных <span className="stat-num">{urgentCount}</span>
          </div>
          <div className="stat-chip">
            <TrendingUp size={14} color="#7B61FF" />
            Ответов сегодня <span className="stat-num">6</span>
          </div>
        </div>
      </div>

      <div className="main">
        {/* Sidebar */}
        <div className="sidebar">
          <button className="compose">
            <Plus size={16} strokeWidth={3} /> Написать письмо
          </button>

          {FOLDERS.map((f) => {
            const Icon = f.icon;
            const active = activeFolder === f.id;
            const count = f.id === "inbox" ? unreadCount : f.count || 0;
            return (
              <div
                key={f.id}
                className={`folder ${active ? "active" : ""}`}
                onClick={() => { setActiveFolder(f.id); setShowList(true); }}
              >
                <Icon size={16} strokeWidth={2.4} />
                {f.label}
                {count > 0 && <span className="fcount">{count}</span>}
              </div>
            );
          })}

          <div className="sidebar-note">
            <b>2 срочные треда</b> ждут ответа до четверга: слот лаборатории Pioneer и производственный слот Honghui.
          </div>
        </div>

        {/* List */}
        <div className="list" style={{ display: showList ? "flex" : "none" }}>
          <div className="search-wrap">
            <div className="search">
              <Search size={14} color="#93A1AE" />
              <input placeholder="Поиск по письмам..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          <div className="rows">
            {visible.length === 0 && (
              <div className="empty">Здесь пока пусто</div>
            )}
            {visible.map((e) => {
              const tag = TAGS[e.tag];
              return (
                <div
                  key={e.id}
                  className={`row ${selectedId === e.id ? "selected" : ""}`}
                  onClick={() => openEmail(e.id)}
                >
                  {e.unread ? <div className="unread-dot" /> : <div style={{ width: 7, flexShrink: 0 }} />}
                  <div className="ava" style={{ background: e.color }}>{e.initial}</div>
                  <div className="rmain">
                    <div className="rtop">
                      <div className={`rfrom ${e.unread ? "" : "read"}`}>{e.from}</div>
                      <div className="rtime">{e.time}</div>
                    </div>
                    <div className={`rsub ${e.unread ? "" : "read"}`}>{e.subject}</div>
                    <div className="rprev">{e.preview}</div>
                    <div className="rtags">
                      <span className="pill" style={{ background: tag.bg, color: tag.fg }}>
                        <span className="pill-dot" style={{ background: tag.dot }} />
                        {e.tag}
                      </span>
                      {e.priority === "high" && <span className="prio">СРОЧНО</span>}
                      {e.attachments > 0 && (
                        <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, fontWeight: 700, color: "#93A1AE" }}>
                          <Paperclip size={11} /> {e.attachments}
                        </span>
                      )}
                      <button className={`starb ${e.starred ? "on" : ""}`} onClick={(ev) => toggleStar(e.id, ev)}>
                        <Star size={14} fill={e.starred ? "#FFB020" : "none"} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detail */}
        <div className="detail" style={{ display: showList ? "none" : "flex" }}>
          {selected ? (
            <>
              <div className="dcard">
                <div className="dhead">
                  <button className="back-btn" onClick={() => setShowList(true)}>
                    <ChevronLeft size={16} />
                  </button>
                  <div className="ava" style={{ background: selected.color, width: 44, height: 44, fontSize: 14 }}>
                    {selected.initial}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="dsub">{selected.subject}</div>
                    <div className="dmeta">{selected.from} · {selected.org} · {selected.time}</div>
                  </div>
                  <div className="dactions">
                    <button className="ibtn"><Reply size={15} /></button>
                    <button className="ibtn"><Forward size={15} /></button>
                    <button className="ibtn"><Archive size={15} /></button>
                    <button className="ibtn"><Trash2 size={15} /></button>
                    <button className="ibtn"><MoreHorizontal size={15} /></button>
                  </div>
                </div>

                <div className="dbody">
                  {selected.body}
                  {selected.attachments > 0 && (
                    <div>
                      <span className="attach">
                        <Paperclip size={13} />
                        {selected.attachments} вложени{selected.attachments > 1 ? "я" : "е"}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="replybar">
                <input placeholder={`Ответить: ${selected.from}...`} />
                <button className="sendb">
                  <Send size={13} /> Отправить
                </button>
              </div>
            </>
          ) : (
            <div className="nosel">
              <LogoMark size={52} />
              <div className="nosel-t">Выберите письмо</div>
              <div className="nosel-s">Откройте тред слева, чтобы увидеть содержимое и ответить.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
