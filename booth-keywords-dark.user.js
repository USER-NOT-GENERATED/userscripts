// ==UserScript==
// @name         BOOTH keyword finder + dark mode
// @namespace    local.booth.tools
// @version      1.0.2
// @downloadURL  https://raw.githubusercontent.com/USER-NOT-GENERATED/userscripts/main/booth-keywords-dark.user.js
// @updateURL    https://raw.githubusercontent.com/USER-NOT-GENERATED/userscripts/main/booth-keywords-dark.user.js
// @description  Find VRoid and facial-rig terms, with dark mode on BOOTH and seller subpages.
// @match        https://booth.pm/*
// @match        https://*.booth.pm/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(() => {
  'use strict';
  const TERMS = [
    ['VRoid Studio', /vroid\s+studio/giu],
    ['VRoid用', /vroid用/giu],
    ['.vroidcustomitem', /\.vroidcustomitem/giu],
    ['VRoid', /vroid/giu],
    ['正式版', /正式版/gu],
    ['表情', /表情/gu],
    ['シェイプキー', /シェイプキー/gu],
    ['PerfectSync', /perfect\s*sync/giu],
    ['ARKit 52', /arkit\s*52(?![0-9])/giu],
  ];
  const EXCLUDE = 'script,style,noscript,template,textarea,input,select,option,svg,canvas,' +
    '[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],#booth-tools';
  const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,div,section,article,td,th,dt,dd,button,header,footer';
  const prefs = {
    dark: GM_getValue('dark', true),
    highlights: GM_getValue('highlights', true),
  };
  const matches = new Map();
  const cursors = new Map();
  let root, list, total, darkInput, highlightInput;
  // Text-only changes (counters, tickers) rescan less often than DOM changes
  const SCAN_DELAY = 180;
  const TEXT_SCAN_DELAY = 1000;
  let timer = 0;
  let due = 0;
  let signature = '';
  const pending = new Set();

  const style = document.createElement('style');
  style.id = 'booth-tools-style';
  style.textContent = `@layer booth-tools {
    html.booth-tools-dark { color-scheme: dark !important; background: #14151a !important; }
    html.booth-tools-dark body { background-color: #14151a !important; color: #e8e6ee !important; }
    html.booth-tools-dark [data-bt-bg], html.booth-tools-dark #shop_default [data-bt-bg] { background-color: #202128 !important; }
    html.booth-tools-dark [data-bt-ink], html.booth-tools-dark #shop_default [data-bt-ink] { color: #e8e6ee !important; }
    html.booth-tools-dark [data-bt-border], html.booth-tools-dark #shop_default [data-bt-border] {
      border-color: #444550 !important;
      box-shadow: none !important;
    }
    html.booth-tools-dark body, html.booth-tools-dark .disable-shop-theme {
      --shop-theme-background-color: #14151a !important;
      --shop-theme-base-color: #e8e6ee !important;
      --shop-theme-border-color: #444550 !important;
      --shop-theme-contents-color: #202128 !important;
      --shop-theme-contents-color-0: #20212800 !important;
      --shop-theme-link-color: #d5c7f5 !important;
      --shop-theme-link-color-50: #d5c7f580 !important;
      --shop-theme-text-color: #e8e6ee !important;
      --shop-theme-text-color-40: #e8e6ee66 !important;
      --shop-theme-text-color-90: #e8e6eee5 !important;
    }
    html.booth-tools-dark input:not([type=checkbox]):not([type=radio]),
    html.booth-tools-dark textarea, html.booth-tools-dark select {
      background-color: #292a33 !important; color: #f1eef7 !important; border-color: #545461 !important;
    }
    html.booth-tools-dark input::placeholder, html.booth-tools-dark textarea::placeholder {
      color: #aaa7b6 !important; opacity: 1 !important;
    }
    html.booth-tools-dark a:focus-visible, html.booth-tools-dark button:focus-visible {
      outline: 2px solid #c3adff !important; outline-offset: 3px;
    }
    html.booth-tools-dark ::selection { background: #7752a0; color: #fff; }
    ::highlight(booth-tools-matches) { background-color: #f5d278; color: #211906; }
    ::highlight(booth-tools-current) { background-color: #bda0ff; color: #211135; }
  }`;
  (document.head || document.documentElement).prepend(style);
  function applyPrefs() {
    document.documentElement.classList.toggle('booth-tools-dark', prefs.dark);
    if (darkInput) darkInput.checked = prefs.dark;
    if (highlightInput) highlightInput.checked = prefs.highlights;
    paintHighlights();
  }
  applyPrefs();

  const colorCache = new Map();
  const swatch = document.createElement('canvas');
  swatch.width = swatch.height = 1;
  const colorContext = swatch.getContext('2d', { willReadFrequently: true });
  function rgb(value) {
    if (colorCache.has(value)) return colorCache.get(value);
    // BOOTH uses both RGB and OKLCH colours. Canvas resolves either into sRGB.
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = value;
    colorContext.fillRect(0, 0, 1, 1);
    const pixel = colorContext.getImageData(0, 0, 1, 1).data;
    const result = pixel[3] >= 128 ? [...pixel].slice(0, 3) : null;
    colorCache.set(value, result);
    return result;
  }
  function neutralLight(value) {
    const c = rgb(value);
    return c && Math.min(...c) > 175 && Math.max(...c) - Math.min(...c) < 55;
  }
  function darkInk(value) {
    const c = rgb(value);
    return c && Math.max(...c) < 145;
  }
  function themeBranch(branch) {
    if (!prefs.dark || !branch.isConnected) return;
    const elements = [branch, ...branch.querySelectorAll('*')];
    const changes = [];
    // Read first, then write: ancestor recolouring must not affect these samples.
    for (const el of elements) {
      if (!(el instanceof HTMLElement) || el.closest(EXCLUDE)) continue;
      const css = getComputedStyle(el);
      const bg = neutralLight(css.backgroundColor);
      const ink = darkInk(css.color);
      const border = ['Top', 'Right', 'Bottom', 'Left'].some(side =>
        parseFloat(css[`border${side}Width`]) > 0 && neutralLight(css[`border${side}Color`]));
      if (bg || ink || border) changes.push([el, bg, ink, border]);
    }
    for (const [el, bg, ink, border] of changes) {
      if (bg) el.setAttribute('data-bt-bg', '');
      if (ink) el.setAttribute('data-bt-ink', '');
      if (border) el.setAttribute('data-bt-border', '');
    }
  }

  function normalized(text) {
    let value = '';
    const offsets = [];
    let offset = 0;
    for (const char of text) {
      const part = char.normalize('NFKC');
      for (let i = 0; i < part.length; i++) offsets.push([offset, offset + char.length]);
      value += part;
      offset += char.length;
    }
    return { value, offsets };
  }
  function scanText() {
    for (const [name] of TERMS) matches.set(name, []);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!node.data || !el || el.closest(EXCLUDE)) return NodeFilter.FILTER_REJECT;
        const css = getComputedStyle(el);
        if (css.visibility === 'hidden' || !el.getClientRects().length) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    // Inline spans share a text run, so VRoid <strong>Studio</strong> still matches.
    let group = null, text = '', segments = [];
    function flush() {
      if (!segments.length) return;
      const norm = normalized(text);
      const occupied = [];
      for (const [name, pattern] of TERMS) {
        pattern.lastIndex = 0;
        for (const found of norm.value.matchAll(pattern)) {
          const start = norm.offsets[found.index][0];
          const end = norm.offsets[found.index + found[0].length - 1][1];
          if (occupied.some(([a, b]) => start < b && end > a)) continue;
          occupied.push([start, end]);
          const first = segments.find(s => start >= s.start && start < s.end);
          const last = segments.find(s => end > s.start && end <= s.end);
          if (!first || !last) continue;
          const range = document.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          matches.get(name).push(range);
        }
      }
      text = ''; segments = [];
    }
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const block = node.parentElement.closest(BLOCK) || document.body;
      if (block !== group) { flush(); group = block; }
      segments.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
    }
    flush();
    paintHighlights();
    renderMatches();
  }
  function paintHighlights() {
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
    CSS.highlights.delete('booth-tools-current');
    if (!prefs.highlights) { CSS.highlights.delete('booth-tools-matches'); return; }
    CSS.highlights.set('booth-tools-matches', new Highlight(...[...matches.values()].flat()));
  }
  // A rerender before the next scan moves range ends out of their removed text nodes
  const stale = range => [range.startContainer, range.endContainer].some(node =>
    !node.isConnected || node.nodeType !== Node.TEXT_NODE);
  function jump(name) {
    if (matches.get(name)?.some(stale)) scanText();
    const ranges = matches.get(name);
    if (!ranges?.length) return;
    const index = (cursors.get(name) || 0) % ranges.length;
    cursors.set(name, index + 1);
    const range = ranges[index];
    range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (prefs.highlights && globalThis.CSS?.highlights && globalThis.Highlight) {
      CSS.highlights.set('booth-tools-current', new Highlight(range));
    }
  }
  function renderMatches() {
    const counts = TERMS.map(([name]) => [name, matches.get(name).length]);
    const next = JSON.stringify(counts);
    if (next === signature) return;
    signature = next;
    const count = counts.reduce((sum, [, n]) => sum + n, 0);
    total.textContent = `${count} keyword ${count === 1 ? 'match' : 'matches'}`;
    list.replaceChildren();
    for (const [name, n] of counts) {
      if (!n) continue;
      const button = document.createElement('button');
      button.textContent = `${name} · ${n}`;
      button.title = `Go to next ${name} match`;
      button.addEventListener('click', () => jump(name));
      list.append(button);
    }
    if (!count) list.textContent = 'None of your keywords found on this page';
  }
  function savePref(key, value) {
    prefs[key] = value;
    GM_setValue(key, value);
    applyPrefs();
    if (key === 'dark' && value) { pending.add(document.body); schedule(); }
  }
  function buildPanel() {
    root = document.createElement('aside');
    root.id = 'booth-tools';
    root.setAttribute('aria-label', 'BOOTH keyword finder');
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; bottom: 18px; right: 18px; z-index: 2147483646;
          max-width: calc(100vw - 36px); color-scheme: dark; }
        * { box-sizing: border-box; }
        details { width: 290px; max-width: calc(100vw - 36px); background: #202128; color: #eeeaf6;
          border: 1px solid #55505f; border-radius: 12px; box-shadow: 0 6px 28px #0005;
          font: 13px/1.5 system-ui, sans-serif; }
        summary { cursor: pointer; padding: 12px 14px; user-select: none; }
        summary:focus-visible, button:focus-visible, input:focus-visible {
          outline: 2px solid #c3adff; outline-offset: 2px;
        }
        .inside { padding: 0 14px 14px; }
        .hint { margin: 0 0 10px; color: #bab4c7; font-size: 12px; }
        .matches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
        button { font: inherit; cursor: pointer; border: 1px solid #766e48; border-radius: 6px;
          padding: 4px 8px; background: #3e3724; color: #ffe6a3; }
        button:hover { background: #55482b; }
        label { display: flex; align-items: center; gap: 8px; margin-top: 8px; cursor: pointer; }
        input { accent-color: #bda0ff; }
      </style>
      <details><summary><span id="total">Scanning keywords…</span></summary>
        <div class="inside"><p class="hint">Page text · click a term to jump through its matches</p>
          <div class="matches"></div>
          <label><input id="dark" type="checkbox">Dark mode</label>
          <label><input id="highlights" type="checkbox">Highlight keywords</label>
        </div>
      </details>`;
    total = shadow.querySelector('#total');
    list = shadow.querySelector('.matches');
    darkInput = shadow.querySelector('#dark');
    highlightInput = shadow.querySelector('#highlights');
    darkInput.addEventListener('change', () => savePref('dark', darkInput.checked));
    highlightInput.addEventListener('change', () => savePref('highlights', highlightInput.checked));
    document.body.append(root);
    applyPrefs();
  }
  function schedule(delay = SCAN_DELAY) {
    const at = Date.now() + delay;
    if (timer && due <= at) return;
    clearTimeout(timer);
    due = at;
    timer = setTimeout(() => {
      timer = 0;
      if (pending.has(document.body)) themeBranch(document.body);
      else for (const branch of pending) themeBranch(branch);
      pending.clear();
      scanText();
    }, delay);
  }
  function start() {
    // First layer wins for !important rules, ahead of BOOTH's Tailwind layers.
    document.head.prepend(style);
    if (document.querySelector('#booth-tools')) return;
    buildPanel();
    themeBranch(document.body);
    scanText();
    new MutationObserver(records => {
      let changed = false;
      let textOnly = true;
      for (const record of records) {
        const el = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!el || el.closest('#booth-tools, #booth-tools-style')) continue;
        if (el.closest('head')) {
          const stylesheet = el.closest('style, link[rel=stylesheet]') ||
            [...record.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
              node.matches('style, link[rel=stylesheet]'));
          if (stylesheet) { pending.add(document.body); changed = true; textOnly = false; }
          continue;
        }
        if (record.type === 'attributes') {
          if (el === document.documentElement) continue;
          pending.add(el);
        } else if (record.type === 'childList') {
          for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) {
            pending.add(node.matches('style, link[rel=stylesheet]') ? document.body : node);
          }
        }
        changed = true;
        if (record.type !== 'characterData') textOnly = false;
      }
      if (changed) schedule(textOnly ? TEXT_SCAN_DELAY : SCAN_DELAY);
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'href', 'rel'] });
    // Theme passes must not wait for window.load: embeds can hold it open indefinitely.
    for (const delay of [400, 1400, 3200]) setTimeout(() => {
      pending.add(document.body); schedule();
    }, delay);
    for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
      if (!link.sheet) link.addEventListener('load', () => {
        pending.add(document.body); schedule();
      }, { once: true });
    }
    // Seller styles and webfonts can arrive after DOMContentLoaded.
    window.addEventListener('load', () => { pending.add(document.body); schedule(); }, { once: true });
    document.addEventListener('load', event => {
      if (event.target instanceof HTMLLinkElement && event.target.rel === 'stylesheet') {
        pending.add(document.body); schedule();
      }
    }, true);
    if (typeof GM_addValueChangeListener === 'function') {
      for (const key of Object.keys(prefs)) GM_addValueChangeListener(key, (_key, _old, value, remote) => {
        if (!remote) return;
        prefs[key] = value; applyPrefs();
        if (key === 'dark' && value) { pending.add(document.body); schedule(); }
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
