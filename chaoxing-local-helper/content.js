(function () {
  'use strict';
  if (globalThis.__CX_LOCAL_HELPER__) return;
  globalThis.__CX_LOCAL_HELPER__ = true;
  const R = globalThis.CXLocalRules;
  const D = globalThis.CXLocalDirectory;
  const P = globalThis.CXLocalPlayback;
  let config = { ...R.defaults, enabled: false };
  let currentQuestions = [];
  let sent = false;
  let blockedEvents = 0;
  let pageExitEvents = 0;
  let playerExitEvents = 0;
  let remotePlayingUntil = 0;
  let lastExit = null;
  let lastFocusLossAt = 0;
  let active = true;
  let inCourse = false;
  let lastLocalSkip = 0;
  let navigationAttempt = null;
  let openedVideoToken = '';
  let autoVideoUntil = 0;
  let videoSequence = 0;
  const observed = new WeakMap();
  const states = new Set();
  const isTop = window === window.top;
  const PLAYER = '.video-js, .vjs-player, .ans-video, [data-vjs-player]';
  const QUESTION = '.ans-videoquiz, .ans-videoquiz-wrap, .ans-videoquiz-content, .ans-attach-quiz, .ans-test, .TiMu, .mark_table, [role="dialog"], dialog, form';

  const visible = element => Boolean(element?.isConnected && element.getClientRects().length
    && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
  const elementOf = target => target instanceof Element ? target : null;
  function rootFor(video) { return video.closest(PLAYER) || video; }
  const playback = P.create({ records: states, rootFor, visible, settings: () => config,
    allowed: () => active && inCourse, handoff: () => autoVideoUntil > Date.now(),
    blocked: () => questionRoots().length > 0 || [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].some(visible),
    wake: () => { void tick(); } });

  function blockExit(event, scope) {
    blockedEvents += 1;
    if (scope === 'page') pageExitEvents += 1;
    else playerExitEvents += 1;
    lastExit = { type: event.type, scope, at: Date.now() };
    event.stopImmediatePropagation();
  }
  // DOM capture listeners only: no timer spoofing, player monkey-patching, progress requests or seeking.
  // Mouseout also covers jQuery's synthesized mouseleave. Moves within one player are left untouched.
  function guardLeave(event) {
    if (!config.enabled || !active || !inCourse) return;
    const target = elementOf(event.target);
    const related = elementOf(event.relatedTarget);
    const videos = [...document.querySelectorAll('video')]
      .filter(video => !video.paused && !video.ended && playback.mediaVisible(video));
    // Moving into Chrome's toolbar/tab strip has no destination DOM element.
    // This event may originate on ANY page element in a parent with no local video.
    // Aggregate playback from child frames instead of requiring a local <video>.
    if (!event.relatedTarget && (videos.length || remotePlayingUntil > Date.now())) {
      blockExit(event, 'page');
      return;
    }
    for (const video of videos) {
      const root = rootFor(video);
      const wholeDocument = event.target === document || event.target === window || event.target === document.documentElement;
      if (!wholeDocument && (!target || !root.contains(target))) continue;
      if (related && root.contains(related)) continue;
      blockExit(event, 'player');
      break;
    }
  }
  for (const name of ['mouseout', 'mouseleave', 'pointerout', 'pointerleave']) {
    window.addEventListener(name, guardLeave, { capture: true });
  }
  // Focus/visibility information is diagnostic only; no focus state is forged.
  window.addEventListener('blur', () => { lastFocusLossAt = Date.now(); }, { capture: true });

  function questionRoots() {
    const candidates = [...document.querySelectorAll(QUESTION)].filter(visible).filter(element => {
      const text = R.clean(element.innerText);
      const answers = element.querySelector('input[type="radio"], input[type="checkbox"], textarea, input[type="text"]');
      const questionWords = /单选题|多选题|判断题|填空题|简答题|正确答案|提交答案|提交作业|章节测验|章节测试|视频测验/;
      const quizClass = /ans-videoquiz|ans-attach-quiz|ans-test|TiMu/.test(element.className || '');
      return text.length > 3 && ((answers && questionWords.test(text)) || (quizClass && (answers || questionWords.test(text))));
    });
    // Prefer individual questions over a surrounding form containing the same questions.
    return candidates.filter(root => !candidates.some(other => other !== root && root.contains(other)));
  }
  function explicitButton(root, labels) {
    const matches = [...root.querySelectorAll('a, button, input[type="button"], [role="button"]')].filter(element => {
      if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true'
        || /(^|\s)(disabled|disable)(\s|$)/.test(element.className || '')) return false;
      const text = R.clean(element.innerText || element.value || element.getAttribute('aria-label') || element.title)
        .replace(/[>＞»→›《》〈〉]/g, '').trim();
      return labels.includes(text);
    });
    return matches.length === 1 ? matches[0] : null;
  }
  function nextButton() {
    if (!isTop || !isStudyPage()) return null;
    const button = explicitButton(document, ['下一节', '下一章', '下一章节']);
    if (!button || button.closest('form, .ans-test, .ans-videoquiz, .TiMu')) return null;
    if (button.tagName === 'A' && button.getAttribute('href')?.match(/^https?:/i)) {
      try { if (!/(^|\.)chaoxing\.com$/i.test(new URL(button.href).hostname)) return null; } catch { return null; }
    }
    return button;
  }
  function isStudyPage() { return /\/mycourse\/studentstudy(?:$|\/)/i.test(location.pathname); }
  function pageKey() { return location.origin + location.pathname + location.search; }
  function navigationPlan() {
    const directory = isTop && isStudyPage() ? D.scan(document, location.href) : { next: null, info: { count: 0 } };
    const info = { ...directory.info };
    const identity = R.hash(pageKey() + '|' + (info.currentKey || ''));
    if (navigationAttempt && navigationAttempt.fromPageKey !== identity) navigationAttempt = null;
    let target = null, targetKey = '', method = '';
    if (config.directoryNext && info.currentKey) {
      target = directory.next; targetKey = info.nextKey; method = 'directory';
    } else {
      target = nextButton();
      if (target) { targetKey = 'button:' + R.hash(target.getAttribute('href') || R.clean(target.innerText)); method = 'button'; }
    }
    if (navigationAttempt?.fromPageKey === identity) {
      target = null;
      info.note = Date.now() - navigationAttempt.at < 25000 ? '已请求切换，等待当前章节变化' : '未能确认章节切换，请手动点击目录或刷新页面';
    }
    return { target, targetKey, method, pageKey: identity, info };
  }

  function bindVideo(video) {
    if (observed.has(video)) return observed.get(video);
    const state = playback.attach(video, `video-${++videoSequence}`);
    observed.set(video, state);
    states.add(state);
    return state;
  }
  async function tick() {
    if (!active || sent) return;
    sent = true;
    try {
      const roots = questionRoots();
      currentQuestions = roots.slice(0, 10).map(root => ({ text: R.clean(root.innerText).slice(0, 2400) }));
      const videos = [];
      for (const state of states) if (!state.video.isConnected) states.delete(state);
      for (const video of document.querySelectorAll('video')) {
        const state = bindVideo(video);
        playback.sync(state);
        if (!playback.mediaVisible(video)) continue;
        playback.start(state);
        videos.push({ id: state.id, paused: video.paused, ended: video.ended,
          time: Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : 0,
          duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null, note: state.note,
          attempts: state.attempts, muted: video.muted, readyState: video.readyState, error: state.error });
      }
      const plan = navigationPlan();
      const reply = await chrome.runtime.sendMessage({ type: 'REPORT', report: {
        // Authentication parameters never leave the page or enter persistent storage.
        pageKey: plan.pageKey, url: R.cleanUrl(location.href), title: document.title,
        isStudyPage: isStudyPage(), nextAvailable: Boolean(plan.target), nextTargetKey: plan.targetKey,
        navigationMethod: plan.method, directory: plan.info,
        videos, questions: currentQuestions, blockedEvents, pageExitEvents, playerExitEvents,
        lastExit, lastFocusLossAt, visibility: document.visibilityState,
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null
      } });
      if (reply?.settings) config = reply.settings;
      inCourse = Boolean(reply?.inCourse);
      remotePlayingUntil = inCourse && Number.isFinite(reply?.playingUntil) ? reply.playingUntil : 0;
      autoVideoUntil = Number(reply?.autoVideoUntil) || 0;
      // Retry after the first frame handshake instead of waiting for a potentially throttled interval.
      for (const state of states) playback.start(state);
      // During a confirmed automatic chapter handoff, open the actual Video task tab once.
      // This does not run while the user is simply reading a chapter or pausing an existing video.
      if (config.enabled && config.autoPlay && inCourse && reply.autoVideoUntil > Date.now()
        && reply.autoVideoToken && openedVideoToken !== reply.autoVideoToken && !videos.length
        && remotePlayingUntil <= Date.now()) {
        const tab = D.videoTab(document);
        if (tab) { openedVideoToken = reply.autoVideoToken; tab.click(); }
      }
      // Only use an actual visible skip control belonging to the detected question container.
      // Never click answers, submit, close, fast-forward or change the video's currentTime.
      if (config.enabled && inCourse && config.skipQuestions && currentQuestions.length && Date.now() - lastLocalSkip > 10000) {
        for (const root of roots) {
          const skip = explicitButton(root, ['跳过', '暂不作答', '稍后作答']);
          if (skip) { lastLocalSkip = Date.now(); skip.click(); break; }
        }
      }
    } catch {
      // Extension reload invalidates old content contexts. Stop quietly until the page is refreshed.
      if (!chrome.runtime?.id) { active = false; clearInterval(timer); }
    } finally { sent = false; }
  }
  chrome.storage.local.get('settings').then(data => { config = { ...R.defaults, ...data.settings }; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      const before = config;
      config = { ...R.defaults, ...changes.settings.newValue };
      playback.settingsChanged(before, config);
      void tick();
    }
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'NEXT' || !isTop) return;
    const plan = navigationPlan();
    const button = config.enabled && inCourse && config.autoNext && message.pageKey === plan.pageKey
      && (!message.targetKey || message.targetKey === plan.targetKey) && plan.target;
    if (button) navigationAttempt = { fromPageKey: plan.pageKey, at: Date.now() };
    reply({ clicked: Boolean(button), method: plan.method, title: plan.info.nextTitle || '', targetKey: plan.targetKey });
    if (button) button.click();
  });
  const timer = setInterval(tick, 1500);
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(records => {
      const mediaAdded = records.some(record => record.type === 'attributes' && record.target.matches('video, source')
        || [...record.addedNodes].some(node => node instanceof Element && (node.matches('video, iframe, source') || node.querySelector('video, iframe, source'))));
      if (mediaAdded) void tick();
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  }
  document.addEventListener('visibilitychange', tick);
  document.addEventListener('DOMContentLoaded', tick, { once: true });
  tick();
})();
