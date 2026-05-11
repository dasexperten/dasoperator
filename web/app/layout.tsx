import './globals.css';
import type { Metadata } from 'next';
import Sidebar from '@/components/layout/sidebar';
import Header from '@/components/layout/header';

export const runtime = 'edge';

export const metadata: Metadata = {
  title: 'Das Operator',
  description: 'Das Experten ERP — innovativ und praktisch',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            <Header />
            <main className="flex-1 overflow-auto">
              <div className="px-8 py-8">{children}</div>
            </main>
          </div>
        </div>
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
    // Defer past the first React hydration tick to avoid hydration mismatches
    // caused by us inserting wrapper spans before React reconciles the SSR'd DOM.
    // requestAnimationFrame × 2 guarantees we run after at least one paint,
    // by which time React has finished hydration on the visible tree.
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        init();
      });
    });
  }
})();`,
          }}
        />
      </body>
    </html>
  );
}
