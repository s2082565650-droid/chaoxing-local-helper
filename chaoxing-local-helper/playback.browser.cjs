'use strict';
// Synthetic player states exercise startup failure paths without contacting the real course.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.CX_TEST_PLAYWRIGHT || 'playwright');
const base = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=9';
const browserReady = chromium.launch({ headless: true, executablePath: process.env.CX_TEST_BROWSER,
  args: ['--autoplay-policy=document-user-activation-required'] });
after(async () => { await (await browserReady).close(); });
async function open({ mode = 'ok', content = false, hidden = false, handoff = false, source = true,
  prePause = false, mutedFallback = true, button = false, modal = '' } = {}) {
  const page = await (await browserReady).newPage();
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div class="video-js"><video preload="none" ${source ? 'src="/fixture-v1.mp4"' : ''}></video><button id="manual">手动暂停</button>${button ? '<button class="vjs-big-play-button" id="start">播放</button>' : ''}</div>${modal ? `<div aria-modal="true" ${modal === 'hidden' ? 'hidden' : ''}>测试弹窗</div>` : ''}</body></html>`;
  await page.route('**/*', route => route.request().url() === base
    ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
  await page.goto(base);
  for (const file of ['rules.js', 'directory.js', 'playback.js']) await page.addScriptTag({ path: path.join(__dirname, file) });
  await page.evaluate(({ mode, hidden, handoff, prePause, mutedFallback }) => {
    const video = document.querySelector('video');
    window.__media = { paused: true, ended: false, time: 0, ready: 0, mode, calls: [], buttonClicks: 0 };
    for (const [name, field] of [['paused', 'paused'], ['ended', 'ended'], ['currentTime', 'time'], ['readyState', 'ready']]) {
      Object.defineProperty(video, name, { configurable: true, get() { return __media[field]; } });
    }
    Object.defineProperty(video, 'currentSrc', { configurable: true, get() { return video.getAttribute('src') || ''; } });
    video.play = function () {
      __media.calls.push({ muted: video.muted, src: video.getAttribute('src') });
      if (__media.mode === 'pending') return new Promise(() => {});
      if (__media.mode === 'abort') { __media.mode = 'ok'; return Promise.reject(new DOMException('loading', 'AbortError')); }
      if (__media.mode === 'policy' && !video.muted) return Promise.reject(new DOMException('gesture', 'NotAllowedError'));
      if (__media.mode === 'unsupported') return Promise.reject(new DOMException('source', 'NotSupportedError'));
      __media.paused = false;
      video.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    };
    if (hidden) Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.__settings = { ...CXLocalRules.defaults, mutedFallback };
    window.__handoff = handoff;
    window.__records = new Set();
    window.__wakes = 0;
    document.querySelector('#manual').onclick = () => { __media.paused = true; video.dispatchEvent(new Event('pause')); };
    const start = document.querySelector('#start');
    if (start) start.onclick = () => { __media.buttonClicks++; video.setAttribute('src', '/fixture-v1.mp4'); };
    window.__reports = [];
    window.__reply = { settings: __settings, inCourse: true, playingUntil: 0,
      autoVideoUntil: handoff ? Date.now() + 60000 : 0, autoVideoToken: handoff ? 'next-chapter' : '' };
    window.chrome ||= {};
    Object.assign(window.chrome, { runtime: { id: 'test', onMessage: { addListener(fn) { window.__listener = fn; } },
      async sendMessage(message) {
        __reports.push(message.report);
        if (prePause && __reports.length === 1) video.dispatchEvent(new Event('pause'));
        return __reply;
      } }, storage: { local: { async get() { return { settings: __settings }; } },
        onChanged: { addListener(fn) { window.__settingsListener = fn; } } } });
  }, { mode, hidden, handoff, prePause, mutedFallback });
  if (content) await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
  else await page.evaluate(() => {
    __manager = CXLocalPlayback.create({ records: __records, settings: () => __settings,
      allowed: () => true, handoff: () => __handoff,
      rootFor: video => video.closest('.video-js') || video,
      visible: element => Boolean(element.getClientRects().length),
      blocked: () => Boolean(document.querySelector('.ans-videoquiz')),
      wake: () => { __wakes++; } });
    __state = __manager.attach(document.querySelector('video'), 'test-video');
    __records.add(__state);
  });
  return page;
}
const start = page => page.evaluate(() => __manager.start(__state));

test('startup: preload=none can start before current media data is available', async () => {
  const page = await open(); await start(page);
  assert.equal(await page.evaluate(() => __media.ready), 0);
  assert.equal(await page.evaluate(() => __media.calls.length), 1);
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup regression: a player initialization pause does not become a manual pause', async () => {
  const page = await open({ content: true, prePause: true });
  await page.waitForFunction(() => __media.calls.length === 1);
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup: AbortError is retried after a readiness event', async () => {
  const page = await open({ mode: 'abort' }); await start(page);
  await page.waitForFunction(() => __state.error === 'AbortError');
  await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('canplay')));
  await start(page);
  assert.equal(await page.evaluate(() => __media.calls.length), 2);
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup: NotAllowedError falls back to muted playback and reports it explicitly', async () => {
  const page = await open({ mode: 'policy' }); await start(page);
  await page.waitForFunction(() => !__media.paused);
  const result = await page.evaluate(() => ({ calls: __media.calls, note: __state.note, muted: document.querySelector('video').muted }));
  assert.deepEqual(result.calls.map(call => call.muted), [false, true]);
  assert.equal(result.muted, true); assert.match(result.note, /静音自动播放/);
  await page.close();
});
test('startup: disabled muted fallback preserves sound settings and asks for a user click', async () => {
  const page = await open({ mode: 'policy', mutedFallback: false }); await start(page);
  await page.waitForFunction(() => __state.policyBlocked);
  await start(page);
  assert.equal(await page.evaluate(() => __media.calls.length), 1);
  assert.equal(await page.evaluate(() => document.querySelector('video').muted), false);
  assert.match(await page.evaluate(() => __state.note), /手动点击/);
  await page.close();
});
test('startup: a trusted manual pause is preserved', async () => {
  const page = await open(); await start(page);
  await page.click('#manual'); await start(page);
  assert.equal(await page.evaluate(() => __state.manualStop), true);
  assert.equal(await page.evaluate(() => __media.paused), true);
  assert.equal(await page.evaluate(() => __media.calls.length), 1);
  await page.close();
});
test('startup: a quiz cannot be force-started through', async () => {
  const page = await open();
  await page.evaluate(() => { const quiz = document.createElement('div'); quiz.className = 'ans-videoquiz'; quiz.textContent = '单选题'; document.body.append(quiz); });
  await start(page); assert.equal(await page.evaluate(() => __media.calls.length), 0);
  await page.close();
});
test('startup: resource changes on the same video element reset only the new resource', async () => {
  const page = await open(); await start(page);
  await page.click('#manual');
  await page.evaluate(() => { __media.time = 0; document.querySelector('video').setAttribute('src', '/fixture-v2.mp4'); });
  await start(page);
  assert.equal(await page.evaluate(() => __media.calls.length), 2);
  assert.equal(await page.evaluate(() => __media.calls[1].src), '/fixture-v2.mp4');
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup: reloading an already played source does not restart a completed video', async () => {
  const page = await open(); await start(page);
  await page.evaluate(() => { __media.paused = true; document.querySelector('video').dispatchEvent(new Event('emptied')); });
  await start(page); assert.equal(await page.evaluate(() => __media.calls.length), 1);
  await page.close();
});
test('startup integration: pending play promises never block status reports', async () => {
  const page = await open({ mode: 'pending', content: true });
  await page.waitForFunction(() => __media.calls.length === 1);
  const previous = await page.evaluate(() => __reports.length);
  await page.waitForFunction(count => __reports.length > count, previous);
  assert.equal(await page.evaluate(() => __media.calls.length), 1);
  assert.match(await page.evaluate(() => __reports.at(-1).videos[0].note), /等待视频加载/);
  await page.close();
});
test('startup integration: a confirmed next chapter can start in a background tab', async () => {
  const page = await open({ hidden: true, handoff: true, content: true });
  await page.waitForFunction(() => __media.calls.length === 1);
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup: an unrelated hidden page is not automatically started', async () => {
  const page = await open({ hidden: true }); await start(page);
  assert.equal(await page.evaluate(() => __media.calls.length), 0);
  await page.close();
});
test('startup: an existing play button can initialize a source before native play', async () => {
  const page = await open({ source: false, button: true }); await start(page); await start(page);
  assert.equal(await page.evaluate(() => __media.buttonClicks), 1);
  assert.equal(await page.evaluate(() => __media.calls.length), 1);
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup: a single media element hidden behind a visible player can still be initialized', async () => {
  const page = await open();
  await page.evaluate(() => document.querySelector('video').style.display = 'none');
  await start(page);
  assert.equal(await page.evaluate(() => __media.calls.length), 1);
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup integration: hidden dialog placeholders do not block video startup', async () => {
  const page = await open({ content: true, modal: 'hidden' });
  await page.waitForFunction(() => __media.calls.length === 1);
  assert.equal(await page.evaluate(() => __media.paused), false);
  await page.close();
});
test('startup integration: a visible modal continues to block video startup', async () => {
  const page = await open({ content: true, modal: 'visible' });
  await page.waitForFunction(() => __reports.length > 0);
  assert.equal(await page.evaluate(() => __media.calls.length), 0);
  await page.close();
});
test('native Chrome playback: blocked audible start falls back to muted native playback', async () => {
  // Two seconds of local PCM audio. No fake play() result or network media is involved.
  const bytes = Buffer.alloc(44 + 8000 * 2 * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const page = await (await browserReady).newPage();
  // Start from parser-inserted scripts: automation's evaluate() carries a user-gesture
  // flag, which would accidentally grant audible autoplay and invalidate this test.
  const setup = `
    window.__calls = [];
    const video = document.querySelector('video'), nativePlay = video.play.bind(video), records = new Set();
    video.play = () => { __calls.push({ muted: video.muted }); return nativePlay(); };
    window.__manager = CXLocalPlayback.create({ records, settings: () => CXLocalRules.defaults,
      allowed: () => true, handoff: () => true, rootFor: v => v.parentElement,
      visible: element => Boolean(element.getClientRects().length), blocked: () => false, wake: () => {} });
    window.__state = __manager.attach(video, 'native'); records.add(__state); __manager.start(__state);
  `;
  const scripts = ['rules.js', 'playback.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  const html = `<html><head><meta charset="utf-8"></head><body><div class="video-js"><video preload="none" src="data:audio/wav;base64,${bytes.toString('base64')}"></video></div><script>${scripts}\n${setup}</script></body></html>`;
  await page.route('**/*', route => route.request().url() === base
    ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0 && __state.completed);
  assert.deepEqual(await page.evaluate(() => __calls.map(call => call.muted)), [false, true]);
  assert.equal(await page.evaluate(() => document.querySelector('video').muted), true);
  assert.match(await page.evaluate(() => __state.note), /静音自动播放/);
  await page.close();
});
