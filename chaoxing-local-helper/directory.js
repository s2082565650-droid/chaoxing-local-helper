(function (root) {
  'use strict';
  const R = root.CXLocalRules;
  const ID_ATTRIBUTES = ['data-chapterid', 'data-chapter-id', 'data-knowledgeid', 'data-knowledge-id', 'chapterid', 'knowledgeid', 'data-nodeid', 'data-id'];
  const CURRENT = /(?:^|\s)(?:active|current|currents|selected|on|cur|posCatalog_active|posCatalog_current)(?:\s|$)/i;
  const ROWS = 'a, button, [role="treeitem"], [onclick], li, div, span, p, h3, h4, h5';
  const numbered = value => {
    const text = R.clean(value);
    const match = text.match(/^(\d+(?:[.．]\d+)+)\s*(\D.+)$/);
    return match && text.length < 260 ? { number: match[1].replace(/．/g, '.'), title: text } : null;
  };
  function visible(element) {
    return Boolean(element?.isConnected && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
  }
  function chapterFromUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== 'https:' || !/(^|\.)chaoxing\.com$/i.test(url.hostname)) return '';
      for (const name of ['chapterId', 'chapterid', 'knowledgeId', 'knowledgeid']) {
        const id = url.searchParams.get(name);
        if (/^\d+$/.test(id || '')) return id;
      }
    } catch {}
    return '';
  }
  function ownId(element, base) {
    for (const name of ID_ATTRIBUTES) {
      const id = element.getAttribute(name);
      if (/^\d+$/.test(id || '')) return id;
    }
    const match = (element.id || '').match(/^(?:(?:cur|node|chapter|knowledge|catalog|point|cell)[_-]?)?(\d+)$/i);
    const inlineId = (element.getAttribute('onclick') || '').match(/(?:chapterId|knowledgeId)\s*[=:]\s*['"]?(\d+)/i);
    return match?.[1] || chapterFromUrl(element.getAttribute('href'), base) || inlineId?.[1] || '';
  }
  function rowNodes(element, scope) {
    const result = [element];
    let parent = element.parentElement;
    for (let depth = 0; parent && parent !== scope && depth < 3; depth++, parent = parent.parentElement) {
      const differentRows = [...parent.querySelectorAll(ROWS)].some(child => {
        const label = numbered(child.innerText || child.textContent);
        return label && label.number !== numbered(element.innerText || element.textContent)?.number;
      });
      if (differentRows) break;
      result.push(parent);
    }
    return result;
  }
  function isCurrent(element) {
    const current = element.getAttribute('aria-current');
    return (current && current !== 'false') || element.getAttribute('aria-selected') === 'true'
      || CURRENT.test(element.getAttribute('class') || '');
  }
  function isLocked(element) {
    return element.disabled || element.getAttribute('disabled') != null || element.getAttribute('aria-disabled') === 'true'
      || /(?:^|[\s_-])(?:lock|locked|disable|disabled)(?:$|[\s_-])/i.test(element.getAttribute('class') || '')
      || /未解锁|不可访问|暂未开放|尚未开放|无权访问/.test(element.getAttribute('title') || '');
  }
  function safeTarget(element, base) {
    const href = element.getAttribute('href');
    if (!href || /^javascript:/i.test(href)) return true;
    try {
      const url = new URL(href, base);
      return url.protocol === 'https:' && /(^|\.)chaoxing\.com$/i.test(url.hostname);
    } catch { return false; }
  }
  function rowsIn(scope, base) {
    const candidates = [...scope.querySelectorAll(ROWS)].filter(element => !element.closest('form, .TiMu, .ans-test, .video-js'))
      .map(element => ({ element, label: numbered(element.innerText || element.textContent) })).filter(item => item.label);
    // A group containing several numbered lessons is a container, not a lesson.
    const singleRows = candidates.filter(item => !candidates.some(other => other !== item
      && item.element.contains(other.element) && item.label.number !== other.label.number));
    // Number/title labels and their enclosing clickable row describe the same lesson.
    const leaves = singleRows.filter(item => !singleRows.some(other => other !== item
      && item.element.contains(other.element) && item.label.number === other.label.number));
    const rows = leaves.map(({ element, label }) => {
      const nodes = rowNodes(element, scope);
      const id = nodes.map(node => ownId(node, base)).find(Boolean) || '';
      const target = nodes.find(node => node.matches('a, button, [onclick], [role="treeitem"]')) || element;
      const descendantLock = nodes.some(node => node.querySelector('[aria-disabled="true"], .lock, .locked, .icon-lock'));
      return { element: target, id, key: id ? `id:${id}` : `order:${label.number}`, number: label.number,
        title: label.title, active: nodes.some(isCurrent),
        selectionHint: nodes.some(node => /(?:^|\s)posCatalog_select(?:\s|$)/.test(node.getAttribute('class') || '')),
        locked: nodes.some(isLocked) || descendantLock || !safeTarget(target, base) };
    });
    // Two non-nested entries with the same section number make this container ambiguous.
    if (new Set(rows.map(row => row.number)).size !== rows.length) return [];
    return rows;
  }
  function currentIndex(rows, document, base) {
    const frameIds = new Set([...document.querySelectorAll('iframe[src]')].filter(visible)
      .map(frame => {
        try { const live = chapterFromUrl(frame.contentWindow.location.href, base); if (live) return live; } catch {}
        return chapterFromUrl(frame.getAttribute('src'), base);
      }).filter(Boolean));
    const loaded = rows.map((row, index) => row.id && frameIds.has(row.id) ? index : -1).filter(index => index >= 0);
    if (loaded.length === 1) return loaded[0];
    if (loaded.length > 1) return -1;
    const active = rows.map((row, index) => row.active ? index : -1).filter(index => index >= 0);
    if (active.length === 1) return active[0];
    if (active.length > 1) return -1;
    const hinted = rows.map((row, index) => row.selectionHint ? index : -1).filter(index => index >= 0);
    if (hinted.length === 1) return hinted[0];
    const id = chapterFromUrl(base, base);
    const matching = rows.map((row, index) => id && row.id === id ? index : -1).filter(index => index >= 0);
    return matching.length === 1 ? matching[0] : -1;
  }
  function scan(document, base) {
    const roots = new Set([...document.querySelectorAll(
      '[role="tree"], aside, nav, [id*="catalog" i], [class*="catalog" i], [id*="chapter" i], [class*="chapter" i]'
    )].filter(visible));
    for (const heading of document.querySelectorAll('a, button, span, div, h2, h3, h4')) {
      if (!/^(目录|课程目录|章节目录)$/.test(R.clean(heading.innerText || heading.textContent)) || !visible(heading)) continue;
      let parent = heading.parentElement;
      for (let depth = 0; parent && !parent.matches('body, html') && depth < 6; depth++, parent = parent.parentElement) roots.add(parent);
    }
    const scans = [];
    for (const scope of roots) {
      const rows = rowsIn(scope, base);
      if (!rows.length) continue;
      const index = currentIndex(rows, document, base);
      const catalogName = /catalog/i.test(`${scope.id || ''} ${scope.getAttribute('class') || ''}`);
      const score = (index >= 0 ? 10000 : 0) + (catalogName ? 5 : 0)
        + Math.min(rows.length, 500) * 10 - (scope.querySelector('video, iframe, form') ? 6000 : 0);
      scans.push({ rows, index, score });
    }
    scans.sort((a, b) => b.score - a.score);
    const best = scans[0];
    if (!best) return { next: null, info: { count: 0, note: '未识别到已加载的编号目录' } };
    const { rows, index } = best;
    if (index < 0) return { next: null, info: { count: rows.length, note: '已找到目录，尚不能确定当前章节' } };
    // Equal-scoring but inconsistent directories must not produce an arbitrary click.
    const ties = scans.filter(item => item.score === best.score && item.index >= 0);
    if (ties.some(item => item.rows[item.index].key !== rows[index].key
      || (item.rows[item.index + 1]?.key || '') !== (rows[index + 1]?.key || ''))) {
      return { next: null, info: { count: rows.length, note: '存在冲突的目录，请手动切换章节' } };
    }
    const current = rows[index], next = rows[index + 1];
    const info = { count: rows.length, position: index + 1, currentKey: current.key, currentId: current.id,
      currentTitle: current.title, nextKey: next?.key || '', nextTitle: next?.title || '',
      note: !next ? '已到目录最后一节' : next.locked ? '下一节尚未解锁，已停止' : '按目录顺序继续' };
    return { next: next && !next.locked ? next.element : null, info };
  }
  function videoTab(document) {
    const matches = [...document.querySelectorAll('a, button, [role="tab"], li, [onclick], span')]
      .filter(element => visible(element) && /^(?:\d+\s*)?视频$/.test(R.clean(element.innerText || element.textContent)));
    const leafMatches = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));
    const targets = [];
    for (const element of leafMatches) {
      const target = element.closest('a, button, [role="tab"], li, [onclick]') || element;
      let group = target.parentElement;
      for (let depth = 0; group && depth < 3; depth++, group = group.parentElement) {
        const text = R.clean(group.innerText || group.textContent);
        if (text.length > 500) break;
        if (/学习目标|章节测验|章节测试/.test(text)) {
          if (!isCurrent(target) && !isCurrent(element) && !isLocked(target)) targets.push(target);
          break;
        }
      }
    }
    return new Set(targets).size === 1 ? targets[0] : null;
  }
  root.CXLocalDirectory = { scan, videoTab };
})(globalThis);
