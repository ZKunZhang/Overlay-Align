'use strict';

const $ = id => document.getElementById(id);
let tabId;
let current;
let savedImage;
let busy = false;
let queue = Promise.resolve();
const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);

function status(message = '', success = false) {
  $('status').textContent = message;
  $('status').hidden = !message;
  $('status').classList.toggle('success', success);
}

function draw(state) {
  current = state;
  const hasImage = !!state.image;
  $('controls').disabled = !hasImage;
  $('upload').hidden = hasImage;
  $('image-info').hidden = !hasImage;
  $('restore').hidden = hasImage || !savedImage;
  if (hasImage) {
    $('image-name').textContent = state.image.name;
    $('image-size').textContent = `${state.image.width} × ${state.image.height} px`;
    $('thumbnail').src = state.image.thumbnail;
  }
  for (const key of ['opacity', 'scale']) {
    $(key).value = state[key];
    $(`${key}-number`).value = state[key];
    $(key).style.background = `linear-gradient(to right, #5267ed 0%, #5267ed ${key === 'opacity' ? state[key] : (state[key] - 10) / 2.9}%, #e1e5ef 0%)`;
  }
  for (const key of ['x', 'y']) $(key).value = state[key];
  for (const key of ['visible', 'locked']) $(key).checked = state[key];
  $('document-mode').checked = state.documentMode;
}

async function send(action, extra = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { target: 'local-ui-overlay', action, ...extra });
  if (!response?.ok) throw new Error(response?.error || '操作失败，请重新打开扩展。');
  draw(response.state);
  return response.state;
}

function run(action, extra) {
  queue = queue.then(() => send(action, extra)).then(() => status()).catch(error => status(error.message.includes('Receiving end') || error.message.includes('Could not establish') ? '页面已刷新，请关闭后重新打开扩展。' : error.message));
  return queue;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('local-ui-overlay', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function imageStore(mode, value) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode);
      const store = tx.objectStore('images');
      const request = mode === 'readonly' ? store.get('last') : value ? store.put(value, 'last') : store.delete('last');
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('本地保存失败'));
    });
  } finally { db.close(); }
}

function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取这张图片。'));
    reader.readAsDataURL(blob);
  });
}

async function prepare(file) {
  if (!allowedTypes.has(file.type)) throw new Error('请选择 PNG、JPG、WebP、GIF、AVIF 或 BMP 图片。');
  if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请压缩后再试。');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new Error('无法解码图片，请确认图片文件完整。'); }
    const canvas = document.createElement('canvas');
    const ratio = Math.min(1, 96 / img.naturalWidth, 96 / img.naturalHeight);
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { name: file.name, src: await dataURL(file), width: img.naturalWidth, height: img.naturalHeight, thumbnail: canvas.toDataURL('image/png') };
  } finally { URL.revokeObjectURL(url); }
}

async function importFile(file) {
  if (!file || busy || tabId === undefined) return;
  busy = true;
  $('upload-title').textContent = '正在读取图片…';
  status();
  try {
    const image = await prepare(file);
    await queue;
    await send('load', { image });
    savedImage = image;
    try { await imageStore('readwrite', image); }
    catch { status('图片已叠加，但本地保存失败。关闭页面后需要重新选择图片。'); }
  } catch (error) { status(error.message); }
  finally { busy = false; $('file').value = ''; $('upload-title').textContent = '选择一张设计图'; }
}

$('upload').addEventListener('click', () => $('file').click());
$('replace').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', event => importFile(event.target.files[0]));
document.addEventListener('dragover', event => { event.preventDefault(); $('upload').classList.add('drag-over'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('upload').classList.remove('drag-over'); });
document.addEventListener('drop', event => { event.preventDefault(); $('upload').classList.remove('drag-over'); importFile(event.dataTransfer.files[0]); });

for (const key of ['opacity', 'scale']) {
  $(key).addEventListener('input', event => {
    $(`${key}-number`).value = event.target.value;
    run('update', { patch: { [key]: Number(event.target.value) } });
  });
  $(`${key}-number`).addEventListener('change', event => {
    const value = event.target.valueAsNumber;
    if (!Number.isFinite(value)) { draw(current); return; }
    run('update', { patch: { [key]: value } });
  });
}
for (const key of ['x', 'y']) $(key).addEventListener('change', event => {
  const value = event.target.valueAsNumber;
  if (!Number.isFinite(value)) { draw(current); return; }
  run('update', { patch: { [key]: value } });
});
for (const key of ['visible', 'locked']) $(key).addEventListener('change', event => run('update', { patch: { [key]: event.target.checked } }));
$('document-mode').addEventListener('change', event => run('update', { patch: { documentMode: event.target.checked } }));
for (const action of ['fit', 'center', 'origin', 'reset']) $(action).addEventListener('click', () => run(action));
$('actual').addEventListener('click', () => run('update', { patch: { scale: 100 } }));
$('remove').addEventListener('click', async () => {
  await run('remove');
  // Removing clears the one saved image too, so a removed design does not remain on disk.
  try { await imageStore('readwrite', null); savedImage = null; draw(current); }
  catch { status('页面图片已移除，但清理本地保存失败。'); }
});
$('restore').addEventListener('click', () => { if (savedImage) run('load', { image: savedImage }); });

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^(https?|file):/i.test(tab.url || '')) throw new Error('请先打开要走查的普通网页。Chrome 内置页、新标签页和扩展商店不能叠图。');
    if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(tab.url)) throw new Error('Chrome 扩展商店不允许叠图，请切换到要走查的网页。');
    tabId = tab.id;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    try { savedImage = await imageStore('readonly'); } catch { status('无法读取上次图片；仍可选择图片进行本次对比。'); }
    await send('snapshot');
  } catch (error) {
    tabId = undefined;
    $('upload').disabled = true;
    const message = error.message || '';
    status(message.includes('Cannot access') || message.includes('Missing host permission') ? '此页面不允许扩展访问。若是本地文件，请在扩展详情中开启「允许访问文件网址」。' : message);
  }
}

init();
