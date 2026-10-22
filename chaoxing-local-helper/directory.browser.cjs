'use strict';
// Headless browser tests use a fresh synthetic page. All network requests are intercepted.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.CX_TEST_PLAYWRIGHT || 'playwright');
const base = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=9&courseId=42';
let browser;
const browserReady = chromium.launch({ headless: true, executablePath: process.env.CX_TEST_BROWSER });
after(async () => { await (await browserReady).close(); });
const row = (id, number, title, attrs = '') => `<li id="cur${id}" ${attrs}><a href="/mycourse/studentstudy?chapterId=${id}&courseId=42" onclick="event.preventDefault();document.body.dataset.clicked='${id}'"><span class="label">${number} ${title}</span><span class="badge">2</span></a></li>`;
const fixture = (items, extra = '') => `<!doctype html><html><body><main>${extra}</main><aside><span>目录</span><div id="chapterList"><section class="catalog_group"><h3>1 音乐何需懂</h3><ul>${items.slice(0, 2).join('')}</ul></section><section class="catalog_group"><h3>2 音乐表现的机制</h3><ul>${items.slice(2).join('')}</ul></section></div></aside></body></html>`;
const normal = () => [row(9, '1.1', '音乐鉴赏的误区', 'class="current"'), row(10, '1.2', '音乐的艺术本质'), row(11, '2.1', '声音的联觉属性')];
async function open(html, content = false) {
  browser = await browserReady;
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url() === base
    ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
  await page.goto(base);
  await page.addScriptTag({ path: path.join(__dirname, 'rules.js') });
  await page.addScriptTag({ path: path.join(__dirname, 'directory.js') });
  await page.addScriptTag({ path: path.join(__dirname, 'playback.js') });
  if (content) {
    await page.evaluate(() => {
      window.__reports = [];
      window.__reply = { settings: CXLocalRules.defaults, inCourse: true, playingUntil: 0 };
      window.chrome ||= {};
      Object.assign(window.chrome, { runtime: { id: 'test', onMessage: { addListener(fn) { window.__listener = fn; } },
        async sendMessage(message) { window.__reports.push(message.report); return window.__reply; } },
        storage: { local: { async get() { return { settings: CXLocalRules.defaults }; } }, onChanged: { addListener() {} } } });
    });
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    await page.waitForFunction(() => window.__reports.length > 0);
  }
  return page;
}
const info = page => page.evaluate(base => CXLocalDirectory.scan(document, base).info, base);

test('directory: numbered screenshot layout is flattened across chapter groups', async () => {
  const page = await open(fixture(normal()));
  const start = performance.now();
  const result = await info(page);
  assert.equal(result.count, 3);
  assert.equal(result.currentKey, 'id:9');
  assert.equal(result.nextKey, 'id:10');
  assert.equal(result.nextTitle, '1.2 音乐的艺术本质');
  await page.evaluate(() => { document.querySelector('#cur9').className = ''; document.querySelector('#cur10').className = 'current'; });
  const second = await info(page);
  assert.equal(second.currentKey, 'id:10');
  assert.equal(second.nextKey, 'id:11');
  assert.equal(second.count, 3);
  assert.ok(performance.now() - start < 3000, 'small directory scan should finish promptly');
  await page.close();
});
test('directory: loaded iframe identity takes priority over a stale URL or selection marker', async () => {
  const page = await open(fixture(normal(), '<iframe src="https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=10"></iframe>'));
  assert.equal((await info(page)).currentKey, 'id:10');
  assert.equal((await info(page)).nextKey, 'id:11');
  await page.close();
});
test('directory: locked next entry stops without jumping over it', async () => {
  const items = normal(); items[1] = row(10, '1.2', '音乐的艺术本质', 'aria-disabled="true"');
  const page = await open(fixture(items));
  const result = await page.evaluate(base => { const found = CXLocalDirectory.scan(document, base); return { info: found.info, hasNext: Boolean(found.next) }; }, base);
  assert.equal(result.hasNext, false); assert.equal(result.info.nextKey, 'id:10'); assert.match(result.info.note, /未解锁/);
  await page.close();
});
test('directory: a lesson row cannot navigate to an unrelated external domain', async () => {
  const items = normal(); items[1] = items[1].replace('/mycourse/studentstudy?chapterId=10&courseId=42', 'https://example.invalid/?chapterId=10');
  const page = await open(fixture(items));
  assert.equal(await page.evaluate(base => Boolean(CXLocalDirectory.scan(document, base).next), base), false);
  await page.close();
});
test('directory: last entry does not wrap to the first', async () => {
  const page = await open(fixture(normal()));
  await page.evaluate(() => { document.querySelector('#cur9').className = ''; document.querySelector('#cur11').className = 'current'; });
  const result = await info(page); assert.equal(result.currentKey, 'id:11'); assert.equal(result.nextKey, ''); assert.match(result.note, /最后/);
  await page.close();
});
test('directory: a numbered outline without current identity is not clicked', async () => {
  const page = await open('<aside><span>目录</span><div class="catalog"><div>1.1 示例甲</div><div>1.2 示例乙</div></div></aside>');
  const result = await info(page); assert.equal(result.count, 2); assert.equal(result.currentKey, undefined); assert.match(result.note, /不能确定/);
  await page.close();
});
test('directory: selected numbered labels work without IDs; DOM order is preserved', async () => {
  const page = await open('<aside><span>目录</span><div class="catalog"><div class="selected">1.2 示例甲</div><div>1.10 示例乙</div><div>2.1 示例丙</div></div></aside>');
  const result = await info(page); assert.equal(result.currentKey, 'order:1.2'); assert.equal(result.nextKey, 'order:1.10');
  await page.close();
});
test('directory: unique selection hint supports Ajax chapters with a stale address bar', async () => {
  const page = await open('<aside class="catalog"><span>目录</span><div data-id="9">1.1 示例甲</div><div data-id="10" class="posCatalog_select">1.2 示例乙</div><div data-id="11">2.1 示例丙</div></aside>');
  const result = await info(page); assert.equal(result.currentKey, 'id:10'); assert.equal(result.nextKey, 'id:11');
  await page.close();
});
test('directory: unloaded/ambiguous duplicate numbering produces no target', async () => {
  const page = await open('<aside class="catalog"><span>目录</span><div class="current">1.1 示例甲</div><div>1.2 示例乙</div><div>1.2 重复条目</div></aside>');
  const result = await page.evaluate(base => Boolean(CXLocalDirectory.scan(document, base).next), base); assert.equal(result, false);
  await page.close();
});
test('directory: hidden but loaded entries in a collapsed group retain their order', async () => {
  const items = normal(); items[2] = row(11, '2.1', '声音的联觉属性', 'style="display:none"');
  const page = await open(fixture(items));
  await page.evaluate(() => { document.querySelector('#cur9').className = ''; document.querySelector('#cur10').className = 'current'; });
  const result = await info(page); assert.equal(result.count, 3); assert.equal(result.nextKey, 'id:11');
  await page.close();
});
test('directory integration: NEXT targets the next lesson once and refuses stale target identities', async () => {
  const page = await open(fixture(normal()), true);
  const report = await page.evaluate(() => window.__reports.at(-1));
  assert.equal(report.nextAvailable, true); assert.equal(report.nextTargetKey, 'id:10');
  const invoke = args => page.evaluate(args => new Promise(resolve => window.__listener(args, {}, resolve)), args);
  assert.equal((await invoke({ type: 'NEXT', pageKey: report.pageKey, targetKey: 'id:11' })).clicked, false);
  assert.equal((await invoke({ type: 'NEXT', pageKey: report.pageKey, targetKey: 'id:10' })).clicked, true);
  assert.equal(await page.evaluate(() => document.body.dataset.clicked), '10');
  assert.equal((await invoke({ type: 'NEXT', pageKey: report.pageKey, targetKey: 'id:10' })).clicked, false);
  await page.close();
});
test('task tabs: selects Video only from the learning task tab group', async () => {
  const page = await open('<div role="tablist"><button class="current" role="tab">1 学习目标</button><button role="tab" id="video">2 视频</button><button role="tab">3 章节测验</button></div>');
  assert.equal(await page.evaluate(() => CXLocalDirectory.videoTab(document)?.id), 'video');
  await page.evaluate(() => document.querySelector('#video').setAttribute('aria-selected', 'true'));
  assert.equal(await page.evaluate(() => CXLocalDirectory.videoTab(document)), null);
  await page.close();
});
test('task integration: confirmed handoff opens Video once and never submits the chapter test', async () => {
  const page = await open('<div role="tablist"><button class="current" role="tab">1 学习目标</button><button role="tab" id="video" onclick="document.body.dataset.videoClicks=String(Number(document.body.dataset.videoClicks||0)+1)">2 视频</button><button role="tab" id="test" onclick="document.body.dataset.testClicked=1">3 章节测验</button></div>', true);
  assert.equal(await page.evaluate(() => document.body.dataset.videoClicks), undefined);
  await page.evaluate(() => Object.assign(window.__reply, { autoVideoUntil: Date.now() + 25000, autoVideoToken: 'handoff-1' }));
  await page.waitForFunction(() => document.body.dataset.videoClicks === '1');
  const reportCount = await page.evaluate(() => window.__reports.length);
  await page.waitForFunction(count => window.__reports.length > count, reportCount);
  assert.equal(await page.evaluate(() => document.body.dataset.videoClicks), '1');
  assert.equal(await page.evaluate(() => document.body.dataset.testClicked), undefined);
  await page.close();
});
