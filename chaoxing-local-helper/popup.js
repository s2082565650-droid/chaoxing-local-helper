'use strict';
let tabId;
let records = [];
let saving = false;
const status = document.getElementById('status');
const keys = ['enabled', 'autoPlay', 'mutedFallback', 'autoNext', 'directoryNext', 'skipQuestions'];
const send = message => chrome.runtime.sendMessage(message);
const time = seconds => seconds == null ? '?' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
function renderRecords(pending) {
  records = pending;
  const container = document.getElementById('pending');
  container.replaceChildren();
  document.getElementById('count').textContent = `(${pending.filter(item => !item.done).length})`;
  for (const item of [...pending].reverse()) {
    const box = document.createElement('div'); box.className = `record${item.done ? ' done' : ''}`;
    const title = document.createElement('div'); title.className = 'title'; title.textContent = item.title || '课程题目';
    const question = document.createElement('div'); question.className = 'question'; question.textContent = item.text;
    const meta = document.createElement('div'); meta.className = 'meta';
    let chapter = '';
    try { const url = new URL(item.url); chapter = url.searchParams.get('chapterId') || url.searchParams.get('chapterid') || ''; } catch {}
    meta.textContent = new Date(item.detectedAt).toLocaleString() + (chapter ? ` · 章节 ID ${chapter}` : '');
    const button = document.createElement('button'); button.textContent = item.done ? '恢复待办' : '标记已做';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { const reply = await send({ type: 'DONE', id: item.id }); if (reply.pending) renderRecords(reply.pending); }
      finally { button.disabled = false; }
    });
    box.append(title, question, meta, button); container.append(box);
  }
  if (!pending.length) container.textContent = '暂未记录到题目。';
}
async function refresh() {
  try {
    const reply = await send({ type: 'STATUS', tabId });
    if (reply.error) { status.textContent = reply.error; return; }
    if (!saving) for (const key of keys) document.getElementById(key).checked = reply.settings[key];
    const frames = Object.values(reply.tab?.frames || {}).filter(frame => Date.now() - frame.at < 6000);
    const videos = frames.flatMap(frame => frame.videos || []);
    const questions = frames.flatMap(frame => frame.questions || []);
    const count = frames.reduce((sum, frame) => sum + (frame.blockedEvents || 0), 0);
    const pageExits = frames.reduce((sum, frame) => sum + (frame.pageExitEvents || 0), 0);
    const playerExits = frames.reduce((sum, frame) => sum + (frame.playerExitEvents || 0), 0);
    const lines = [];
    if (!reply.settings.enabled) lines.push('辅助已关闭');
    if (!frames.length) lines.push('尚未连接当前页面。安装后请刷新超星课程页。');
    else {
      lines.push(`已连接 ${frames.length} 个页面框架 · 已拦截 ${count} 次移出事件`);
      lines.push(`网页移出 ${pageExits} 次 · 播放器移出 ${playerExits} 次`);
      const top = frames.find(frame => frame.frameId === 0);
      const directory = top?.directory;
      if (directory?.count) {
        lines.push(`目录：识别到 ${directory.count} 节${directory.position ? ` · 当前第 ${directory.position} 节` : ''}`);
        if (directory.currentTitle) lines.push(`当前：${directory.currentTitle}`);
        if (directory.nextTitle) lines.push(`下一节：${directory.nextTitle}`);
      }
      if (directory?.note) lines.push(directory.note);
      if (top) lines.push(`页面：${top.visibility === 'hidden' ? '已隐藏' : '可见'} · 焦点：${top.focused == null ? '未知' : top.focused ? '在页面内' : '不在页面内'}`);
      const lastExit = frames.map(frame => frame.lastExit).filter(Boolean).sort((a, b) => b.at - a.at)[0];
      if (lastExit) lines.push(`最近拦截：${lastExit.scope === 'page' ? '网页边界' : '播放器边界'} ${lastExit.type} · ${new Date(lastExit.at).toLocaleTimeString()}`);
      videos.forEach((video, index) => lines.push(`视频 ${index + 1}：${video.ended ? '已结束' : video.paused ? '暂停' : '播放中'} ${time(video.time)} / ${time(video.duration)}${video.muted ? ' · 静音' : ''}\n起播尝试 ${video.attempts || 0} 次 · 加载状态 ${video.readyState ?? '?'}${video.error ? ' · ' + video.error : ''}${video.note ? '\n' + video.note : ''}`));
      if (!videos.length) lines.push('当前未识别到可见的 HTML5 视频');
      if (questions.length) lines.push(`检测到 ${questions.length} 个题目容器，已记录待办`);
      if (reply.tab.notice) lines.push(reply.tab.notice);
    }
    status.textContent = lines.join('\n');
    if (JSON.stringify(records) !== JSON.stringify(reply.pending)) renderRecords(reply.pending);
  } catch { status.textContent = '扩展连接失败，请刷新课程页后重试。'; }
}
for (const key of keys) document.getElementById(key).addEventListener('change', async event => {
  saving = true;
  try { await send({ type: 'SETTINGS', values: { [key]: event.target.checked } }); }
  finally { saving = false; await refresh(); }
});
document.getElementById('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = '超星待答记录.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tabs[0]?.id;
  renderRecords([]);
  await refresh();
  setInterval(refresh, 2000);
})();
