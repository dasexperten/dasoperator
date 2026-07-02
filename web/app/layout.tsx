import './globals.css';
import type { Metadata, Viewport } from 'next';
import MobileShell from '@/components/layout/mobile-shell';
import ActivityTracker from '@/components/activity-tracker';
import DasKompanionWrapper from '@/components/das-kompanion/das-kompanion-wrapper';

export const runtime = 'edge';

export const metadata: Metadata = {
  title: 'Das Operator',
  description: 'Das Experten ERP — innovativ und praktisch',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#1a1a1a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <MobileShell>{children}</MobileShell>
        <ActivityTracker />
        <DasKompanionWrapper />
        <script
          // Strips native spinner from <input type="number"> and attaches
          // ▲/▼ buttons OUTSIDE the field. CSS in globals.css does the
          // visual side; this script wires interactivity. New inputs added
          // later (e.g. dynamic forms) are picked up by MutationObserver.
          dangerouslySetInnerHTML={{
            __html: `(function(){
  if (typeof window === 'undefined') return;
  var attr = 'data-dx-num-wrapped';
  function nativeValueSetter(el){
    var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    return d && d.set ? d.set.bind(el) : function(v){ el.value = v; };
  }
  function fireInput(el){
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function step(el, dir){
    if (el.disabled || el.readOnly) return;
    try {
      var prev = el.value;
      if (dir > 0) el.stepUp(); else el.stepDown();
      var next = el.value;
      if (next !== prev) {
        var setter = nativeValueSetter(el);
        setter(next);
        fireInput(el);
      }
    } catch (e) { /* invalid step config — ignore */ }
  }
  function wrap(el){
    if (!el || el.getAttribute(attr) === '1') return;
    if (el.type !== 'number') return;
    var parent = el.parentNode;
    if (!parent) return;
    var wrap = document.createElement('span');
    wrap.className = 'dx-num-wrap';
    parent.insertBefore(wrap, el);
    wrap.appendChild(el);
    var spin = document.createElement('span');
    spin.className = 'dx-num-spin';
    var up = document.createElement('button');
    up.type = 'button'; up.tabIndex = -1; up.setAttribute('aria-label','Increase');
    up.textContent = '▲';
    up.addEventListener('mousedown', function(ev){ ev.preventDefault(); step(el, +1); });
    var dn = document.createElement('button');
    dn.type = 'button'; dn.tabIndex = -1; dn.setAttribute('aria-label','Decrease');
    dn.textContent = '▼';
    dn.addEventListener('mousedown', function(ev){ ev.preventDefault(); step(el, -1); });
    spin.appendChild(up);
    spin.appendChild(dn);
    wrap.appendChild(spin);
    el.setAttribute(attr, '1');
  }
  function scan(root){
    var nodes = (root || document).querySelectorAll('input[type="number"]:not([' + attr + '="1"])');
    for (var i=0; i<nodes.length; i++) wrap(nodes[i]);
  }
  function init(){
    scan(document);
    new MutationObserver(function(muts){
      for (var i=0; i<muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j=0; j<added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('input[type="number"]')) wrap(n);
          else if (n.querySelectorAll) scan(n);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWhenReady);
  } else {
    startWhenReady();
  }

  function startWhenReady(){
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        init();
      });
    });
  }
})();`,
          }}
        />
        <script
          // Mobile stacked-card LABELS. On phones globals.css turns every
          // <main> table into a stack of cards and hides the <thead>. Without
          // the header a cell shows a bare value ("128,000 ₽") with no idea
          // which column it is. This copies each <th> caption onto the matching
          // <td> as data-dx-col; CSS (v3.5) prints it as the row's left label.
          // Runs once + on every DOM mutation (tables arrive after data fetch).
          // Attributes are inert on desktop (the ::before is media-query gated).
          dangerouslySetInnerHTML={{
            __html: `(function(){
  if (typeof window === 'undefined') return;
  function headerLabels(table){
    var head = table.tHead;
    if (!head || !head.rows.length) return null;
    var row = head.rows[head.rows.length - 1];
    var out = [], ci = 0;
    for (var i=0; i<row.cells.length; i++){
      var span = row.cells[i].colSpan || 1;
      var txt = (row.cells[i].textContent || '').replace(/\\s+/g,' ').trim();
      for (var s=0; s<span; s++) out[ci++] = txt;
    }
    return out;
  }
  // Which header names mark the ONE primary number of a row (spec: one primary
  // number per card). First match wins; else the last numeric-looking column.
  var DX_PRIMARY = /total|amount|sum|balance|\\bnet\\b|price|cost|debt|стоим|сумм|остат|баланс|цена|долг/i;
  function primaryIndex(labels, table){
    for (var i=0; i<labels.length; i++) if (labels[i] && DX_PRIMARY.test(labels[i])) return i;
    var bodies = table.tBodies;
    if (bodies.length && bodies[0].rows.length){
      var cells = bodies[0].rows[0].cells;
      for (var j=labels.length-1; j>=1; j--){ var c=cells[j]; if (c && /[0-9]/.test(c.textContent||'')) return j; }
    }
    return -1;
  }
  function onCardTap(ev){
    var t = ev.target;
    while (t && t !== this){
      var tag = t.tagName;
      if (tag==='A'||tag==='BUTTON'||tag==='INPUT'||tag==='SELECT'||tag==='LABEL') return;
      t = t.parentNode;
    }
    this.classList.toggle('dx-expanded');
  }
  // Turn each body row into a DISCLOSURE card: mark the title cell, the one
  // primary-number cell, and detail cells; wire a tap that reveals the details.
  // data-dx-col still carries each column caption for the expanded label rows.
  function cardify(table){
    var labels = headerLabels(table);
    if (!labels) return;
    var pidx = primaryIndex(labels, table);
    var bodies = table.tBodies;
    for (var b=0; b<bodies.length; b++){
      var rows = bodies[b].rows;
      for (var r=0; r<rows.length; r++){
        var tr = rows[r], cells = tr.cells, ci = 0, hasPrimary = false;
        for (var c=0; c<cells.length; c++){
          var cell = cells[c], span = cell.colSpan || 1;
          if (cell.tagName === 'TD'){
            var lbl = span === 1 ? (labels[ci] || '') : '';
            if (lbl) cell.setAttribute('data-dx-col', lbl); else cell.removeAttribute('data-dx-col');
            var role = c === 0 ? 'title' : (ci === pidx ? 'primary' : 'detail');
            if (role === 'primary') hasPrimary = true;
            cell.setAttribute('data-dx-role', role);
          }
          ci += span;
        }
        tr.classList.add('dx-card');
        // Only collapse rows that actually have a big number to surface;
        // label-only rows stay fully visible.
        if (hasPrimary){
          tr.classList.add('dx-has-primary');
          if (tr.getAttribute('data-dx-tap') !== '1'){
            tr.setAttribute('data-dx-tap', '1');
            tr.addEventListener('click', onCardTap);
          }
        }
      }
    }
  }
  function colCount(table){
    var head = table.tHead;
    if (!head || !head.rows.length) return 0;
    var row = head.rows[head.rows.length - 1], n = 0;
    for (var i=0; i<row.cells.length; i++) n += row.cells[i].colSpan || 1;
    return n;
  }
  function makeWideScroll(table){
    if (table.getAttribute('data-dx-wide') === '1') return;
    table.setAttribute('data-dx-wide', '1');
    table.classList.add('dx-wide-table');
    var p = table.parentNode;
    if (p && !(p.classList && p.classList.contains('dx-scroll-x'))){
      var w = document.createElement('div');
      w.className = 'dx-scroll-x';
      p.insertBefore(w, table);
      w.appendChild(table);
    }
  }
  function processTable(table){
    // Many-column matrices (stock by warehouse, promo grids) read badly as a
    // tall stack of "column: —" rows and can't be scanned across. Keep them a
    // compact, horizontally-scrollable table. Narrow list tables become the
    // labelled cards. Threshold: > 6 columns.
    if (colCount(table) > 6) makeWideScroll(table);
    else cardify(table);
  }
  function scan(){
    var main = document.querySelector('main');
    if (!main) return;
    var tables = main.querySelectorAll('table');
    for (var i=0; i<tables.length; i++) processTable(tables[i]);
  }
  var scheduled = false;
  function schedule(){
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function(){ scheduled = false; scan(); });
  }
  function init(){
    scan();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`,
          }}
        />
      </body>
    </html>
  );
}
