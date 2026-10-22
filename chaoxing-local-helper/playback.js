(function (root) {
  'use strict';
  function create(options) {
    const sourceOf = video => video.getAttribute('src') || video.currentSrc || video.querySelector('source[src]')?.getAttribute('src') || '';
    function restoreFallback(state) {
      const restore = state.mutedForAuto && state.video.muted;
      state.mutedForAuto = false;
      if (restore && state.video.paused) state.video.muted = state.originalMuted;
    }
    function reset(state, source, sameSource = false) {
      const manualStop = sameSource && state.manualStop;
      const clicked = (sameSource || !state.source) && state.clicked;
      const completed = sameSource ? state.completed : !state.video.paused && state.video.currentTime > 0;
      restoreFallback(state);
      Object.assign(state, { source, generation: state.generation + 1, flight: null,
        completed, manualStop, clicked,
        attempts: 0, nextAt: 0, deadline: Date.now() + 60000, policyBlocked: false, note: '', error: '' });
      state.id = `${state.baseId}:${state.generation}`;
    }
    function sync(state) {
      const source = sourceOf(state.video);
      if (source !== state.source) reset(state, source);
    }
    function mediaVisible(video) {
      const player = options.rootFor(video);
      return options.visible(video) || (player !== video && options.visible(player) && player.querySelectorAll('video').length === 1);
    }
    function canAct(state) {
      const config = options.settings();
      return config.enabled && config.autoPlay && options.allowed() && !state.manualStop && !state.completed
        && !state.video.ended && mediaVisible(state.video)
        && (document.visibilityState !== 'hidden' || options.handoff()) && !options.blocked();
    }
    function buttonFor(video) {
      const buttons = [...options.rootFor(video).querySelectorAll(
        '.vjs-big-play-button, .vjs-play-control, button[title="播放"], button[aria-label="播放"], button[title="Play"], button[aria-label="Play"]'
      )].filter(button => options.visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
      // Prefer the initial overlay rather than clicking two play toggles.
      return buttons.find(button => button.classList?.contains('vjs-big-play-button')) || (buttons.length === 1 ? buttons[0] : null);
    }
    function finish(state, flight) {
      if (state.flight !== flight) return;
      state.flight = null;
      if (!state.video.paused) {
        state.completed = true;
        state.error = '';
        state.note = state.mutedForAuto ? '已静音自动播放；需要声音时请点击播放器取消静音' : '';
      } else {
        state.nextAt = Date.now() + 750;
        state.note = '播放器尚未开始播放，等待重新尝试';
        setTimeout(options.wake, 800);
      }
      options.wake();
    }
    function failed(state, flight, error, mutedAttempt = false) {
      if (state.flight !== flight) return;
      const name = error?.name || 'Error';
      state.error = name;
      if (name === 'NotAllowedError' && !mutedAttempt && !state.video.muted
        && options.settings().mutedFallback && canAct(state)) {
        state.originalMuted = state.video.muted;
        state.mutedForAuto = true;
        state.video.muted = true;
        state.note = '有声自动播放被拦截，尝试静音起播';
        invoke(state, flight, true);
        return;
      }
      state.flight = null;
      if (name === 'NotAllowedError') {
        state.policyBlocked = true;
        restoreFallback(state);
        state.note = 'Chrome 仍拦截自动播放，请在视频上手动点击一次播放';
      } else if (name === 'NotSupportedError') {
        state.policyBlocked = true;
        restoreFallback(state);
        state.note = '视频资源暂不可播放，等待资源更新或手动播放';
      } else {
        state.nextAt = Date.now() + Math.min(4000, state.attempts * 750);
        state.note = state.attempts >= 5 ? '自动起播重试已停止，请手动播放' : `播放被加载过程打断，准备重试（${state.attempts}/5）`;
        if (state.attempts >= 5) restoreFallback(state);
        else setTimeout(options.wake, Math.min(4000, state.attempts * 750) + 30);
      }
      options.wake();
    }
    function invoke(state, flight, mutedAttempt = false) {
      try {
        Promise.resolve(state.video.play()).then(() => finish(state, flight), error => failed(state, flight, error, mutedAttempt));
      } catch (error) { failed(state, flight, error, mutedAttempt); }
    }
    function start(state) {
      sync(state);
      if (!canAct(state) || !state.video.paused || state.flight || state.policyBlocked
        || state.attempts >= 5 || Date.now() < state.nextAt || Date.now() > state.deadline) return;
      const button = !state.clicked && buttonFor(state.video);
      if (!state.source) {
        state.note = '等待视频资源或播放器就绪';
        if (button) {
          state.clicked = true;
          button.click();
          state.note = '已点击播放器，等待视频资源加载';
          setTimeout(options.wake, 500);
        }
        return;
      }
      state.attempts += 1;
      const flight = { at: Date.now() };
      state.flight = flight;
      state.note = '已请求播放，等待视频加载';
      // Use the existing player's start control once so its own initialization handlers run.
      if (button) { state.clicked = true; button.click(); }
      if (state.flight !== flight || state.manualStop) return;
      invoke(state, flight);
      // A pending play promise must not stall course reports or prevent a later bounded retry.
      setTimeout(() => {
        if (state.flight !== flight) return;
        state.flight = null;
        state.nextAt = Date.now() + 750;
        state.note = '视频加载较慢，等待重新尝试';
        options.wake();
      }, 8000);
    }
    function attach(video, baseId) {
      const state = { video, baseId, id: baseId, generation: 0, source: sourceOf(video),
        completed: !video.paused && video.currentTime > 0, manualStop: false, clicked: false,
        flight: null, attempts: 0, nextAt: 0, deadline: Date.now() + 60000,
        policyBlocked: false, mutedForAuto: false, originalMuted: video.muted, note: '', error: '' };
      video.addEventListener('playing', () => {
        state.completed = true; state.flight = null; state.error = '';
        state.note = state.mutedForAuto ? '已静音自动播放；需要声音时请点击播放器取消静音' : '';
        options.wake();
      });
      video.addEventListener('pause', () => {
        // A pause during resource initialization is not evidence of a user pause.
        // Once playback actually started, ordinary pauses are never force-resumed.
        if (state.completed) state.flight = null;
        options.wake();
      });
      video.addEventListener('ended', () => { state.completed = true; state.flight = null; options.wake(); });
      video.addEventListener('emptied', () => { const source = sourceOf(video); reset(state, source, source === state.source); options.wake(); });
      for (const event of ['loadedmetadata', 'loadeddata', 'canplay']) video.addEventListener(event, () => {
        sync(state);
        if (!state.manualStop && !state.completed) state.nextAt = 0;
        options.wake();
      });
      video.addEventListener('volumechange', () => {
        if (state.mutedForAuto && !video.muted) { state.mutedForAuto = false; state.note = ''; }
      });
      return state;
    }
    function userInput(event) {
      if (!event.isTrusted) return;
      for (const state of options.records) {
        const root = options.rootFor(state.video);
        const mediaKey = event.type === 'keydown' && [' ', 'Spacebar', 'k', 'K', 'MediaPlayPause', 'MediaPause'].includes(event.key);
        if (!root.contains(event.target) && !mediaKey) continue;
        state.manualStop = true;
        state.flight = null;
        if (state.video.paused) restoreFallback(state);
      }
    }
    window.addEventListener('pointerdown', userInput, { capture: true });
    window.addEventListener('keydown', userInput, { capture: true });
    function settingsChanged(before, after) {
      for (const state of options.records) {
        if (!after.enabled || !after.autoPlay) state.flight = null;
        if ((!before.mutedFallback && after.mutedFallback) || (!before.autoPlay && after.autoPlay)) {
          state.policyBlocked = false; state.attempts = 0; state.deadline = Date.now() + 60000;
        }
      }
    }
    return { attach, sync, start, settingsChanged, mediaVisible };
  }
  root.CXLocalPlayback = { create };
})(globalThis);
