'use strict';
importScripts('rules.js');
const R = globalThis.CXLocalRules;
let chain = Promise.resolve();

async function settings() {
  const data = await chrome.storage.local.get('settings');
  return { ...R.defaults, ...data.settings };
}
async function readTab(id) {
  const key = `tab:${id}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || { frames: {}, changedAt: Date.now(), lastActionAt: 0, pageKey: '', notice: '' };
}
async function saveQuestions(tab, report) {
  if (!report.questions?.length) return;
  const data = await chrome.storage.local.get('pending');
  const pending = data.pending || [];
  const top = tab.frames[0];
  let changed = false;
  for (const question of report.questions.slice(0, 10)) {
    const text = R.questionText(question.text).slice(0, 2400);
    if (!text) continue;
    let url = R.cleanUrl(top?.url || report.url);
    if (url && /^\d+$/.test(top?.directory?.currentId || '')) {
      const chapterUrl = new URL(url); chapterUrl.searchParams.set('chapterId', top.directory.currentId); url = chapterUrl.href;
    }
    const id = R.hash(url + '\n' + text);
    if (pending.some(item => item.id === id)) continue;
    changed = true;
    pending.push({ id, text, title: R.clean(top?.directory?.currentTitle || top?.title || report.title).slice(0, 200),
      url, detectedAt: new Date().toISOString(), done: false });
  }
  if (changed) await chrome.storage.local.set({ pending: pending.slice(-300) });
}
async function handle(message, sender) {
  if (message?.type === 'REPORT') {
    let origin;
    // Sandboxed or about:blank child frames can have an opaque origin.
    for (const candidate of [sender.origin, sender.url]) {
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'https:') { origin = parsed; break; }
      } catch {}
    }
    if (!origin) return {};
    if (sender.tab?.id == null || origin.protocol !== 'https:' || !/(^|\.)chaoxing\.com$/i.test(origin.hostname)) return {};
    const id = sender.tab.id;
    const tab = await readTab(id);
    const now = Date.now();
    const config = await settings();
    const report = { ...message.report, frameId: sender.frameId, documentId: sender.documentId, at: now };
    if (sender.frameId === 0 && (tab.pageKey !== report.pageKey || tab.documentId !== sender.documentId)) {
      tab.frames = {};
      tab.pageKey = report.pageKey;
      tab.documentId = sender.documentId;
      tab.changedAt = now;
      tab.notice = '';
    }
    const previous = tab.frames[sender.frameId];
    // Start a fresh settling interval whenever media, questions, or frame document change.
    const signature = item => JSON.stringify([item?.documentId, item?.nextAvailable, item?.nextTargetKey, item?.videos?.map(v => [v.id, v.ended]),
      item?.questions?.map(q => R.hash(R.questionText(q.text)))]);
    if (signature(previous) !== signature(report)) tab.changedAt = now;
    tab.frames[sender.frameId] = report;
    for (const [key, frame] of Object.entries(tab.frames)) if (now - frame.at > 15000) delete tab.frames[key];
    if (config.enabled && tab.frames[0]?.isStudyPage) await saveQuestions(tab, report);
    const decision = R.decide({ settings: config, frames: Object.values(tab.frames), now,
      changedAt: tab.changedAt, lastActionAt: tab.lastActionAt });
    if (decision) {
      tab.lastActionAt = now;
      tab.handoff = { until: now + 60000, token: `${now}:${decision.targetKey || ''}`,
        targetKey: decision.targetKey, method: tab.frames[0]?.navigationMethod };
      tab.notice = decision.reason === 'question' ? '已记录待答题，尝试进入下一节' : '视频结束，尝试进入下一节';
      // Persist the cooldown before requesting navigation, so simultaneous frame reports cannot double-click.
      await chrome.storage.session.set({ [`tab:${id}`]: tab });
      try {
        const reply = await chrome.tabs.sendMessage(id, { type: 'NEXT', pageKey: decision.pageKey, targetKey: decision.targetKey }, { frameId: 0 });
        if (!reply?.clicked) { tab.notice = '未找到确定的下一节，请手动切换'; tab.handoff = null; }
        else if (reply.title) tab.notice = `正在进入：${reply.title}`;
      } catch { tab.notice = '页面正在切换，等待重新连接'; }
    }
    await chrome.storage.session.set({ [`tab:${id}`]: tab });
    const inCourse = Boolean(tab.frames[0]?.isStudyPage);
    const handoff = tab.handoff;
    const autoVideo = inCourse && handoff?.until > now && (handoff.method !== 'directory'
      || tab.frames[0]?.directory?.currentKey === handoff.targetKey);
    return { settings: config, inCourse,
      playingUntil: inCourse ? R.playingUntil(Object.values(tab.frames), now) : 0,
      autoVideoUntil: autoVideo ? handoff.until : 0, autoVideoToken: autoVideo ? handoff.token : '' };
  }
  if (message?.type === 'STATUS') {
    const tab = message.tabId == null ? null : await readTab(message.tabId);
    const data = await chrome.storage.local.get('pending');
    return { settings: await settings(), tab, pending: data.pending || [] };
  }
  if (message?.type === 'SETTINGS') {
    const config = await settings();
    for (const key of Object.keys(R.defaults)) if (typeof message.values?.[key] === 'boolean') config[key] = message.values[key];
    await chrome.storage.local.set({ settings: config });
    return { settings: config };
  }
  if (message?.type === 'DONE') {
    const data = await chrome.storage.local.get('pending');
    const pending = data.pending || [];
    const item = pending.find(entry => entry.id === message.id);
    if (item) item.done = !item.done;
    await chrome.storage.local.set({ pending });
    return { pending };
  }
  return {};
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const job = chain.then(() => handle(message, sender));
  chain = job.catch(() => {});
  job.then(sendResponse, () => sendResponse({ error: '本地存储或页面连接暂不可用' }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});
