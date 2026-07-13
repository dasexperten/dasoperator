import './globals.css';
import type { Metadata, Viewport } from 'next';
import MobileShell from '@/components/layout/mobile-shell';
import ActivityTracker from '@/components/activity-tracker';
import DasKompanionWrapper from '@/components/das-kompanion/das-kompanion-wrapper';

export const runtime = 'edge';

export const metadata: Metadata = {
  title: 'Das Operator',
  description: 'Das Experten ERP — innovativ und praktisch',
  applicationName: 'Das Operator',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/app-icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/brand/app-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/brand/app-icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Das Operator',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#282229',
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
          // Mobile table->card labeller. Below 768px globals.css turns each
          // table row into a card; this copies the column header text onto
          // every <td> as data-label so the card shows "Label: value" instead
          // of bare values. Bespoke inline tables get labelled for free, no
          // per-page edits. Re-runs on data load / route change via
          // MutationObserver, mirroring the number-spinner script above.
          dangerouslySetInnerHTML={{
            __html: `(function(){
  if (typeof window === 'undefined') return;
  var mq = window.matchMedia('(max-width: 767px)');
  function text(el){ return (el.textContent || '').replace(/\\s+/g,' ').trim(); }
  function labelTable(table){
    if (!table || table.classList.contains('dx-keep-table')) return;
    if (table.closest && !table.closest('main')) return;
    var headRow = table.querySelector('thead tr');
    if (!headRow) return;
    var heads = headRow.children;
    var labels = [];
    for (var h=0; h<heads.length; h++){
      var span = (heads[h].getAttribute('colspan')|0) || 1;
      var t = text(heads[h]);
      for (var s=0; s<span; s++) labels.push(t);
    }
    var bodyRows = table.querySelectorAll('tbody tr');
    for (var r=0; r<bodyRows.length; r++){
      var cells = bodyRows[r].children, col = 0;
      for (var c=0; c<cells.length; c++){
        var cell = cells[c];
        if (cell.tagName !== 'TD'){ col += (cell.getAttribute('colspan')|0) || 1; continue; }
        // idempotent: skip cells already labelled (by us or the page)
        if (!cell.hasAttribute('data-label') && labels[col] != null) {
          cell.setAttribute('data-label', labels[col]);
        }
        col += (cell.getAttribute('colspan')|0) || 1;
      }
    }
  }
  function scan(root){
    if (!mq.matches) return;
    var tables = (root || document).querySelectorAll('main table');
    for (var i=0; i<tables.length; i++) labelTable(tables[i]);
  }
  function handle(n){
    if (n.nodeType !== 1) return;
    if (n.tagName === 'TABLE') { labelTable(n); return; }
    // a row/cell added to an existing table — re-label that table
    var t = n.closest ? n.closest('main table') : null;
    if (t) labelTable(t);
    if (n.querySelectorAll){
      var inner = n.querySelectorAll('main table');
      for (var k=0; k<inner.length; k++) labelTable(inner[k]);
    }
  }
  function init(){
    scan(document);
    new MutationObserver(function(muts){
      if (!mq.matches) return;
      for (var i=0; i<muts.length; i++){
        var added = muts[i].addedNodes;
        for (var j=0; j<added.length; j++) handle(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
    // re-scan when crossing the breakpoint (rotate / resize)
    var onMq = function(){ if (mq.matches) scan(document); };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
  function start(){
    requestAnimationFrame(function(){ requestAnimationFrame(init); });
  }
})();`,
          }}
        />
      </body>
    </html>
  );
}
