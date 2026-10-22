'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('./rules.js');

function scenario(overrides = {}) {
  const now = 50000;
  return { settings: { ...R.defaults }, now, changedAt: now - 6000, lastActionAt: 0,
    frames: [{ frameId: 0, at: now, pageKey: 'chapter-1', isStudyPage: true, nextAvailable: true,
      videos: [], questions: [] }, { frameId: 2, at: now, videos: [{ id: 'video-1', ended: true }], questions: [] }],
    ...overrides };
}
test('only naturally ended videos allow next; manual pause or an unfinished second video does not', () => {
  const value = scenario();
  assert.equal(R.decide(value)?.reason, 'ended');
  value.frames[1].videos[0] = { id: 'video-1', ended: false, paused: true, time: 99, duration: 100 };
  assert.equal(R.decide(value), null);
  value.frames[1].videos.push({ id: 'video-2', ended: true });
  assert.equal(R.decide(value), null);
});
test('question skip is opt-out and separate from successful video completion', () => {
  const value = scenario();
  value.frames[1].videos[0].ended = false;
  value.frames[1].questions.push({ text: '单选题：示例' });
  assert.equal(R.decide(value)?.reason, 'question');
  value.settings.skipQuestions = false;
  assert.equal(R.decide(value), null);
});
test('disabled helper, missing next, old frame, non-course page, settling, and cooldown prevent navigation', () => {
  const cases = [
    value => { value.settings.enabled = false; },
    value => { value.settings.autoNext = false; },
    value => { value.frames[0].nextAvailable = false; },
    value => { value.frames[0].isStudyPage = false; },
    value => { value.frames[0].at -= 6000; },
    value => { value.frames[1].at -= 6000; },
    value => { value.changedAt = value.now - 100; },
    value => { value.lastActionAt = value.now - 1000; }
  ];
  for (const setup of cases) { const value = scenario(); setup(value); assert.equal(R.decide(value), null); }
});
test('records strip authentication parameters and reject off-domain URLs', () => {
  const url = R.cleanUrl('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=42&chapterId=9&enc=SECRET&cpi=USER&openc=SECRET2');
  assert.equal(url, 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=42&chapterId=9');
  assert.equal(R.cleanUrl('https://chaoxing.com.evil.example/?courseId=42'), '');
  assert.equal(R.cleanUrl('javascript:alert(1)'), '');
  assert.equal(R.questionText('题目 剩余 15 秒 01:22'), R.questionText('题目 剩余 14 秒 01:21'));
});

test('frame playback expires after five seconds and excludes paused, ended or ambiguous media', () => {
  const now = 50000;
  assert.equal(R.playingUntil([{ at: now, videos: [{ paused: false, ended: false }] }], now), now + 5000);
  assert.equal(R.playingUntil([{ at: now - 5000, videos: [{ paused: false, ended: false }] }], now), 0);
  assert.equal(R.playingUntil([{ at: now, videos: [{ paused: true, ended: false }] }], now), 0);
  assert.equal(R.playingUntil([{ at: now, videos: [{ paused: false, ended: true }] }], now), 0);
  assert.equal(R.playingUntil([{ at: now, videos: [{ ended: false }] }], now), 0);
});

async function contentHarness({ inCourse = true, nextCount = 0, hasLocalVideo = true, remoteUntil = 0, topFrame = true } = {}) {
  const listeners = new Map();
  let messageHandler;
  let changedHandler;
  let interval;
  class Element {
    constructor(type) { this.type = type; this.isConnected = true; this.className = ''; this.disabled = false; this.children = []; }
    getClientRects() { return [1]; }
    contains(other) { return this === other || this.children.some(child => child.contains(other)); }
    closest(selector) { return selector.includes('.video-js') ? (this.root || null) : null; }
    addEventListener() {}
    getAttribute() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const root = new Element('player');
  const video = new Element('video');
  video.root = root;
  root.children.push(video);
  const control = new Element('control'); root.children.push(control);
  Object.assign(video, { paused: false, ended: false, readyState: 0, currentTime: 12, duration: 100, currentSrc: 'media', playCalls: 0,
    async play() { this.playCalls++; this.paused = false; } });
  const outside = new Element('outside');
  const next = Array.from({ length: nextCount }, () => Object.assign(new Element('button'), { innerText: '下一节', clicks: 0,
    click() { this.clicks++; } }));
  const document = { title: '本地测试', visibilityState: 'visible', documentElement: new Element('html'),
    addEventListener() {}, querySelector() { return null; },
    querySelectorAll(selector) { if (selector === 'video') return hasLocalVideo ? [video] : []; if (selector.startsWith('a, button')) return next; return []; } };
  const window = { addEventListener(name, handler) { listeners.set(name, handler); } }; window.top = topFrame ? window : {};
  const messages = [];
  const context = vm.createContext({ Element, document, window, URL, console, Date,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    location: { origin: 'https://mooc1.chaoxing.com', pathname: '/mycourse/studentstudy', search: '?chapterId=9',
      href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=9' },
    setInterval(fn) { interval = fn; return 1; }, clearInterval() {},
    chrome: { runtime: { id: 'test', onMessage: { addListener(fn) { messageHandler = fn; } },
      async sendMessage(message) { messages.push(message); return { settings: R.defaults, inCourse, playingUntil: remoteUntil }; } },
      storage: { local: { async get() { return { settings: R.defaults }; } },
        onChanged: { addListener(fn) { changedHandler = fn; } } } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('./rules.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('./directory.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('./playback.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('./content.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { video, root, control, outside, messages, next, interval,
    change(values) { changedHandler({ settings: { newValue: { ...R.defaults, ...values } } }, 'local'); },
    event(name, target, relatedTarget) { const event = { type: name, target, relatedTarget, stopped: false, stopImmediatePropagation() { this.stopped = true; } };
      listeners.get(name)(event); return event; },
    navigate(pageKey) { let response; messageHandler({ type: 'NEXT', pageKey }, {}, value => { response = value; }); return response; }
  };
}
test('content blocks actual exits from a playing player, but preserves internal moves and manual pause', async () => {
  const h = await contentHarness();
  for (const name of ['mouseout', 'mouseleave', 'pointerout', 'pointerleave']) {
    assert.equal(h.event(name, h.video, h.outside).stopped, true);
    assert.equal(h.event(name, h.video, h.control).stopped, false);
  }
  assert.equal(h.event('mouseout', h.outside, h.control).stopped, false);
  assert.equal(h.event('mouseout', h.outside, null).stopped, true);
  h.video.paused = true;
  assert.equal(h.event('mouseout', h.video, h.outside).stopped, false);
  await h.interval();
  assert.equal(h.video.playCalls, 0);
});
test('regression: parent without video protects a page exit from an arbitrary element when a child is playing', async () => {
  const h = await contentHarness({ hasLocalVideo: false, remoteUntil: Date.now() + 5000 });
  assert.equal(h.messages[0].report.videos.length, 0);
  for (const name of ['mouseout', 'mouseleave', 'pointerout', 'pointerleave']) {
    assert.equal(h.event(name, h.outside, null).stopped, true);
    assert.equal(h.event(name, h.outside, h.control).stopped, false);
  }
  await h.interval();
  assert.equal(h.messages.at(-1).report.pageExitEvents, 4);
  assert.equal(h.messages.at(-1).report.playerExitEvents, 0);
  assert.equal(h.messages.at(-1).report.lastExit.type, 'pointerleave');
  h.change({ enabled: false });
  assert.equal(h.event('mouseout', h.outside, null).stopped, false);
});
test('intermediate iframe gets page-exit protection too; stale and off-course playback cannot arm it', async () => {
  const middle = await contentHarness({ hasLocalVideo: false, remoteUntil: Date.now() + 5000, topFrame: false });
  assert.equal(middle.event('mouseout', middle.outside, null).stopped, true);
  const stale = await contentHarness({ hasLocalVideo: false, remoteUntil: Date.now() - 1 });
  assert.equal(stale.event('mouseout', stale.outside, null).stopped, false);
  const offCourse = await contentHarness({ inCourse: false, hasLocalVideo: false, remoteUntil: Date.now() + 5000 });
  assert.equal(offCourse.event('mouseout', offCourse.outside, null).stopped, false);
  assert.equal(stale.video.playCalls + offCourse.video.playCalls + middle.video.playCalls, 0);
});
test('content does not guard non-course pages or run after the user disables the helper', async () => {
  const offCourse = await contentHarness({ inCourse: false });
  assert.equal(offCourse.event('mouseout', offCourse.video, offCourse.outside).stopped, false);
  const h = await contentHarness(); h.change({ enabled: false });
  assert.equal(h.event('mouseout', h.video, h.outside).stopped, false);
});
test('next command revalidates page identity and refuses duplicate buttons', async () => {
  const h = await contentHarness({ nextCount: 1 });
  const pageKey = h.messages[0].report.pageKey;
  assert.equal(h.navigate('old-page').clicked, false);
  assert.equal(h.next[0].clicks, 0);
  assert.equal(h.navigate(pageKey).clicked, true);
  assert.equal(h.next[0].clicks, 1);
  h.change({ enabled: false });
  assert.equal(h.navigate(pageKey).clicked, false);
  const duplicate = await contentHarness({ nextCount: 2 });
  assert.equal(duplicate.navigate(duplicate.messages[0].report.pageKey).clicked, false);
  assert.equal(duplicate.next[0].clicks, 0);
});

test('background serializes simultaneous frame reports: one next action and one durable question record', async () => {
  let currentTime = 100000;
  let listener;
  let nextCalls = 0;
  const local = {}, session = {};
  const storageArea = memory => ({
    async get(key) { return structuredClone({ [key]: memory[key] }); },
    async set(values) { Object.assign(memory, structuredClone(values)); },
    async remove(key) { delete memory[key]; }
  });
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [currentTime])); } static now() { return currentTime; } }
  const context = vm.createContext({ URL, Date: Clock, console,
    chrome: { storage: { local: storageArea(local), session: storageArea(session) },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      tabs: { onRemoved: { addListener() {} }, async sendMessage() { nextCalls++; return { clicked: true }; } } }
  });
  context.importScripts = () => vm.runInContext(fs.readFileSync(require.resolve('./rules.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('./background.js'), 'utf8'), context);
  const sender = frameId => ({ tab: { id: 7 }, frameId, documentId: `document-${frameId}`,
    origin: 'https://mooc1.chaoxing.com', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' });
  const top = { pageKey: 'chapter-1', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=9&enc=SECRET',
    isStudyPage: true, nextAvailable: true, videos: [], questions: [], title: '课程' };
  const video = { videos: [{ id: 'v', ended: true }], questions: [] };
  const send = (report, frameId = 0, senderOverride = {}) => new Promise(resolve => listener({ type: 'REPORT', report }, { ...sender(frameId), ...senderOverride }, resolve));
  await send(top); await send(video, 2);
  currentTime += 6000;
  await Promise.all([send(top), send(video, 2), send(video, 2), send(video, 2)]);
  assert.equal(nextCalls, 1);
  const question = { ...video, videos: [{ id: 'v', ended: false }], questions: [{ text: '单选题：示例 A B C D' }] };
  await Promise.all([send(question, 2), send(question, 2)]);
  assert.equal(local.pending.length, 1);
  assert.equal(local.pending[0].url.includes('SECRET'), false);
  assert.equal(local.pending[0].done, false);
  assert.equal(nextCalls, 1);
  const playing = { videos: [{ id: 'v', paused: false, ended: false }], questions: [] };
  const playbackReply = await send(playing, 2);
  assert.equal(playbackReply.playingUntil, currentTime + 5000);
  const parentReply = await send(top);
  assert.equal(parentReply.playingUntil, currentTime + 5000);
  const differentTab = await send(top, 0, { tab: { id: 8 } });
  assert.equal(differentTab.playingUntil, 0);
  // A sandboxed Chaoxing frame may report the string "null" as its origin.
  const opaqueOrigin = await send(playing, 3, { origin: 'null' });
  assert.equal(opaqueOrigin.playingUntil, currentTime + 5000);
  await send({ ...playing, videos: [{ id: 'v', paused: true, ended: false }] }, 2);
  await send({ ...playing, videos: [{ id: 'v', paused: true, ended: false }] }, 3);
  assert.equal((await send(top)).playingUntil, 0);
  currentTime += 20000;
  const directoryTop = { ...top, pageKey: 'dir-A', nextTargetKey: 'id:10', navigationMethod: 'directory',
    directory: { currentKey: 'id:9', currentId: '9', currentTitle: '1.1 示例甲' } };
  await send(directoryTop); await send(video, 2);
  currentTime += 6000;
  await send(directoryTop);
  const beforeConfirmation = await send(video, 2);
  assert.equal(nextCalls, 2);
  assert.equal(beforeConfirmation.autoVideoUntil, 0);
  const confirmed = await send({ ...directoryTop, pageKey: 'dir-B', directory: { currentKey: 'id:10', currentId: '10', currentTitle: '1.2 示例乙' } });
  assert.ok(confirmed.autoVideoUntil > currentTime);
  assert.ok(confirmed.autoVideoToken);
  await send(question, 2);
  assert.equal(local.pending.at(-1).title, '1.2 示例乙');
  assert.equal(new URL(local.pending.at(-1).url).searchParams.get('chapterId'), '10');
});
