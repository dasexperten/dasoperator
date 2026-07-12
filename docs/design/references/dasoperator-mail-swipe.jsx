import React, { useState, useMemo, useRef } from "react";
import {
  Search, Star, Archive, Trash2, Send, Inbox as InboxIcon,
  FileText, Paperclip, Plus, Reply, Forward, ArrowLeft,
  MoreVertical, Mail, AlertCircle, X, Undo2
} from "lucide-react";

/* ================================================================
   DASOPERATOR MAIL — Android + SWIPE GESTURES (pure touch events)
   Swipe RIGHT  → archive (green reveal)
   Swipe LEFT   → delete  (red reveal)
   Threshold 35% of row width; below → snap back.
   Undo snackbar after every swipe action. No gesture libraries.
   ================================================================ */

function LogoMark({ size = 34 }) {
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
  { id: "archive", label: "Архив", icon: Archive },
  { id: "drafts", label: "Черновики", icon: FileText },
];

const TAGS = {
  Производство: { bg: "#EAF9F0", fg: "#109A3F", dot: "#17BF50" },
  Маркетплейс: { bg: "#F0EDFF", fg: "#7B61FF", dot: "#7B61FF" },
  Юридическое: { bg: "#FFF4E5", fg: "#F5920A", dot: "#F5920A" },
  Сертификация: { bg: "#E8F4FF", fg: "#1B84FF", dot: "#1B84FF" },
  Развитие: { bg: "#FFEDF3", fg: "#F0447C", dot: "#F0447C" },
};

const INITIAL_EMAILS = [
  {
    id: 1, folder: "inbox",
    from: "Ellen Wei", org: "Guangzhou Honghui",
    initial: "EW", color: "#17BF50",
    subject: "MF01-DEE/MZ — печати проставлены, ждём USCC",
    preview: "Контракт OEM по 9 SKU подписан обеими сторонами. Ожидаем документ USCC...",
    body: "Контракт OEM по 9 SKU зубной пасты подписан и проштампован обеими сторонами. Ожидаем документ USCC с нашей стороны, после чего передадим полный пакет в Pioneer для подачи по ТР ТС 009/2011. Просим подтвердить ожидаемую дату старта сертификации, чтобы согласовать производственный слот.",
    time: "09:14", unread: true, starred: true, tag: "Производство", attachments: 2, priority: "high",
  },
  {
    id: 2, folder: "inbox",
    from: "Алёна", org: "Wildberries",
    initial: "АЛ", color: "#7B61FF",
    subject: "Доверенность M-2 принята складом",
    preview: "Подтверждаем получение доверенности. Приёмка завтра, окно с 10:00 до 14:00...",
    body: "Подтверждаем получение доверенности на получение товара со склада. Приёмка запланирована на завтра, окно с 10:00 до 14:00. Просим представителя прибыть с оригиналом паспорта.",
    time: "08:47", unread: true, starred: false, tag: "Маркетплейс", attachments: 1, priority: "normal",
  },
  {
    id: 3, folder: "inbox",
    from: "Виктор Белугин", org: "Pioneer Certification",
    initial: "ВБ", color: "#1B84FF",
    subject: "3 протокола паст — слот лаборатории подтверждён",
    preview: "Лаборатория подтвердила слот на тестирование. Письма нужны до четверга...",
    body: "Лаборатория подтвердила слот на тестирование трёх типов протоколов по ТР ТС 009/2011. Для сохранения слота нужны письма-подтверждения производителя (подписант Ellen Wei / WDAA) до четверга.",
    time: "Вчера", unread: false, starred: true, tag: "Сертификация", attachments: 3, priority: "high",
  },
  {
    id: 4, folder: "inbox",
    from: "Dora", org: "TikTok Shop Vietnam",
    initial: "DO", color: "#F0447C",
    subject: "Документы CNP — вторая апелляция подана",
    preview: "Вторая апелляция по DasExpertenVN подана. Рассмотрение 3–5 рабочих дней...",
    body: "Вторая апелляция по DasExpertenVN подана с обновлённой документацией CNP от нас с Tran. Рассмотрение обычно занимает 3–5 рабочих дней. Сообщу сразу, как будет ответ.",
    time: "Вчера", unread: false, starred: false, tag: "Развитие", attachments: 0, priority: "normal",
  },
  {
    id: 5, folder: "drafts",
    from: "Вы", org: "Черновик",
    initial: "АБ", color: "#F5920A",
    subject: "Re: Рубен Даниелян — разрешение на ввод",
    preview: "Спасибо за подтверждение кадастровой справки. Прикладываю документы...",
    body: "Спасибо за подтверждение кадастровой справки (152 млн AMD). Прикладываю недостающие документы для ГАСК и УТФСИБ.",
    time: "Пн", unread: false, starred: false, tag: "Юридическое", attachments: 1, priority: "normal",
  },
];

/* ================================================================
   SwipeableRow — pure touch events, no libraries
   ================================================================ */
function SwipeableRow({ email, onOpen, onStar, onArchive, onDelete }) {
  const [dx, setDx] = useState(0);          // current horizontal offset
  const [animating, setAnimating] = useState(false); // snap-back / fly-out uses CSS transition
  const [leaving, setLeaving] = useState(null); // "left" | "right" | null — collapse phase
  const touch = useRef({ startX: 0, startY: 0, active: false, locked: null, width: 1 });

  const THRESHOLD = 0.35; // 35% of row width commits the action

  const onTouchStart = (e) => {
    const t = e.touches[0];
    touch.current = {
      startX: t.clientX,
      startY: t.clientY,
      active: true,
      locked: null, // undecided: horizontal swipe vs vertical scroll
      width: e.currentTarget.offsetWidth || 1,
    };
    setAnimating(false);
  };

  const onTouchMove = (e) => {
    if (!touch.current.active) return;
    const t = e.touches[0];
    const moveX = t.clientX - touch.current.startX;
    const moveY = t.clientY - touch.current.startY;

    // Direction lock: decide once, after 8px of movement
    if (touch.current.locked === null) {
      if (Math.abs(moveX) < 8 && Math.abs(moveY) < 8) return;
      touch.current.locked = Math.abs(moveX) > Math.abs(moveY) ? "h" : "v";
    }
    if (touch.current.locked === "v") return; // let the list scroll

    // Horizontal: rubber-band slightly past ±width
    const w = touch.current.width;
    const clamped = Math.max(-w, Math.min(w, moveX));
    setDx(clamped);
  };

  const commit = (dir) => {
    const w = touch.current.width;
    setAnimating(true);
    setDx(dir === "right" ? w : -w); // fly out
    // after fly-out, collapse height, then fire action
    setTimeout(() => setLeaving(dir), 180);
    setTimeout(() => {
      dir === "right" ? onArchive(email.id) : onDelete(email.id);
    }, 380);
  };

  const onTouchEnd = () => {
    if (!touch.current.active) return;
    touch.current.active = false;
    if (touch.current.locked !== "h") { setDx(0); return; }

    const w = touch.current.width;
    if (dx > w * THRESHOLD) commit("right");
    else if (dx < -w * THRESHOLD) commit("left");
    else {
      setAnimating(true);
      setDx(0); // snap back
    }
  };

  // Reveal intensity 0..1 for background opacity/icon scale
  const progress = Math.min(1, Math.abs(dx) / (touch.current.width * THRESHOLD || 1));
  const dir = dx > 0 ? "right" : dx < 0 ? "left" : null;
  const tag = TAGS[email.tag];

  return (
    <div className={`sw-outer ${leaving ? "leaving" : ""}`}>
      {/* Reveal background */}
      <div
        className="sw-bg"
        style={{
          background: dir === "right" ? "#17BF50" : dir === "left" ? "#E5484D" : "transparent",
          opacity: dir ? 0.15 + progress * 0.85 : 0,
        }}
      >
        <div className="sw-bg-icon left" style={{ opacity: dir === "right" ? 1 : 0, transform: `scale(${0.7 + progress * 0.4})` }}>
          <Archive size={22} color="white" strokeWidth={2.5} />
          <span>В архив</span>
        </div>
        <div className="sw-bg-icon right" style={{ opacity: dir === "left" ? 1 : 0, transform: `scale(${0.7 + progress * 0.4})` }}>
          <span>Удалить</span>
          <Trash2 size={22} color="white" strokeWidth={2.5} />
        </div>
      </div>

      {/* Foreground row */}
      <div
        className={`mb-row ${animating ? "animating" : ""}`}
        style={{ transform: `translateX(${dx}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClick={() => { if (Math.abs(dx) < 4 && !leaving) onOpen(email.id); }}
      >
        {email.unread && <div className="mb-unread-bar" />}
        <div className="ava" style={{ background: email.color }}>{email.initial}</div>
        <div className="mb-rmain">
          <div className="mb-rtop">
            <div className={`mb-rfrom ${email.unread ? "" : "read"}`}>{email.from}</div>
            <div className="mb-rtime">{email.time}</div>
          </div>
          <div className={`mb-rsub ${email.unread ? "" : "read"}`}>{email.subject}</div>
          <div className="mb-rprev">{email.preview}</div>
          <div className="mb-rtags">
            <span className="pill" style={{ background: tag.bg, color: tag.fg }}>
              <span className="pill-dot" style={{ background: tag.dot }} />
              {email.tag}
            </span>
            {email.priority === "high" && <span className="prio">СРОЧНО</span>}
            {email.attachments > 0 && (
              <span className="clip"><Paperclip size={11} /> {email.attachments}</span>
            )}
            <button className={`starb ${email.starred ? "on" : ""}`} onClick={(ev) => onStar(email.id, ev)} aria-label="Пометить важным">
              <Star size={17} fill={email.starred ? "#FFB020" : "none"} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   MAIN
   ================================================================ */
export default function DasOperatorMailSwipe() {
  const [activeFolder, setActiveFolder] = useState("inbox");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [openedId, setOpenedId] = useState(null);
  const [emails, setEmails] = useState(INITIAL_EMAILS);
  const [snackbar, setSnackbar] = useState(null); // { text, prevEmails }
  const snackTimer = useRef(null);

  const visible = useMemo(() => {
    let list = emails.filter((e) =>
      activeFolder === "starred" ? e.starred && e.folder !== "trash" : e.folder === activeFolder
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

  const unreadCount = emails.filter((e) => e.folder === "inbox" && e.unread).length;
  const urgentCount = emails.filter((e) => e.folder === "inbox" && e.priority === "high").length;

  const showSnack = (text, prevEmails) => {
    clearTimeout(snackTimer.current);
    setSnackbar({ text, prevEmails });
    snackTimer.current = setTimeout(() => setSnackbar(null), 4000);
  };
  const undo = () => {
    if (snackbar) setEmails(snackbar.prevEmails);
    clearTimeout(snackTimer.current);
    setSnackbar(null);
  };

  const toggleStar = (id, ev) => {
    ev.stopPropagation();
    setEmails((p) => p.map((e) => (e.id === id ? { ...e, starred: !e.starred } : e)));
  };
  const openEmail = (id) => {
    setOpenedId(id);
    setEmails((p) => p.map((e) => (e.id === id ? { ...e, unread: false } : e)));
  };
  const archiveEmail = (id) => {
    setEmails((prev) => {
      showSnack("Перемещено в архив", prev);
      return prev.map((e) => (e.id === id ? { ...e, folder: "archive" } : e));
    });
  };
  const deleteEmail = (id) => {
    setEmails((prev) => {
      showSnack("Письмо удалено", prev);
      return prev.filter((e) => e.id !== id);
    });
  };

  const opened = emails.find((e) => e.id === openedId);
  const folderLabel = FOLDERS.find((f) => f.id === activeFolder)?.label || "";

  return (
    <div className="phone">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&display=swap');
        :root {
          --green: #17BF50; --green-dark: #109A3F; --green-soft: #EAF9F0;
          --navy: #0E1F2E; --slate: #5B6B7A; --muted: #93A1AE;
          --line: #E7ECF0; --panel: #F5F7F9; --white: #FFFFFF;
        }
        * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
        .phone {
          font-family: 'Manrope', sans-serif; background: var(--panel); color: var(--navy);
          height: 100vh; width: 100%; max-width: 480px; margin: 0 auto;
          display: flex; flex-direction: column; overflow: hidden; position: relative;
        }
        .appbar { background: var(--white); border-bottom: 1px solid var(--line); padding: 12px 14px; display: flex; align-items: center; gap: 11px; flex-shrink: 0; min-height: 60px; }
        .title { font-size: 17px; font-weight: 800; letter-spacing: -0.2px; }
        .sub { font-size: 11px; font-weight: 700; color: var(--muted); margin-top: 1px; }
        .abtn { background: none; border: none; padding: 10px; border-radius: 999px; cursor: pointer; color: var(--slate); display: flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; }
        .abtn:active { background: var(--panel); }
        .searchbar { flex: 1; display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 10px 14px; }
        .searchbar input { border: none; outline: none; background: transparent; font-family: 'Manrope', sans-serif; font-size: 14px; font-weight: 600; width: 100%; color: var(--navy); }
        .searchbar input::placeholder { color: var(--muted); }
        .stats { display: flex; gap: 8px; padding: 10px 14px; overflow-x: auto; flex-shrink: 0; background: var(--white); border-bottom: 1px solid var(--line); scrollbar-width: none; }
        .stats::-webkit-scrollbar { display: none; }
        .chip { display: flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; font-size: 11.5px; font-weight: 700; color: var(--slate); white-space: nowrap; flex-shrink: 0; }
        .chip b { color: var(--navy); font-size: 13px; }
        .hint { padding: 8px 14px; font-size: 11px; font-weight: 700; color: var(--muted); display: flex; align-items: center; gap: 6px; }

        .rows { overflow-y: auto; flex: 1; padding-bottom: 150px; }

        /* ---- Swipe machinery ---- */
        .sw-outer {
          position: relative; overflow: hidden;
          max-height: 200px;
          transition: max-height 0.2s ease 0.18s, opacity 0.2s ease 0.18s;
        }
        .sw-outer.leaving { max-height: 0; opacity: 0; }
        .sw-bg {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: space-between;
          padding: 0 22px;
          transition: opacity 0.05s linear;
        }
        .sw-bg-icon {
          display: flex; align-items: center; gap: 8px;
          color: white; font-size: 12.5px; font-weight: 800;
          transition: transform 0.08s ease;
        }
        .mb-row {
          background: var(--white); padding: 14px; border-bottom: 1px solid var(--line);
          display: flex; gap: 12px; cursor: pointer; position: relative; min-height: 72px;
          touch-action: pan-y; /* we handle horizontal, browser handles vertical */
          will-change: transform;
        }
        .mb-row.animating { transition: transform 0.18s ease; }

        .ava { width: 44px; height: 44px; border-radius: 13px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; color: white; flex-shrink: 0; }
        .mb-rmain { flex: 1; min-width: 0; }
        .mb-rtop { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; }
        .mb-rfrom { font-weight: 800; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mb-rfrom.read { font-weight: 700; color: var(--slate); }
        .mb-rtime { font-size: 11px; font-weight: 700; color: var(--muted); flex-shrink: 0; }
        .mb-rsub { font-size: 13px; font-weight: 700; margin-top: 2px; }
        .mb-rsub.read { font-weight: 600; color: var(--slate); }
        .mb-rprev { font-size: 12px; color: var(--muted); font-weight: 600; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
        .mb-rtags { display: flex; align-items: center; gap: 7px; margin-top: 8px; flex-wrap: wrap; }
        .mb-unread-bar { position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: var(--green); }
        .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 800; padding: 3px 9px; border-radius: 999px; }
        .pill-dot { width: 5px; height: 5px; border-radius: 999px; }
        .prio { font-size: 10px; font-weight: 800; color: #E5484D; background: #FFEEEE; padding: 3px 8px; border-radius: 999px; }
        .clip { display: flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 700; color: var(--muted); }
        .starb { background: none; border: none; cursor: pointer; padding: 8px; margin: -8px -4px -8px auto; color: #CBD5DC; min-width: 40px; min-height: 40px; display: flex; align-items: center; justify-content: center; }
        .starb.on { color: #FFB020; }
        .empty { text-align: center; padding: 60px 24px; color: var(--muted); font-weight: 700; font-size: 14px; }

        .fab { position: absolute; right: 16px; bottom: 86px; background: var(--green); color: white; border: none; border-radius: 18px; padding: 16px 20px; font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 14.5px; display: flex; align-items: center; gap: 9px; cursor: pointer; box-shadow: 0 8px 20px -4px rgba(23,191,80,0.5); z-index: 20; }
        .fab:active { transform: scale(0.94); background: var(--green-dark); }

        .nav { position: absolute; left: 0; right: 0; bottom: 0; background: var(--white); border-top: 1px solid var(--line); display: flex; padding: 6px 4px calc(10px + env(safe-area-inset-bottom, 0px)) 4px; z-index: 20; }
        .navitem { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; background: none; border: none; cursor: pointer; padding: 6px 0; color: var(--muted); font-family: 'Manrope', sans-serif; font-size: 10.5px; font-weight: 700; }
        .iconwrap { padding: 5px 16px; border-radius: 999px; position: relative; }
        .navitem.active { color: var(--green-dark); }
        .navitem.active .iconwrap { background: var(--green-soft); }
        .navbadge { position: absolute; top: -1px; right: 8px; background: var(--green); color: white; font-size: 9px; font-weight: 800; min-width: 16px; height: 16px; border-radius: 999px; display: flex; align-items: center; justify-content: center; padding: 0 4px; border: 2px solid var(--white); }

        /* Snackbar */
        .snackbar {
          position: absolute; left: 14px; right: 14px; bottom: 80px;
          background: var(--navy); color: white;
          border-radius: 14px; padding: 13px 16px;
          display: flex; align-items: center; gap: 10px;
          font-size: 13px; font-weight: 700;
          box-shadow: 0 8px 24px -6px rgba(14,31,46,0.4);
          z-index: 40;
          animation: snackIn 0.2s ease;
        }
        @keyframes snackIn { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .undo-btn {
          margin-left: auto; background: none; border: none;
          color: #4ADE80; font-family: 'Manrope', sans-serif;
          font-size: 13px; font-weight: 800; cursor: pointer;
          display: flex; align-items: center; gap: 5px;
          padding: 6px 8px; min-height: 40px;
        }

        /* Detail */
        .detail { position: absolute; inset: 0; background: var(--panel); display: flex; flex-direction: column; z-index: 30; animation: slideIn 0.22s ease; }
        @keyframes slideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .dwrap { flex: 1; overflow-y: auto; padding: 14px; }
        .dcard { background: var(--white); border: 1px solid var(--line); border-radius: 16px; padding: 18px 16px; box-shadow: 0 2px 8px -4px rgba(14,31,46,0.08); }
        .dsub { font-size: 17px; font-weight: 800; line-height: 1.3; }
        .dfrom { display: flex; align-items: center; gap: 11px; margin-top: 14px; }
        .dname { font-size: 13.5px; font-weight: 800; }
        .dorg { font-size: 11.5px; font-weight: 700; color: var(--muted); margin-top: 1px; }
        .dtext { font-size: 14.5px; font-weight: 600; line-height: 1.75; color: #2C3E4C; margin-top: 16px; }
        .attach { display: inline-flex; align-items: center; gap: 7px; margin-top: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 14px; font-size: 12px; font-weight: 700; color: var(--slate); }
        .actions { display: flex; gap: 8px; margin-top: 14px; }
        .action { flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px; background: var(--white); border: 1px solid var(--line); border-radius: 12px; padding: 12px; font-family: 'Manrope', sans-serif; font-size: 12.5px; font-weight: 800; color: var(--slate); cursor: pointer; min-height: 46px; }
        .action:active { background: var(--green-soft); border-color: var(--green); color: var(--green-dark); }
        .replybar { flex-shrink: 0; margin: 0 14px calc(14px + env(safe-area-inset-bottom, 0px)) 14px; background: var(--white); border: 1px solid var(--line); border-radius: 999px; padding: 6px 6px 6px 16px; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 14px -6px rgba(14,31,46,0.15); }
        .replybar input { flex: 1; border: none; outline: none; font-family: 'Manrope', sans-serif; font-size: 14px; font-weight: 600; color: var(--navy); min-width: 0; }
        .sendb { background: var(--green); color: white; border: none; border-radius: 999px; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
        .sendb:active { transform: scale(0.92); background: var(--green-dark); }

        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      `}</style>

      {/* App bar */}
      <div className="appbar">
        {searchOpen ? (
          <>
            <div className="searchbar">
              <Search size={16} color="#93A1AE" />
              <input autoFocus placeholder="Поиск по письмам..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="abtn" onClick={() => { setSearchOpen(false); setQuery(""); }} aria-label="Закрыть поиск"><X size={20} /></button>
          </>
        ) : (
          <>
            <LogoMark size={34} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="title">DASOPERATOR</div>
              <div className="sub">{folderLabel} · {visible.length}</div>
            </div>
            <button className="abtn" onClick={() => setSearchOpen(true)} aria-label="Поиск"><Search size={20} /></button>
            <button className="abtn" aria-label="Меню"><MoreVertical size={20} /></button>
          </>
        )}
      </div>

      {/* Stats */}
      <div className="stats">
        <div className="chip"><Mail size={13} color="#17BF50" /> Непрочитанных <b>{unreadCount}</b></div>
        <div className="chip"><AlertCircle size={13} color="#E5484D" /> Срочные <b>{urgentCount}</b></div>
      </div>

      {/* Gesture hint */}
      <div className="hint">
        <Archive size={12} color="#17BF50" /> свайп вправо — архив
        <span style={{ margin: "0 2px" }}>·</span>
        <Trash2 size={12} color="#E5484D" /> свайп влево — удалить
      </div>

      {/* Rows */}
      <div className="rows">
        {visible.length === 0 && <div className="empty">Здесь пока пусто</div>}
        {visible.map((e) => (
          <SwipeableRow
            key={e.id}
            email={e}
            onOpen={openEmail}
            onStar={toggleStar}
            onArchive={archiveEmail}
            onDelete={deleteEmail}
          />
        ))}
      </div>

      {/* FAB */}
      <button className="fab"><Plus size={19} strokeWidth={3} /> Написать</button>

      {/* Bottom nav */}
      <div className="nav">
        {FOLDERS.map((f) => {
          const Icon = f.icon;
          const active = activeFolder === f.id;
          const badge = f.id === "inbox" ? unreadCount : 0;
          return (
            <button key={f.id} className={`navitem ${active ? "active" : ""}`} onClick={() => { setActiveFolder(f.id); setOpenedId(null); }}>
              <span className="iconwrap">
                <Icon size={20} strokeWidth={2.4} />
                {badge > 0 && <span className="navbadge">{badge}</span>}
              </span>
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Undo snackbar */}
      {snackbar && (
        <div className="snackbar">
          {snackbar.text}
          <button className="undo-btn" onClick={undo}>
            <Undo2 size={15} /> ОТМЕНИТЬ
          </button>
        </div>
      )}

      {/* Detail overlay */}
      {opened && (
        <div className="detail">
          <div className="appbar">
            <button className="abtn" onClick={() => setOpenedId(null)} aria-label="Назад"><ArrowLeft size={21} /></button>
            <div style={{ flex: 1 }} />
            <button className="abtn" onClick={() => { archiveEmail(opened.id); setOpenedId(null); }} aria-label="В архив"><Archive size={19} /></button>
            <button className="abtn" onClick={() => { deleteEmail(opened.id); setOpenedId(null); }} aria-label="Удалить"><Trash2 size={19} /></button>
            <button className="abtn" aria-label="Ещё"><MoreVertical size={19} /></button>
          </div>

          <div className="dwrap">
            <div className="dcard">
              <div className="dsub">{opened.subject}</div>
              <div className="dfrom">
                <div className="ava" style={{ width: 42, height: 42, background: opened.color, fontSize: 13 }}>{opened.initial}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="dname">{opened.from}</div>
                  <div className="dorg">{opened.org} · {opened.time}</div>
                </div>
                <button className={`starb ${opened.starred ? "on" : ""}`} onClick={(ev) => toggleStar(opened.id, ev)} aria-label="Пометить важным">
                  <Star size={19} fill={opened.starred ? "#FFB020" : "none"} />
                </button>
              </div>
              <div className="dtext">{opened.body}</div>
              {opened.attachments > 0 && (
                <div>
                  <span className="attach">
                    <Paperclip size={13} />
                    {opened.attachments} вложени{opened.attachments > 1 ? "я" : "е"}
                  </span>
                </div>
              )}
            </div>
            <div className="actions">
              <button className="action"><Reply size={15} /> Ответить</button>
              <button className="action"><Forward size={15} /> Переслать</button>
            </div>
          </div>

          <div className="replybar">
            <input placeholder={`Ответить: ${opened.from}...`} />
            <button className="sendb" aria-label="Отправить"><Send size={17} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
