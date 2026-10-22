/* Shared, deterministic navigation rules; no page globals or player internals. */
(function (root) {
  'use strict';
  const defaults = { enabled: true, autoPlay: true, mutedFallback: true, autoNext: true, directoryNext: true, skipQuestions: true };
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const questionText = value => clean(value)
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, '[时间]')
    .replace(/剩余\s*\d+\s*秒/g, '剩余[时间]');
  function hash(value) {
    let result = 2166136261;
    for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
    return (result >>> 0).toString(36);
  }
  function cleanUrl(raw) {
    try {
      const source = new URL(raw);
      if (source.protocol !== 'https:' || !/(^|\.)chaoxing\.com$/i.test(source.hostname)) return '';
      const result = new URL(source.origin + source.pathname);
      for (const name of ['courseId', 'courseid', 'chapterId', 'chapterid', 'knowledgeid', 'clazzid']) {
        const value = source.searchParams.get(name);
        if (value && /^\d+$/.test(value)) result.searchParams.set(name, value);
      }
      return result.href;
    } catch { return ''; }
  }
  function playingUntil(frames, now) {
    // A parent document usually contains an iframe, not the actual <video>.
    // Only recent, explicitly playing media reports can arm its page-exit guard.
    let until = 0;
    for (const frame of frames) {
      if (now - frame.at >= 5000) continue;
      if (frame.videos?.some(video => video.paused === false && !video.ended)) {
        until = Math.max(until, frame.at + 5000);
      }
    }
    return until;
  }
  function decide({ settings, frames, now, changedAt, lastActionAt }) {
    if (!settings.enabled || !settings.autoNext) return null;
    if (now - changedAt < 5000 || now - lastActionAt < 12000) return null;
    const live = frames.filter(frame => now - frame.at < 5000);
    const top = live.find(frame => frame.frameId === 0);
    if (!top?.nextAvailable || !top.isStudyPage || !top.pageKey) return null;
    const questions = live.flatMap(frame => frame.questions || []);
    if (questions.length) return settings.skipQuestions ? { reason: 'question', pageKey: top.pageKey, targetKey: top.nextTargetKey } : null;
    const videos = live.flatMap(frame => frame.videos || []);
    if (videos.length && videos.every(video => video.ended)) return { reason: 'ended', pageKey: top.pageKey, targetKey: top.nextTargetKey };
    return null;
  }
  const api = { defaults, clean, questionText, hash, cleanUrl, playingUntil, decide };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CXLocalRules = api;
})(globalThis);
