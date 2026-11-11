(async () => {
  'use strict';
  const KEY = '__local_ui_overlay_v1__';
  if (globalThis[KEY]) return globalThis[KEY].snapshot();

  const defaults = { opacity: 50, scale: 100, x: 0, y: 0, visible: true, locked: false, documentMode: false };
  const state = { ...defaults, image: null };
  let host, shadow, picture, toolbar, drag, saveTimer;
  let destroyed = false;
  const snapshot = () => ({ ...state, image: state.image ? { name: state.image.name, width: state.image.width, height: state.image.height, thumbnail: state.image.thumbnail } : null });
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { image, ...preferences } = state;
      chrome.storage.local.set({ preferences }).catch(() => {});
    }, 120);
  };
  const clamp = (n, min, max, fallback) => Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Number(n))) : fallback;

  function render() {
    if (!host || !state.image) return;
    host.hidden = !state.visible;
    const offsetX = state.documentMode ? window.scrollX : 0;
    const offsetY = state.documentMode ? window.scrollY : 0;
    picture.style.transform = `translate(${state.x - offsetX}px, ${state.y - offsetY}px) scale(${state.scale / 100})`;
    picture.style.opacity = String(state.opacity / 100);
    picture.style.pointerEvents = state.locked ? 'none' : 'auto';
    picture.style.cursor = state.locked ? 'default' : drag ? 'grabbing' : 'grab';
    picture.tabIndex = state.locked ? -1 : 0;
    toolbar.querySelector('[data-action="lock"]').textContent = state.locked ? '解锁拖动' : '锁定穿透';
    toolbar.querySelector('[data-role="opacity"]').textContent = `${state.opacity}%`;
    toolbar.querySelector('[data-role="state"]').textContent = state.locked ? '已锁定 · 点击穿透' : '可拖动 · 方向键微调';
  }

  function create() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-local-ui-overlay', '');
    // Inline !important protects the host from application CSS; Shadow DOM isolates its children.
    for (const [key, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', width: '100%', height: '100%', margin: '0', padding: '0', border: '0', 'z-index': '2147483647', 'pointer-events': 'none', isolation: 'isolate', display: 'block' })) host.style.setProperty(key, value, 'important');
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host([hidden]){display:none!important}*{box-sizing:border-box}img{position:absolute;left:0;top:0;max-width:none;max-height:none;transform-origin:0 0;user-select:none;-webkit-user-drag:none;outline:none}img:focus-visible{outline:1px dashed #6577ff;outline-offset:3px}.toolbar{position:absolute;right:20px;bottom:20px;pointer-events:auto;display:flex;align-items:center;gap:10px;padding:10px 12px;background:#20283bef;color:#fff;border:1px solid #ffffff20;border-radius:10px;box-shadow:0 5px 24px #17243b26;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;backdrop-filter:blur(12px)}.brand{color:#b9c4ff;font-weight:700}.state{color:#aeb7cd;font-size:10px}button{font:inherit;font-size:11px;border:1px solid #ffffff26;background:#ffffff0d;color:#e0e5f6;padding:5px 8px;border-radius:5px;cursor:pointer}button:hover{background:#ffffff26}button:focus-visible{outline:2px solid #a1b2ff;outline-offset:2px}@media(max-width:540px){.state{display:none}.toolbar{right:10px;bottom:10px;gap:6px;font-size:11px}}`;
    picture = document.createElement('img');
    picture.draggable = false;
    picture.setAttribute('aria-label', '设计图叠加层，可拖动或使用方向键调整位置');
    toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.innerHTML = '<span class="brand">叠图</span><span data-role="opacity"></span><span class="state" data-role="state"></span><button type="button" data-action="lock">锁定穿透</button><button type="button" data-action="hide">隐藏</button><button type="button" data-action="remove" aria-label="移除设计图">×</button>';
    toolbar.addEventListener('click', event => {
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'lock') state.locked = !state.locked;
      if (action === 'hide') state.visible = false;
      if (action === 'remove') { remove(); return; }
      render(); persist();
    });
    picture.addEventListener('pointerdown', event => {
      if (state.locked || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      picture.focus({ preventScroll: true });
      picture.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: state.x, y: state.y, scrollX: window.scrollX, scrollY: window.scrollY };
      render();
    });
    picture.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      state.x = Math.round(drag.x + event.clientX - drag.startX + (state.documentMode ? window.scrollX - drag.scrollX : 0));
      state.y = Math.round(drag.y + event.clientY - drag.startY + (state.documentMode ? window.scrollY - drag.scrollY : 0));
      render();
    });
    const endDrag = () => { if (drag) { drag = null; render(); persist(); } };
    picture.addEventListener('pointerup', endDrag);
    picture.addEventListener('pointercancel', endDrag);
    picture.addEventListener('lostpointercapture', endDrag);
    picture.addEventListener('keydown', event => {
      if (state.locked || event.ctrlKey || event.metaKey || event.altKey) return;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const move = moves[event.key];
      if (move) { const step = event.shiftKey ? 10 : 1; state.x += move[0] * step; state.y += move[1] * step; }
      else if (event.key === 'Escape') { state.locked = true; picture.blur(); }
      else return;
      event.preventDefault(); event.stopPropagation(); render(); persist();
    });
    shadow.append(style, picture, toolbar);
    document.documentElement.append(host);
  }

  function remove() {
    drag = null; host?.remove(); host = null; state.image = null; state.visible = true;
    persist();
  }

  function center() {
    state.x = Math.round((window.innerWidth - state.image.width * state.scale / 100) / 2 + (state.documentMode ? window.scrollX : 0));
    state.y = Math.round((window.innerHeight - state.image.height * state.scale / 100) / 2 + (state.documentMode ? window.scrollY : 0));
  }

  async function handle(message) {
    if (message.action === 'snapshot') return snapshot();
    if (message.action === 'load') {
      const image = message.image;
      if (!image || typeof image.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/i.test(image.src)) throw new Error('不支持的图片格式');
      const probe = new Image();
      probe.src = image.src;
      await probe.decode();
      if (destroyed) throw new Error('页面已关闭');
      state.image = { ...image, width: probe.naturalWidth, height: probe.naturalHeight };
      state.visible = true;
      create();
      picture.src = image.src;
      picture.width = state.image.width; picture.height = state.image.height;
    } else if (message.action === 'update') {
      const patch = message.patch || {};
      if ('opacity' in patch) state.opacity = clamp(patch.opacity, 0, 100, state.opacity);
      if ('scale' in patch) state.scale = clamp(patch.scale, 10, 300, state.scale);
      for (const key of ['x', 'y']) if (key in patch) state[key] = Math.round(clamp(patch[key], -1000000, 1000000, state[key]));
      for (const key of ['visible', 'locked']) if (typeof patch[key] === 'boolean') state[key] = patch[key];
      if (typeof patch.documentMode === 'boolean' && patch.documentMode !== state.documentMode) {
        state.x += (patch.documentMode ? 1 : -1) * window.scrollX;
        state.y += (patch.documentMode ? 1 : -1) * window.scrollY;
        state.documentMode = patch.documentMode;
      }
    } else if (message.action === 'remove') remove();
    else if (message.action === 'reset') Object.assign(state, defaults);
    else if (message.action === 'origin') { state.x = 0; state.y = 0; }
    else if (state.image && message.action === 'center') center();
    else if (state.image && message.action === 'fit') {
      state.scale = Math.max(10, Math.min(300, Math.floor(Math.min(window.innerWidth / state.image.width, window.innerHeight / state.image.height) * 100)));
      center();
    }
    render(); persist(); return snapshot();
  }

  // Register before asynchronous storage reads so repeated injection cannot duplicate listeners.
  const api = { snapshot };
  globalThis[KEY] = api;
  const onScroll = () => { if (state.documentMode) render(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pagehide', event => { if (!event.persisted) { destroyed = true; clearTimeout(saveTimer); } });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== 'local-ui-overlay') return;
    ready.then(() => handle(message)).then(result => respond({ ok: true, state: result })).catch(error => respond({ ok: false, error: error.message }));
    return true;
  });
  const ready = chrome.storage.local.get('preferences').then(({ preferences }) => {
    if (!preferences) return;
    state.opacity = clamp(preferences.opacity, 0, 100, 50);
    state.scale = clamp(preferences.scale, 10, 300, 100);
    for (const key of ['x', 'y']) state[key] = Math.round(clamp(preferences[key], -1000000, 1000000, 0));
    for (const key of ['locked', 'documentMode']) state[key] = preferences[key] === true;
  }).catch(() => {});
  await ready;
  return snapshot();
})();
