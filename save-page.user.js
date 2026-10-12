// ==UserScript==
// @name         Save Page
// @namespace    zism
// @version      1.0.3
// @downloadURL  https://raw.githubusercontent.com/USER-NOT-GENERATED/userscripts/main/save-page.user.js
// @updateURL    https://raw.githubusercontent.com/USER-NOT-GENERATED/userscripts/main/save-page.user.js
// @description  Save the current page as one self-contained HTML file (CSS, images, fonts, frames inlined). Alt+Shift+S or Tampermonkey menu
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      self
// @connect      youtube.com
// @connect      ytimg.com
// @connect      googleapis.com
// @connect      gstatic.com
// @connect      googleusercontent.com
// @connect      ggpht.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const isHotkey = e => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS';
  const MAX_PARALLEL = 8;
  const TIMEOUT_MS = 30000;
  const MAX_FRAME_DEPTH = 3;
  const MAX_IMPORT_DEPTH = 5;
  const UI_ATTR = 'data-save-page-ui';
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy'];
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'cite', 'background', 'xlink:href'];
  // Elements allowed to host an author shadow root (anything else is a browser widget)
  const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);
  const DROP_LINK_RELS = ['preload', 'prefetch', 'modulepreload', 'preconnect', 'dns-prefetch', 'prerender', 'manifest'];
  const MIME = {
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  };

  let busy = false;
  let ctx;

  GM_registerMenuCommand('Save page as HTML', savePage);
  addEventListener('keydown', e => {
    if (!isHotkey(e)) return;
    e.preventDefault();
    savePage();
  }, true);

  async function savePage() {
    if (busy) return;
    busy = true;
    ctx = { cache: new Map(), failed: new Set(), total: 0, done: 0 };
    const ui = toast();
    let lastDone = 0;
    let lastProgress = Date.now();
    const timer = setInterval(() => {
      if (ctx.done !== lastDone) { lastDone = ctx.done; lastProgress = Date.now(); }
      const waiting = ctx.done < ctx.total && Date.now() - lastProgress > 5000
        ? '\nWaiting for resources. Check Tampermonkey permission tabs.' : '';
      ui.set(`Fetching resources... ${ctx.done}/${ctx.total}${waiting}`);
    }, 200);
    try {
      const html = await serializeDoc(document, 0);
      const file = download(html, fileName());
      const failed = ctx.failed.size ? `, ${ctx.failed.size} resources kept as links (see console)` : '';
      ui.done(`Download requested: ${file.name} (${formatSize(file.size)})${failed}`, 60000, file.link);
      if (ctx.failed.size) console.warn('[Save Page] could not inline:', [...ctx.failed]);
    } catch (err) {
      console.error('[Save Page]', err);
      ui.done(`Save failed: ${err.message}`, 8000);
    } finally {
      clearInterval(timer);
      busy = false;
    }
  }

  // Document / tree

  async function serializeDoc(doc, depth) {
    const inert = doc.implementation.createHTMLDocument('');
    const root = inert.importNode(doc.documentElement, true);
    const sprites = new Map();
    await processTree(doc.documentElement, root, depth, sprites);

    const head = root.querySelector(':scope > head') ?? root;
    for (const css of await adoptedCss(doc, doc.baseURI)) head.append(styleEl(inert, css));
    const meta = inert.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.prepend(meta);

    const markup = (await Promise.all(sprites.values())).filter(Boolean);
    if (markup.length) {
      const holder = inert.createElement('div');
      holder.setAttribute('aria-hidden', 'true');
      holder.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
      holder.innerHTML = markup.join('\n');
      (root.querySelector(':scope > body') ?? root).append(holder);
    }

    return `${doctype(doc.doctype)}\n<!-- saved from ${doc.URL.replaceAll('--', '%2D%2D')} on ${new Date().toISOString()} -->\n${root.outerHTML}`;
  }

  // orig and clone have identical structure, so querySelectorAll order pairs them up
  async function processTree(orig, clone, depth, sprites) {
    const all = root => [...(root.nodeType === 1 ? [root] : []), ...root.querySelectorAll('*')];
    const o = all(orig);
    const c = all(clone);
    await Promise.all(o.map((el, i) => processElement(el, c[i], depth, sprites)));
  }

  async function processElement(o, c, depth, sprites) {
    const tag = c.localName;
    const base = o.baseURI;

    if (c.hasAttribute(UI_ATTR) || tag === 'script' || tag === 'noscript' || tag === 'base') return c.remove();
    if (tag === 'meta') {
      const equiv = (c.getAttribute('http-equiv') ?? '').toLowerCase();
      if (c.hasAttribute('charset') || ['content-security-policy', 'refresh', 'content-type'].includes(equiv)) return c.remove();
    }
    if (tag === 'source' && c.parentElement?.localName === 'picture') return c.remove();

    for (const { name } of [...c.attributes]) {
      if (/^on/i.test(name) || name === 'integrity' || name === 'nonce') c.removeAttribute(name);
    }
    for (const name of tag === 'object' ? [...URL_ATTRS, 'data'] : URL_ATTRS) {
      const value = c.getAttribute(name);
      if (value && !skipUrl(value)) c.setAttribute(name, absUrl(value, base));
    }

    const jobs = [];
    const style = c.getAttribute('style');
    if (style?.includes('url(')) jobs.push(processCss(style, base).then(css => c.setAttribute('style', css)));

    // openOrClosedShadowRoot exists only in Firefox extension contexts; elsewhere closed roots stay unreachable
    const shadow = (tag.includes('-') || SHADOW_HOSTS.has(tag)) && (o.openOrClosedShadowRoot ?? o.shadowRoot);
    if (shadow) jobs.push(processShadow(shadow, c, depth));

    switch (tag) {
      case 'link': jobs.push(processLink(o, c)); break;
      case 'style': jobs.push(processStyle(o, c)); break;
      case 'img': jobs.push(processImg(o, c)); break;
      case 'input': processInput(o, c, jobs); break;
      case 'textarea': c.textContent = o.value; break;
      case 'option': toggleAttr(c, 'selected', o.selected); break;
      case 'canvas': processCanvas(o, c); break;
      case 'video': if (o.poster) jobs.push(setInlined(c, 'poster', o.poster)); break;
      case 'image': jobs.push(processSvgImage(c)); break;
      case 'use': jobs.push(processUse(o, c, sprites)); break;
      case 'iframe':
      case 'frame': jobs.push(processFrame(o, c, depth)); break;
    }
    await Promise.all(jobs);
  }

  async function processShadow(shadow, c, depth) {
    const doc = c.ownerDocument;
    const tpl = doc.createElement('template');
    tpl.setAttribute('shadowrootmode', shadow.mode);
    for (const node of shadow.childNodes) tpl.content.append(doc.importNode(node, true));
    await processTree(shadow, tpl.content, depth, new Map());
    const sheets = await adoptedCss(shadow, c.baseURI);
    tpl.content.prepend(...sheets.map(css => styleEl(doc, css)));
    c.prepend(tpl);
  }

  async function processLink(o, c) {
    const rels = (c.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (rels.some(r => DROP_LINK_RELS.includes(r))) return c.remove();
    if (rels.includes('icon') && o.href) return setInlined(c, 'href', o.href);
    if (!rels.includes('stylesheet') || rels.includes('alternate') || !o.href) return;
    if (o.disabled || o.sheet?.disabled) return c.remove();

    let css;
    try {
      css = await cached(`css:${o.href}`, () => request(o.href, 'text'));
    } catch {
      try { css = rulesText(o.sheet); } catch { ctx.failed.add(o.href); return; }
    }
    const style = styleEl(c.ownerDocument, await processCss(css, o.href));
    if (c.hasAttribute('media')) style.setAttribute('media', c.getAttribute('media'));
    c.replaceWith(style);
  }

  // CSSOM rules catch CSS-in-JS (insertRule) that never shows up in textContent
  async function processStyle(o, c) {
    let css = o.textContent;
    try {
      if (o.sheet?.cssRules.length) css = rulesText(o.sheet);
    } catch {}
    c.textContent = await processCss(css, o.baseURI);
  }

  async function processImg(o, c) {
    let src = o.currentSrc || o.src;
    const lazy = LAZY_ATTRS.map(a => o.getAttribute(a)).find(Boolean);
    if (lazy && (!o.complete || !o.naturalWidth || src.startsWith('data:'))) src = absUrl(lazy, o.baseURI);
    for (const name of ['srcset', 'sizes', 'loading', 'data-srcset', ...LAZY_ATTRS]) c.removeAttribute(name);
    if (src && !skipUrl(src)) await setInlined(c, 'src', src);
  }

  function processInput(o, c, jobs) {
    const type = (o.type ?? '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') toggleAttr(c, 'checked', o.checked);
    else if (type === 'password') c.removeAttribute('value');
    else if (type === 'image') { if (o.src) jobs.push(setInlined(c, 'src', o.src)); }
    else if (type !== 'file') c.setAttribute('value', o.value);
  }

  function processCanvas(o, c) {
    try {
      const img = c.ownerDocument.createElement('img');
      for (const { name, value } of [...c.attributes]) img.setAttribute(name, value);
      img.setAttribute('width', o.width);
      img.setAttribute('height', o.height);
      img.setAttribute('src', o.toDataURL());
      c.replaceWith(img);
    } catch {} // tainted canvas: keep it (renders blank)
  }

  async function processSvgImage(c) {
    for (const name of ['href', 'xlink:href']) {
      const value = c.getAttribute(name);
      if (value && !skipUrl(value)) await setInlined(c, name, value);
    }
  }

  // External <use href="sprite.svg#id"> is blocked from file://, so pull the sprite into the page
  async function processUse(o, c, sprites) {
    if (o.getRootNode() !== o.ownerDocument) return;
    for (const name of ['href', 'xlink:href']) {
      const value = c.getAttribute(name);
      if (!value || skipUrl(value)) continue;
      const url = new URL(value, o.baseURI);
      const { hash } = url;
      if (!hash) continue;
      url.hash = '';
      if (!sprites.has(url.href)) sprites.set(url.href, loadSprite(url.href));
      // A failed sprite keeps its absolute URL
      if (await sprites.get(url.href)) c.setAttribute(name, hash);
    }
  }

  async function loadSprite(url) {
    try {
      const svg = new DOMParser().parseFromString(await cached(`svg:${url}`, () => request(url, 'text')), 'image/svg+xml');
      if (svg.querySelector('parsererror')) throw new Error('bad svg');
      for (const el of svg.querySelectorAll('script, foreignObject')) el.remove();
      for (const el of svg.querySelectorAll('*')) {
        for (const { name } of [...el.attributes]) if (/^on/i.test(name)) el.removeAttribute(name);
      }
      return new XMLSerializer().serializeToString(svg.documentElement);
    } catch {
      ctx.failed.add(url);
      return null;
    }
  }

  async function processFrame(o, c, depth) {
    let doc = null;
    try { doc = o.contentDocument; } catch {}
    if (!doc?.documentElement || depth >= MAX_FRAME_DEPTH) return;
    c.setAttribute('srcdoc', await serializeDoc(doc, depth + 1));
    c.removeAttribute('src');
  }

  // CSS

  const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s'"]*))\s*\)/gi;
  // @import only counts at the sheet start, after @charset and @layer statements
  const CSS_PRELUDE = /\s+|\/\*[\s\S]*?\*\/|<!--|-->|@charset\s+"[^"]*"\s*;|@layer\s+[^{};]+;/y;
  const CSS_IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/iy;

  async function processCss(css, base) {
    const { links, body } = await inlineCss(css, base, 0);
    return links.length ? `${links.join('\n')}\n${body}` : body;
  }

  // Imports that stay links move to the top of the outermost sheet, where @import is still valid
  async function inlineCss(css, base, depth) {
    const parts = [];
    let pos = 0;
    for (;;) {
      CSS_PRELUDE.lastIndex = CSS_IMPORT.lastIndex = pos;
      const prelude = CSS_PRELUDE.exec(css);
      const m = prelude ?? CSS_IMPORT.exec(css);
      if (!m) break;
      pos = m.index + m[0].length;
      if (prelude) { parts.push({ links: [], body: m[0] }); continue; }
      const url = absUrl(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], base);
      const condition = m[6].trim();
      const link = { links: [`@import url("${url}")${condition && ` ${condition}`};`], body: '' };
      if (depth >= MAX_IMPORT_DEPTH) { parts.push(link); continue; }
      parts.push(cached(`css:${url}`, () => request(url, 'text'))
        .then(text => inlineCss(text, url, depth + 1))
        .then(child => ({ links: child.links, body: wrapImport(child.body, condition) }))
        .catch(() => { ctx.failed.add(url); return link; }));
    }
    parts.push(replaceAsync(css.slice(pos), CSS_URL, async (match, a, b, c) => {
      const raw = (a ?? b ?? c).replace(/\\(.)/g, '$1');
      if (skipUrl(raw)) return match;
      return `url("${await inline(absUrl(raw, base))}")`;
    }).then(body => ({ links: [], body })));
    const done = await Promise.all(parts);
    return { links: done.flatMap(part => part.links), body: done.map(part => part.body).join('') };
  }

  // @import url(x) layer(a) supports(b) c  ->  @layer a { @supports (b) { @media c { ... } } }
  function wrapImport(css, condition) {
    const layer = /^layer(?:\(\s*([^)]*?)\s*\)|(?![\w-]))\s*/i.exec(condition);
    if (layer) condition = condition.slice(layer[0].length);
    let supports = null;
    if (/^supports\(/i.test(condition)) {
      let i = 'supports('.length;
      for (let open = 1; i < condition.length && open; i++) open += { '(': 1, ')': -1 }[condition[i]] ?? 0;
      supports = condition.slice('supports('.length, i - 1).trim();
      condition = condition.slice(i).trim();
    }
    if (condition) css = `@media ${condition} {\n${css}\n}`;
    if (supports) css = `@supports (${supports}) {\n${css}\n}`;
    if (layer) css = `@layer${layer[1] ? ` ${layer[1]}` : ''} {\n${css}\n}`;
    return css;
  }

  // One unreadable sheet must not drop the others
  async function adoptedCss(root, base) {
    let sheets = [];
    try { sheets = [...(root.adoptedStyleSheets ?? [])]; } catch {}
    const css = await Promise.all(sheets.map(async sheet => {
      try { return await processCss(rulesText(sheet), base); } catch { return null; }
    }));
    return css.filter(text => text !== null);
  }

  const rulesText = sheet => [...sheet.cssRules].map(r => r.cssText).join('\n');

  async function replaceAsync(str, re, fn) {
    const jobs = [];
    str.replace(re, (...args) => { jobs.push(fn(...args)); return ''; });
    if (!jobs.length) return str;
    const results = await Promise.all(jobs);
    let i = 0;
    return str.replace(re, () => results[i++]);
  }

  // Network

  async function setInlined(el, attr, url) {
    el.setAttribute(attr, await inline(url));
  }

  // Failed resources stay as absolute URLs so they still load when online
  async function inline(url) {
    try {
      return await cached(`data:${url}`, async () => {
        const blob = await request(url, 'blob');
        const type = fixMime(blob.type, url);
        return blobToDataUrl(type === blob.type ? blob : new Blob([blob], { type }));
      });
    } catch {
      ctx.failed.add(url);
      return url;
    }
  }

  function cached(key, fn) {
    if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
    return ctx.cache.get(key);
  }

  let active = 0;
  const queue = [];

  function request(url, type) {
    ctx.total++;
    const run = url.startsWith('blob:')
      ? () => fetch(url).then(r => (type === 'text' ? r.text() : r.blob()))
      : () => gmRequest(url, type);
    return new Promise((resolve, reject) => {
      const start = () => {
        active++;
        run().then(resolve, reject).finally(() => {
          active--;
          ctx.done++;
          queue.shift()?.();
        });
      };
      active < MAX_PARALLEL ? start() : queue.push(start);
    });
  }

  function gmRequest(url, type) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: type === 'text' ? 'text' : 'blob',
      timeout: TIMEOUT_MS,
      onload: r => (r.status >= 200 && r.status < 300
        ? resolve(type === 'text' ? r.responseText : r.response)
        : reject(new Error(`HTTP ${r.status} ${url}`))),
      onerror: () => reject(new Error(`network error ${url}`)),
      onabort: () => reject(new Error(`request aborted ${url}`)),
      ontimeout: () => reject(new Error(`timeout ${url}`)),
    }));
  }

  function fixMime(type, url) {
    type = (type ?? '').split(';')[0].trim();
    if (type && type !== 'application/octet-stream' && type !== 'text/plain') return type;
    const ext = new URL(url).pathname.split('.').pop().toLowerCase();
    return MIME[ext] ?? (type || 'application/octet-stream');
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Helpers

  const skipUrl = u => !u.trim() || u.startsWith('#') || /^\s*(data|javascript|about|mailto|tel|sms):/i.test(u);

  function absUrl(url, base) {
    try { return new URL(url.trim(), base).href; } catch { return url; }
  }

  function toggleAttr(el, name, on) {
    if (on) el.setAttribute(name, '');
    else el.removeAttribute(name);
  }

  function styleEl(doc, css) {
    const style = doc.createElement('style');
    style.textContent = css;
    return style;
  }

  function doctype(dt) {
    if (!dt) return '';
    let s = `<!DOCTYPE ${dt.name}`;
    if (dt.publicId) s += ` PUBLIC "${dt.publicId}"`;
    else if (dt.systemId) s += ' SYSTEM';
    if (dt.systemId) s += ` "${dt.systemId}"`;
    return `${s}>`;
  }

  function fileName() {
    const title = (document.title || location.hostname).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return `${title.slice(0, 150) || 'page'}.html`;
  }

  function download(html, name) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.textContent = 'Download HTML again';
    a.setAttribute(UI_ATTR, '');
    Object.assign(a.style, { color: '#89b4fa', pointerEvents: 'auto', display: 'block', marginTop: '6px' });
    // Keep a visible link so a user click can retry a blocked automatic download.
    setTimeout(() => a.click(), 0);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { size: blob.size, name, link: a };
  }

  function formatSize(bytes) {
    return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  }

  function toast() {
    const el = document.createElement('div');
    el.setAttribute(UI_ATTR, '');
    Object.assign(el.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
      padding: '10px 14px', borderRadius: '8px', pointerEvents: 'none',
      background: '#1e1e2e', color: '#cdd6f4', font: '13px/1.4 system-ui, sans-serif',
      maxWidth: 'min(440px, calc(100vw - 60px))', whiteSpace: 'pre-line', overflowWrap: 'anywhere',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    });
    el.textContent = 'Saving page...';
    document.documentElement.append(el);
    return {
      set: text => { el.textContent = text; },
      done: (text, ms = 4000, link) => {
        el.textContent = text;
        if (link) el.append(link);
        setTimeout(() => el.remove(), ms);
      },
    };
  }
})();
