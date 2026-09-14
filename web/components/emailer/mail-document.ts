/** Presentation only: never alters the message stored in Gmail. */
export function mailDocument(html: string, originalFormatting = false): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // CSP is placed first below. Remove sender document controls in both modes.
  doc.querySelectorAll('script,meta,base,link,iframe,object,embed,form').forEach(el => el.remove());
  if (!originalFormatting) {
    // Inline !important declarations outrank our stylesheet: remove just the
    // paint properties, keeping the sender's layout and semantic content.
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
      for (const name of Array.from(el.style)) {
        if (/^(color|background(?:-.+)?|-webkit-text-fill-color|text-shadow|opacity|filter|mix-blend-mode)$/.test(name)) el.style.removeProperty(name);
      }
    }
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>('body,body *'))) {
      const ink = el.closest('a') ? '#0D199E' : '#282229';
      for (const [name, value] of Object.entries({color:ink, 'background-color':'#fff', 'background-image':'none', '-webkit-text-fill-color':ink, 'text-shadow':'none', opacity:'1', filter:'none', 'mix-blend-mode':'normal'})) el.style?.setProperty(name, value, 'important');
    }
  }
  const readable = originalFormatting ? '' : `
    html,body,body * {color:#282229!important;background-color:#fff!important;background-image:none!important;-webkit-text-fill-color:#282229!important;text-shadow:none!important;opacity:1!important;filter:none!important;mix-blend-mode:normal!important}
    body a,body a * {color:#0D199E!important;-webkit-text-fill-color:#0D199E!important;text-decoration:underline!important}
    body *::before,body *::after {color:#282229!important;background:transparent!important;text-shadow:none!important}
  `;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">${doc.head.innerHTML}<style>html{color-scheme:only light}body{font:14px/1.6 Arial,sans-serif;overflow-wrap:anywhere;margin:12px;color:#282229;background:#fff}img{max-width:100%;height:auto}table{max-width:100%}${readable}</style></head>${doc.body.outerHTML}</html>`;
}
