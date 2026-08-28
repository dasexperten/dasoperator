// =============================================================================
// md-lite — renders the subset of Markdown that LEARNING / MEMORY bodies use:
// **bold**, *italic*, `code`, #### headings, "- " bullets, blank-line
// paragraphs and [text](url) links. It builds React elements, never HTML
// strings, so nothing from the corpus can inject markup into the page.
// Deliberately no dependency: the bodies are short and hand-written.
// =============================================================================

import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) {
      out.push(
        <code key={k} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.92em' }}>
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith('[')) {
      const close = tok.indexOf('](');
      const label = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--fg-link)' }}>
          {label}
        </a>
      );
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function MdLite({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let n = 0;

  const flushPara = () => {
    if (!para.length) return;
    const k = `p${n++}`;
    blocks.push(
      <p key={k} style={{ margin: '0 0 10px' }}>
        {para.map((l, j) => (
          <span key={`${k}-${j}`}>
            {inline(l, `${k}-${j}`)}
            {j < para.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const k = `ul${n++}`;
    blocks.push(
      <ul key={k} style={{ margin: '0 0 10px', paddingLeft: 20 }}>
        {list.map((l, j) => <li key={`${k}-${j}`}>{inline(l, `${k}-${j}`)}</li>)}
      </ul>
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const k = `h${n++}`;
      blocks.push(
        <div key={k} style={{ fontWeight: 700, margin: '12px 0 6px', fontSize: h[1].length <= 3 ? 15 : 14 }}>
          {inline(h[2], k)}
        </div>
      );
    } else if (li) {
      flushPara();
      list.push(li[1]);
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();

  return (
    <div style={{
      fontFamily: 'var(--font-body)', fontSize: 14, lineHeight: 1.55, color: 'var(--fg-1)',
      wordBreak: 'break-word', margin: '0 0 16px',
    }}>
      {blocks}
    </div>
  );
}
