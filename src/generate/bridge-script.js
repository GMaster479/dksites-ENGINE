// The editor bridge. A copy of this is written into every preview as _bridge.js and
// referenced from each page, because the editor iframe is on a different origin
// (<slug>.dksites.com vs app.dksites.com) and cannot reach into the document itself.
//
// It is INERT on a real site: if the page isn't inside an iframe it returns immediately,
// so a launched client site carries a few hundred dormant bytes and nothing else.
// It never edits anything — it only reports which image was clicked. All actual changes
// still go through the staged editor and a regeneration.

export const BRIDGE_JS = `(function () {
  if (window.parent === window) return; // live site, not the editor — do nothing
  var active = false;

  var style = document.createElement('style');
  style.textContent =
    '.dk-edit-on img{outline:2px dashed rgba(232,193,122,.95);outline-offset:2px;cursor:pointer}' +
    '.dk-edit-on img:hover{outline:3px solid #fff}';
  document.addEventListener('DOMContentLoaded', function () { document.head.appendChild(style); });
  if (document.head) document.head.appendChild(style);

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'dksites:enable') { active = true; document.body.classList.add('dk-edit-on'); }
    if (d.type === 'dksites:disable') { active = false; document.body.classList.remove('dk-edit-on'); }
  });

  document.addEventListener('click', function (e) {
    if (!active) return;
    var img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    var r = img.getBoundingClientRect();
    parent.postMessage({
      type: 'dksites:image-click',
      src: img.getAttribute('src') || '',
      alt: img.getAttribute('alt') || '',
      width: Math.round(r.width),
      height: Math.round(r.height)
    }, '*');
  }, true);

  parent.postMessage({ type: 'dksites:ready' }, '*');
})();`;

/** Add the bridge reference to an HTML document, just before </body>. */
export function injectBridge(html) {
  if (typeof html !== 'string' || html.includes('_bridge.js')) return html;
  const tag = '<script src="/_bridge.js" defer></script>';
  return html.includes('</body>')
    ? html.replace('</body>', `  ${tag}\n</body>`)
    : `${html}\n${tag}`;
}
