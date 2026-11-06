// Puts a Download button on a video while the mouse is over it, on the top-left corner
// since IDM puts its own panel on the top-right.
// Pressing it hands the video to the background worker, which works out the link.

(() => {
  if (window.__vdPlayerButton) return;
  window.__vdPlayerButton = true;

  const MIN_W = 200;
  const MIN_H = 110;
  let on = true;
  let target = null;
  let hideTimer = 0;
  let pending = 0;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;display:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      button {
        display: flex; align-items: center; gap: 6px;
        height: 30px; padding: 0 12px 0 9px;
        border: 1px solid rgba(232, 193, 106, 0.55); border-radius: 8px;
        background: rgba(15, 17, 20, 0.86); color: #e7e9ec;
        font: 600 13px/1 'Segoe UI', system-ui, sans-serif;
        cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
        opacity: 0; transition: opacity 0.15s;
      }
      button.shown { opacity: 1; }
      button:hover { background: rgba(29, 33, 39, 0.95); border-color: #e8c16a; }
      button.bad { border-color: #e5645f; }
      svg { width: 16px; height: 16px; flex-shrink: 0; }
    </style>
    <button type="button" title="Send this video to the Video Downloader app">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5" fill="none" stroke="#e8c16a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 20h12" stroke="#e7e9ec" stroke-width="2.4" stroke-linecap="round"/></svg>
      <span>Download</span>
    </button>`;
  const btn = shadow.querySelector('button');
  const label = shadow.querySelector('span');

  function attach() {
    const parent = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function place() {
    if (!target || !target.isConnected) return hide(true);
    const r = target.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H || r.bottom < 0 || r.top > innerHeight) return hide(true);
    host.style.transform = `translate(${Math.max(0, r.left) + 10}px, ${Math.max(0, r.top) + 10}px)`;
  }

  function show(video) {
    clearTimeout(hideTimer);
    if (target !== video) {
      target = video;
      if (!pending) setLabel('Download');
    }
    attach();
    host.style.display = 'block';
    place();
    requestAnimationFrame(() => btn.classList.add('shown'));
  }

  function hide(now) {
    clearTimeout(hideTimer);
    const go = () => {
      if (pending) return;
      btn.classList.remove('shown');
      host.style.display = 'none';
      target = null;
    };
    if (now) go();
    else hideTimer = setTimeout(go, 1200);
  }

  function setLabel(text, bad) {
    label.textContent = text;
    btn.classList.toggle('bad', !!bad);
  }

  /** The video under the mouse, looked up by position since players lay their controls over it. */
  function videoAt(x, y) {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width >= MIN_W && r.height >= MIN_H && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
    }
    return null;
  }

  let frame = 0;
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!on || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (e.target === host) return show(target);
        const v = videoAt(e.clientX, e.clientY);
        if (v) show(v);
        else if (target) hide(false);
      });
    },
    { passive: true },
  );
  addEventListener('scroll', () => target && place(), { passive: true, capture: true });
  addEventListener('resize', () => target && place(), { passive: true });
  document.addEventListener('fullscreenchange', () => {
    attach();
    if (target) place();
  });
  btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!target || pending) return;
    const src = target.currentSrc || target.src || '';
    pending = 1;
    setLabel('Sending');
    let answer = null;
    try {
      answer = await chrome.runtime.sendMessage({ type: 'player-download', src, title: document.title });
    } catch {
      answer = { ok: false, reason: 'reload' };
    }
    pending = 0;
    if (answer?.ok) setLabel('Sent to the app');
    else if (answer?.reason === 'reload') setLabel('Reload the page', true);
    else setLabel('Open the app first', true);
    setTimeout(() => {
      if (!pending) setLabel('Download');
    }, 2500);
  });

  chrome.storage.local.get('playerButton').then(({ playerButton = true }) => {
    on = playerButton;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'playerButton' in changes) {
      on = changes.playerButton.newValue !== false;
      if (!on) hide(true);
    }
  });
})();
