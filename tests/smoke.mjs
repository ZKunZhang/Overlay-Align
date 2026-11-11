// Run with Node 22+ and a Chrome for Testing / Chromium binary:
// CHROME_BIN=/absolute/path/to/chrome node tests/smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const binary = process.env.CHROME_BIN;
if (!binary) throw new Error('Set CHROME_BIN to a Chrome for Testing or Chromium executable.');
const temp = await mkdtemp(path.join(tmpdir(), 'ui-overlay-smoke-'));
const fixture = await readFile(new URL('fixture.html', import.meta.url));
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (process.env.STRICT_CSP === '1') headers['Content-Security-Policy'] = "img-src 'self'";
  res.writeHead(req.url === '/fixture' ? 200 : 204, headers);
  res.end(req.url === '/fixture' ? fixture : undefined);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/fixture`;
const clients = [];
let chrome;

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
    else callback.resolve(message.result);
  };
  const client = {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close: () => socket.close()
  };
  clients.push(client);
  return client;
}

async function poll(action, predicate, label) {
  const deadline = Date.now() + 10000;
  let value;
  do {
    value = await action();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(value)}`);
}

try {
  chrome = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--enable-unsafe-extension-debugging', `--user-data-dir=${temp}/profile`, '--remote-debugging-port=0', `--load-extension=${root}`, `--disable-extensions-except=${root}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    let log = '';
    chrome.stderr.on('data', data => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.on('error', reject);
    chrome.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${log}`)); });
  });
  const browser = await connect(endpoint);
  const origin = new URL(endpoint); origin.protocol = 'http:';
  const list = () => fetch(`${origin.origin}/json/list`).then(response => response.json());
  const { extensions } = await browser.call('Extensions.getExtensions');
  const extension = extensions.find(item => item.path.replace(/\/$/, '') === root.replace(/\/$/, ''));
  assert.ok(extension?.enabled, 'Unpacked extension loads');
  const { targetId } = await browser.call('Target.createTarget', { url: address });
  const target = await poll(list, items => items.some(item => item.id === targetId), 'fixture target');
  const page = await connect(target.find(item => item.id === targetId).webSocketDebuggerUrl);
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await poll(() => page.evaluate('document.readyState'), value => value === 'complete', 'fixture load');

  async function openPopup() {
    await browser.call('Target.activateTarget', { targetId });
    const { targetInfos } = await browser.call('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const tabTarget = targetInfos.find(item => item.url === address);
    assert.ok(tabTarget, 'Fixture has a browser tab target');
    await browser.call('Extensions.triggerAction', { id: extension.id, targetId: tabTarget.targetId });
    const targets = await poll(list, items => items.some(item => item.url === `chrome-extension://${extension.id}/popup.html` && item.type === 'page'), 'action popup');
    const popupTarget = targets.find(item => item.url === `chrome-extension://${extension.id}/popup.html` && item.type === 'page');
    const popup = await connect(popupTarget.webSocketDebuggerUrl);
    await poll(() => popup.evaluate('typeof current !== "undefined" && current'), value => !!value, 'popup initialization');
    assert.equal(await popup.evaluate('document.getElementById("status").hidden'), true, 'Popup initializes without errors');
    return popup;
  }

  let popup = await openPopup();
  assert.equal(await popup.evaluate('current.image'), null);
  const screenshot = await page.call('Page.captureScreenshot', { format: 'png' });
  const imagePath = path.join(temp, 'design.png');
  await writeFile(imagePath, Buffer.from(screenshot.data, 'base64'));
  const { root: popupDOM } = await popup.call('DOM.getDocument');
  const { nodeId: fileInput } = await popup.call('DOM.querySelector', { nodeId: popupDOM.nodeId, selector: '#file' });
  await popup.call('DOM.setFileInputFiles', { nodeId: fileInput, files: [imagePath] });
  await poll(() => popup.evaluate('current.image && !busy'), Boolean, 'local file import');
  assert.equal(await popup.evaluate('current.image.width'), 1100);
  assert.equal(await popup.evaluate('current.image.height'), 850);
  assert.equal(await page.evaluate('document.querySelectorAll("[data-local-ui-overlay]").length'), 1);

  const command = (action, extra = {}) => popup.evaluate(`send(${JSON.stringify(action)}, ${JSON.stringify(extra)})`);
  let state = await command('update', { patch: { opacity: 37, scale: 50, x: 11, y: 23 } });
  assert.deepEqual([state.opacity, state.scale, state.x, state.y], [37, 50, 11, 23]);
  // Inspect the real closed shadow tree through DevTools without weakening isolation in the extension.
  async function inspectImage() {
    const { root: doc } = await page.call('DOM.getDocument', { depth: -1, pierce: true });
    const flatten = node => [node, ...(node.children || []).flatMap(flatten), ...(node.shadowRoots || []).flatMap(flatten)];
    const nodes = flatten(doc);
    const host = nodes.find(node => node.attributes?.includes('data-local-ui-overlay'));
    const image = host?.shadowRoots?.flatMap(flatten).find(node => node.nodeName === 'IMG');
    assert.ok(image, 'Image exists in closed shadow root');
    const { object } = await page.call('DOM.resolveNode', { nodeId: image.nodeId });
    const { result } = await page.call('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){ const r=this.getBoundingClientRect(); return {complete:this.complete,naturalWidth:this.naturalWidth,x:r.x,y:r.y,width:r.width,opacity:getComputedStyle(this).opacity,pointerEvents:getComputedStyle(this).pointerEvents,hidden:getComputedStyle(this.getRootNode().host).display === "none"}; }', returnByValue: true });
    return result.value;
  }
  assert.deepEqual(await inspectImage(), { complete: true, naturalWidth: 1100, x: 11, y: 23, width: 550, opacity: '0.37', pointerEvents: 'auto', hidden: false });
  await command('update', { patch: { visible: false } });
  assert.equal((await inspectImage()).hidden, true, 'Hide actually removes overlay from rendering');
  await command('reset');
  await command('update', { patch: { x: 30, y: 40, scale: 50 } });
  // Use real mouse and keyboard input for drag and keyboard positioning.
  for (const [type, x, y, buttons] of [['mousePressed', 60, 70, 1], ['mouseMoved', 95, 95, 1], ['mouseReleased', 95, 95, 0]]) await page.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  state = await command('snapshot');
  assert.deepEqual([state.x, state.y], [65, 65], 'Drag updates actual image position');
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 8 });
  state = await command('snapshot');
  assert.equal(state.x, 75, 'Shift + arrow moves 10 pixels');
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal((await command('snapshot')).locked, true);
  assert.equal((await inspectImage()).pointerEvents, 'none');
  const button = await page.evaluate('(()=>{const r=document.getElementById("counter").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  for (const type of ['mousePressed', 'mouseReleased']) await page.call('Input.dispatchMouseEvent', { type, ...button, button: 'left', clickCount: 1 });
  assert.equal(await page.evaluate('document.getElementById("counter").textContent'), '点击次数：1', 'Locked image allows page clicks');

  await page.evaluate('window.scrollTo(0, 250)');
  await poll(() => page.evaluate('window.scrollY'), value => value === 250, 'page scroll');
  const before = await inspectImage();
  await command('update', { patch: { documentMode: true } });
  assert.equal((await inspectImage()).y, before.y, 'Changing scroll mode preserves viewport position');
  await page.evaluate('window.scrollTo(0, 350)');
  await poll(inspectImage, value => value.y === before.y - 100, 'image follows document scroll');
  await command('update', { patch: { documentMode: false } });
  const fixedY = (await inspectImage()).y;
  await page.evaluate('window.scrollTo(0, 450)');
  await poll(() => page.evaluate('window.scrollY'), value => value === 450, 'fixed mode scroll');
  assert.equal((await inspectImage()).y, fixedY, 'Fixed image stays in viewport');
  await command('fit');
  assert.equal((await command('snapshot')).scale, 100);
  await command('update', { patch: { opacity: 42 } });
  // Reopening the action must not inject duplicate overlay instances.
  popup = await openPopup();
  assert.equal(await popup.evaluate('current.opacity'), 42);
  assert.equal(await page.evaluate('document.querySelectorAll("[data-local-ui-overlay]").length'), 1);
  assert.ok(await popup.evaluate('savedImage?.src.startsWith("data:image/png;base64,")'), 'Image saved to extension IndexedDB');

  await page.call('Page.reload');
  await poll(() => page.evaluate('document.readyState'), value => value === 'complete', 'reload');
  popup = await openPopup();
  assert.equal(await popup.evaluate('current.image'), null, 'No automatic injection after refresh');
  await popup.evaluate('document.getElementById("restore").click()');
  await poll(() => popup.evaluate('current.image'), Boolean, 'restore last local image');
  assert.equal(await popup.evaluate('current.opacity'), 42, 'Preferences persist across refresh');
  await popup.evaluate('document.getElementById("remove").click()');
  await poll(() => popup.evaluate('current.image === null && savedImage === null'), Boolean, 'remove and clear local image');
  assert.equal(await popup.evaluate('imageStore("readonly").then(value => value === undefined)'), true);
  assert.equal(await page.evaluate('document.querySelectorAll("[data-local-ui-overlay]").length'), 0);
  assert.ok(requests.every(url => ['/fixture', '/favicon.ico'].includes(url)), 'No image uploads to fixture server');
  console.log('PASS: unpacked extension, actual popup, local file import, closed-shadow rendering, opacity, scale, drag, keyboard, click-through, visibility, scroll modes, reopen, persistence, restore and removal.');
} finally {
  for (const client of clients) client.close();
  chrome?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 300));
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
