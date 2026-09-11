/**
 * review.js —— 生词本独立标签页逻辑
 *
 * 左侧导航四个页面：
 * 1. 生词本：浏览/搜索/删除，卡片默认折叠，展开后显示翻译与例句，均可发音。
 * 2. 背单词：按“不认识次数”加权随机抽词，自动发音，例句先于答案展示，可发音。
 * 3. 已背：按日期分组展示，可多选忘记词；已背单词按艾宾浩斯曲线自动回待背。
 * 4. 设置：有道翻译密钥配置 + 词典状态与加载。
 */
(() => {
  'use strict';

  // 生词本数据缓存：{ 原型(小写): { word, translation, phonetic, explains, sentences, ... } }
  let wordsMap = {};
  // 句子收藏：{ id, text, translation, addedAt }
  let sentencesList = [];
  // 背单词当前展示的单词
  let currentWord = null;
  // 背单词上一个展示的单词（用于避免连续重复）
  let lastReviewWord = null;
  // 已背页面选中的单词（用于多选忘记词）
  const selectedMemorized = new Set();
  // 生词本页面选中的单词（用于批量删除）
  const selectedWords = new Set();
  // 句子收藏页面选中的句子（用于批量删除）
  const selectedSentences = new Set();
  // 各列表当前可见条目（用于“全选”判断）
  let visibleWords = [];
  let visibleSentences = [];
  let visibleMemorized = [];

  // 删除/批量操作的选择模式：先点“删除”进入选择，再显示复选框与全选按钮。
  let wordDeleteMode = false;
  let sentenceDeleteMode = false;
  let memorizedMode = 'none'; // 'none' | 'delete' | 'readd'

  // 网格视图状态：生词本/已背可切换，且可调整每行数量。
  let wordGridView = false;
  let memorizedGridView = false;
  let wordGridCols = 4;
  let memorizedGridCols = 4;
  // 网格视图最多同时翻转的卡片数（可自定义，存于 appearance.maxFlipCards）。
  let maxFlipCards = 3;
  // 当前网格设置弹窗针对哪个面板：'word'（生词本）或 'memorized'（已背）。
  let gridSettingsTarget = 'word';
  // 已背列表排序：字段（date / unknown）+ 方向（desc / asc），分别由下拉框与图标按钮控制。
  let memorizedSortKey = 'date';
  let memorizedSortDir = 'desc';

  // 预设词表数据（IndexedDB）与复习进度（chrome.storage.local）。
  // 词书：'own' = 用户自行添加的生词本；预设词表 id（如 cet4）= 某本预设词书；'all' = 全部显示。
  let presetWords = [];          // [{ word, t, p, sources:[presetId], senses, definitions, examples }]
  let presetState = {};          // { '<presetId>\u0000<word>': { status, unknownCount, ... } }
  let presetFilters = {};        // { '<presetId>': { removeCommon, removeMemorized, enrichLocal, supplementExamples } }
  let importedPresetIds = new Set();
  let currentBook = 'own';
  // 词书生成页创建的自定义词书元信息：{ genId: { id, name, count, createdAt } }，存于 chrome.storage.local.generatedBooks。
  let generatedBooks = {};
  // 词书生成页当前解析结果：{ fileName, freqList:[{word,count}] }（已按出现频次降序）。
  let genParsed = null;
  // 完整 ECDICT 词条数（用于判断是否可用词典校验过滤噪声词），由 refreshDictStatus 更新。
  let ecdictCount = 0;

  // 日历高亮所需的补充数据：
  // presetImportDates 记录每本预设词书「最近一次导入」的时间戳（生词本页「添加词书」高亮）；
  // reviewStartDates 记录每次点击「开始背单词」的日期（背单词页高亮）。
  let presetImportDates = {};
  let reviewStartDates = [];
  // 当前所在页面，日历据此切换不同的高亮口径。
  let currentTab = 'list';

  // 各预设词书的网页高亮颜色：{ presetId: '#rrggbb' }，存于 appearance.bookColors。
  let bookColors = {};

  // 网格视图翻转卡片队列：限制同时最多 3 张卡片翻转，翻转第 4 张时自动翻回最早的一张。
  let flippedWordCards = [];
  let flippedMemorizedCards = [];

  // 设置页模块顺序（自定义排序，存于 chrome.storage.local 的 settingsOrder）。
  const DEFAULT_SETTINGS_ORDER = ['provider', 'shortcut', 'appearance', 'dictionary', 'export', 'storage'];
  let settingsOrder = DEFAULT_SETTINGS_ORDER.slice();

  // 分页：限制每页渲染的单词数量，避免载入大词书时一次性创建数千个 DOM 节点导致卡顿。
  const PAGE_SIZE = 100;
  let wordPage = 0;
  let memorizedPage = 0;

  // 艾宾浩斯遗忘曲线复习间隔（毫秒）：5分钟→30分钟→12小时→1天→2天→4天→7天→15天。
  const EBBINGHAUS = [
    5 * 60 * 1000,
    30 * 60 * 1000,
    12 * 60 * 60 * 1000,
    1 * 24 * 60 * 60 * 1000,
    2 * 24 * 60 * 60 * 1000,
    4 * 24 * 60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
    15 * 24 * 60 * 60 * 1000,
  ];

  // 喇叭 SVG，用于背单词卡片主发音按钮。
  const SPEAKER_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M3 9v6h4l5 5V4L7 9H3z"></path>' +
    '<path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>' +
    '<path d="M18.5 6a9 9 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>' +
    '</svg>';

  // 网格视图图标（4 宫格），用于“切换为网格视图”。
  const GRID_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect>' +
    '<rect x="14" y="3" width="7" height="7" rx="1.5"></rect>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.5"></rect>' +
    '<rect x="14" y="14" width="7" height="7" rx="1.5"></rect>' +
    '</svg>';

  // 列表视图图标（三条横线），用于“切换为列表视图”。
  const LIST_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="9" y1="6" x2="20" y2="6"></line>' +
    '<line x1="9" y1="12" x2="20" y2="12"></line>' +
    '<line x1="9" y1="18" x2="20" y2="18"></line>' +
    '<circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"></circle>' +
    '</svg>';

  // 齿轮图标，用于打开各页面的设置菜单（页边距 / 网格视图 / 清空生词本等）。
  const GEAR_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3"></circle>' +
    '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"></path>' +
    '</svg>';

  /* ---------- 工具函数 ---------- */

  function loadWords() {
    return chrome.storage.local.get('words').then(async ({ words }) => {
      wordsMap = words || {};
      await migrateStaleLemmas();
    });
  }

  function saveWords() {
    return chrome.storage.local.set({ words: wordsMap });
  }

  // 以 Promise 方式调用后台消息，返回回调结果（失败返回 null）。
  function bgMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (res) => resolve(res));
    });
  }

  // 仅查本地词典（内置 + ECDICT），用于校验词形还原候选，不触发翻译 API。
  function dictLookup(word) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'dictLookup', text: word }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok || !res.found) {
          resolve(null);
          return;
        }
        resolve(res);
      });
    });
  }

  // 迁移历史错误词形：旧版把 conditioning 这类词误还原为 conditione 存入生词本。
  // 对「以 e 结尾、去掉 e 后是词典有效词、而本身不是有效词」的 key，合并迁移到正确原型。
  // 仅在有词典证据时才迁移，避免误改本身就以 e 结尾的合法单词（love/make/rate 等）。
  async function migrateStaleLemmas() {
    const keys = Object.keys(wordsMap).filter(
      (k) => k.length > 3 && k.endsWith('e') && /^[a-z]+$/.test(k)
    );
    let changed = false;
    for (const key of keys) {
      const stem = key.slice(0, -1);
      const keyHit = await dictLookup(key);
      const stemHit = await dictLookup(stem);
      // key 不是有效词、但去掉末尾 e 的 stem 是有效词 → 说明 e 是错误还原多出来的。
      if (!keyHit && stemHit) {
        const old = wordsMap[key];
        const existing = wordsMap[stem];
        wordsMap[stem] = Object.assign({}, old, existing || {}, { word: stem });
        delete wordsMap[key];
        changed = true;
      }
    }
    if (changed) await saveWords();
  }

  function loadSentences() {
    return chrome.storage.local.get('sentences').then(({ sentences }) => {
      sentencesList = sentences || [];
    });
  }

  /* ---------- 词书（生词本 / 预设词表） ---------- */

  function loadPresetState() {
    return chrome.storage.local.get('presetState').then(({ presetState: ps }) => {
      presetState = ps || {};
    });
  }

  function loadPresetFilters() {
    return chrome.storage.local.get('presetFilters').then(({ presetFilters: pf }) => {
      presetFilters = pf || {};
    });
  }

  // 读取「词书生成」页已生成的自定义词书元信息。
  function loadGeneratedBooks() {
    return chrome.storage.local.get('generatedBooks').then(({ generatedBooks: gb }) => {
      generatedBooks = gb || {};
    });
  }

  // 读取日历补充数据：预设词书导入时间与「开始背单词」日期。
  function loadActivityDates() {
    return chrome.storage.local.get(['presetImportDates', 'reviewStartDates']).then((r) => {
      presetImportDates = r.presetImportDates || {};
      reviewStartDates = Array.isArray(r.reviewStartDates) ? r.reviewStartDates : [];
    });
  }

  // 记录一次「开始背单词」的日期（去重），供背单词页日历高亮。
  function recordReviewStartDate() {
    const key = formatDate(Date.now());
    if (reviewStartDates.indexOf(key) === -1) {
      reviewStartDates.push(key);
      chrome.storage.local.set({ reviewStartDates });
    }
  }

  function savePresetState() {
    return chrome.storage.local.set({ presetState });
  }

  // 从 IndexedDB 重新读取全部预设词条，并重建「已导入词表 id」集合。
  function refreshPresetWords() {
    return idbGetAll(STORE_PRESET).then((rows) => {
      presetWords = rows || [];
      importedPresetIds = new Set();
      for (const e of presetWords) {
        if (e.sources) for (const s of e.sources) importedPresetIds.add(s);
      }
      ensureCurrentBookValid();
    });
  }

  // 词书生成页创建的自定义词书列表（按创建时间正序）。
  function generatedBookList() {
    return Object.values(generatedBooks || {}).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  // 所有词书来源 = 内置预设词书（PRESET_SOURCES）+ 用户生成的自定义词书。
  function allBookSources() {
    return PRESET_SOURCES.concat(generatedBookList());
  }

  function presetNameOf(id) {
    const src = PRESET_SOURCES.find((s) => s.id === id);
    if (src) return src.name;
    const g = generatedBooks[id];
    return g ? (g.name || id) : id;
  }

  // 词书名超长时截断为 6 个字符（超出用 … 代替），用于下拉等选择控件，避免排版错乱。
  function shortBookName(name) {
    const s = String(name || '');
    return s.length > 6 ? s.slice(0, 6) + '…' : s;
  }

  function ensureCurrentBookValid() {
    if (currentBook !== 'own' && currentBook !== 'all' && !importedPresetIds.has(currentBook)) {
      currentBook = 'own';
    }
  }

  function availableBooks() {
    const books = [{ id: 'own', name: '生词本' }];
    for (const s of allBookSources()) {
      if (importedPresetIds.has(s.id)) books.push({ id: s.id, name: s.name });
    }
    books.push({ id: 'all', name: '全部' });
    return books;
  }

  // 把一条预设词条包装为与「生词本单词」一致的条目结构，并合并该词书的复习进度。
  function presetEntryToWord(e, bookId) {
    const st = presetState[bookId + '\u0000' + e.word] || {};
    const senses = (e.senses && e.senses.length) ? e.senses : [];
    const definitions = e.definitions || [];
    const sentences = (e.examples || []).slice();
    const translation = senses.length ? senses[0].text : (e.t || '');
    return {
      word: e.word,
      translation,
      phonetic: e.p || '',
      explains: [],
      senses,
      definitions,
      sentences,
      addedAt: st.memorizedAt || st.lastReviewedAt || 0,
      unknownCount: st.unknownCount || 0,
      knownCount: st.knownCount || 0,
      status: st.status || 'pending',
      memorizedAt: st.memorizedAt || null,
      reviewStage: st.reviewStage || 0,
      nextReviewAt: st.nextReviewAt || null,
      lastReviewedAt: st.lastReviewedAt || null,
      sourceTitle: presetNameOf(bookId),
      book: bookId,
    };
  }

  // 获取某本词书的全部条目。own 返回 wordsMap 原对象引用（可直接改并 saveWords 持久化）。
  // 预设词书应用「剔除高频词和常见词 / 剔除已背单词」过滤；includeMemorized 为 true 时忽略「剔除已背单词」，
  // 用于已背页面展示已背的预设词（这些词不应被该过滤隐藏）。
  function getBookEntries(bookId, opts) {
    const includeMemorized = !!(opts && opts.includeMemorized);
    if (bookId === 'own') {
      return Object.values(wordsMap);
    }
    if (bookId === 'all') {
      const seen = new Set();
      const list = [];
      for (const w of Object.values(wordsMap)) {
        list.push(w);
        seen.add(w.word);
      }
      for (const e of presetWords) {
        const visible = visiblePresetSources(e.word, e.sources, presetFilters, presetState, includeMemorized);
        if (!visible.length) continue;
        if (seen.has(e.word)) continue;
        seen.add(e.word);
        list.push(presetEntryToWord(e, visible[0]));
      }
      return list;
    }
    return presetWords
      .filter((e) => visiblePresetSources(e.word, e.sources, presetFilters, presetState, includeMemorized).includes(bookId))
      .map((e) => presetEntryToWord(e, bookId));
  }

  function getCurrentBookEntries(includeMemorized) {
    return getBookEntries(currentBook, { includeMemorized });
  }

  // 持久化当前单词的复习进度：预设词写入 presetState，生词本单词写入 wordsMap。
  function persistCurrentWord(entry) {
    if (entry.book && entry.book !== 'own') {
      presetState[entry.book + '\u0000' + entry.word] = {
        status: entry.status,
        unknownCount: entry.unknownCount,
        knownCount: entry.knownCount,
        reviewStage: entry.reviewStage,
        memorizedAt: entry.memorizedAt,
        nextReviewAt: entry.nextReviewAt,
        lastReviewedAt: entry.lastReviewedAt,
      };
      return savePresetState();
    }
    return saveWords();
  }

  // 待背单词 = 当前词书内尚未背过 + 已背但已到复习时间的单词。
  function getPendingWords() {
    const now = Date.now();
    return getCurrentBookEntries().filter((w) => {
      if (w.status !== 'memorized') return true;
      return w.nextReviewAt && w.nextReviewAt <= now;
    });
  }

  function formatDate(ts) {
    const d = new Date(ts || Date.now());
    return (
      d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  function formatDateTime(ts) {
    const d = new Date(ts || Date.now());
    const time =
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
    return formatDate(ts) + ' ' + time;
  }

  /* ---------- 自定义词典原始 HTML 的带样式渲染 ---------- */

  // 把资源二进制数据规范为 Uint8Array。
  function resourceBytes(r) {
    const data = r && r.data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(0);
  }

  function bytesToBase64(u8) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function decodeResourceText(r) {
    return new TextDecoder('utf-8').decode(resourceBytes(r));
  }

  function dataUrlForResource(r) {
    return 'data:' + (r.type || 'application/octet-stream') + ';base64,' + bytesToBase64(resourceBytes(r));
  }

  // 把释义 HTML 解析后做安全清洗，并把 .mdd 资源引用内联为 data: URL。
  // 返回可直接写入 sandbox iframe 的完整文档字符串。
  function buildStyledDocument(html, resMap) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');

    // 移除脚本与可嵌入对象，避免任何脚本执行。
    doc.querySelectorAll('script, iframe, object, embed').forEach((el) => el.remove());
    // 移除事件属性与 javascript: URL。
    doc.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const n = attr.name.toLowerCase();
        if (n.startsWith('on') || /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      });
    });

    // 解析资源引用：命中 resMap 则返回 data: URL，否则返回 ''（保留原样交给浏览器处理）。
    function resolveResource(u) {
      const url = String(u || '').trim();
      if (!url) return '';
      if (/^(data:|blob:|https?:|mailto:)/i.test(url)) return url;
      const norm = LV_MDX.normalizeResPath(url.split(/[?#]/)[0]);
      const r = resMap[norm];
      return r ? dataUrlForResource(r) : '';
    }

    function rewriteCssUrls(css) {
      return String(css || '').replace(
        /url\(\s*("([^"]*)"|'([^']*)'|([^)"']+))\s*\)/gi,
        function (m, all, dq, sq, nq) {
          const orig = dq !== undefined ? dq : (sq !== undefined ? sq : nq);
          const repl = resolveResource(orig);
          return repl ? 'url("' + repl + '")' : m;
        }
      );
    }

    // 内联 <link rel="stylesheet">：读 CSS 内容并重写其 url() 后转为 <style>。
    doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const norm = LV_MDX.normalizeResPath((link.getAttribute('href') || '').split(/[?#]/)[0]);
      const r = resMap[norm];
      if (r && /css/i.test(r.type || '')) {
        const style = doc.createElement('style');
        style.textContent = rewriteCssUrls(decodeResourceText(r));
        link.replaceWith(style);
      } else {
        link.remove();
      }
    });

    // 重写 <style> 与 style 属性内的 url()。
    doc.querySelectorAll('style').forEach((st) => {
      st.textContent = rewriteCssUrls(st.textContent);
    });
    doc.querySelectorAll('[style]').forEach((el) => {
      el.setAttribute('style', rewriteCssUrls(el.getAttribute('style')));
    });

    // 重写 src / href 引用。
    doc.querySelectorAll('[src]').forEach((el) => {
      const r = resolveResource(el.getAttribute('src'));
      if (r) el.setAttribute('src', r);
    });
    doc.querySelectorAll('[href]').forEach((el) => {
      const r = resolveResource(el.getAttribute('href'));
      if (r) el.setAttribute('href', r);
    });

    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
      + doc.body.innerHTML + '</body></html>';
  }

  // 在沙箱 iframe 中渲染自定义词典的带样式释义（禁止脚本，隔离 CSS）。
  async function renderStyledDefinition(container, w) {
    const dictId = String(w.sourceId || '').replace(/^custom:/, '');
    const wrap = document.createElement('div');
    wrap.className = 'styled-def';
    container.appendChild(wrap);

    if (!dictId) {
      wrap.textContent = '（该释义缺少词典来源，无法渲染样式）';
      return;
    }

    try {
      const rows = await idbGetAllByIndex(STORE_RES, 'byDict', dictId);
      const resMap = {};
      for (const r of rows) resMap[r.path] = r;

      const html = buildStyledDocument(w.html, resMap);
      const iframe = document.createElement('iframe');
      iframe.className = 'styled-def-frame';
      // allow-same-origin 用于让父页面读取内容高度；不授 allow-scripts，脚本不会执行。
      iframe.sandbox = 'allow-same-origin';
      iframe.setAttribute('loading', 'lazy');
      iframe.setAttribute('title', '释义');
      wrap.appendChild(iframe);
      iframe.srcdoc = html;
      iframe.addEventListener('load', () => {
        try {
          const doc = iframe.contentDocument;
          if (doc && doc.body) {
            iframe.style.height = Math.min(2000, Math.max(120, doc.body.scrollHeight + 16)) + 'px';
          }
        } catch (e) { /* 忽略高度测量失败 */ }
      });
    } catch (err) {
      wrap.textContent = '释义渲染失败：' + (err && err.message ? err.message : err);
    }
  }

  // 向容器追加结构化释义：中文多义（含词性）+ 英文释义；老数据回退到 explains。
  function appendEntryDetail(container, w) {
    // 自定义词典命中的词条带原始 HTML：改用沙箱 iframe 渲染带样式的释义。
    if (w.html && String(w.sourceId || '').indexOf('custom:') === 0) {
      renderStyledDefinition(container, w);
      return;
    }
    const senses =
      w.senses && w.senses.length
        ? w.senses
        : (w.explains || []).map((text) => ({ pos: '', text }));
    if (senses.length) {
      const sensesBox = document.createElement('div');
      sensesBox.className = 'senses';
      for (const s of senses) {
        const line = document.createElement('div');
        line.className = 'sense';
        if (s.pos) {
          const pos = document.createElement('span');
          pos.className = 'sense-pos';
          pos.textContent = s.pos;
          line.appendChild(pos);
        }
        const text = document.createElement('span');
        text.className = 'sense-text';
        text.textContent = s.text;
        line.appendChild(text);
        sensesBox.appendChild(line);
      }
      container.appendChild(sensesBox);
    }
    if (w.definitions && w.definitions.length) {
      const title = document.createElement('div');
      title.className = 'defs-title';
      title.textContent = '英文释义';
      container.appendChild(title);
      const defs = document.createElement('ul');
      defs.className = 'defs';
      for (const d of w.definitions) {
        const li = document.createElement('li');
        li.textContent = d;
        defs.appendChild(li);
      }
      container.appendChild(defs);
    }
  }

  // 在例句中用 <b> 高亮目标单词及其各种变形（如 conditioning 也要高亮到 condition）。
  function highlightWordInSentence(sentence, word) {
    const frag = document.createDocumentFragment();
    const text = String(sentence);
    const forms =
      (typeof LV_LEMMATIZER !== 'undefined' && LV_LEMMATIZER.getInflections)
        ? LV_LEMMATIZER.getInflections(word)
        : [word];
    // 按长度降序，优先匹配较长变形（如 eating 先于 eat）。
    const sorted = forms.slice().sort((a, b) => b.length - a.length);
    const escaped = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp('\\b(' + escaped.join('|') + ')\\b', 'gi');

    const matches = [];
    let m;
    while ((m = pattern.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
    if (!matches.length) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }

    let last = 0;
    for (const mm of matches) {
      frag.appendChild(document.createTextNode(text.slice(last, mm.start)));
      const b = document.createElement('b');
      b.textContent = text.slice(mm.start, mm.end);
      frag.appendChild(b);
      last = mm.end;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  // 构建“例句 + 发音按钮”的一行。
  function buildSentenceRow(sentence, word) {
    const row = document.createElement('div');
    row.className = 'sentence';
    const text = document.createElement('span');
    text.className = 'text';
    text.appendChild(highlightWordInSentence(sentence, word));
    row.appendChild(text);
    row.appendChild(LV_TTS.speakerButton(sentence));
    return row;
  }

  // 按“日期 → 来源网页”两级分组，便于追溯到加入/收藏时的网页。
  function groupByDateAndSource(items, dateField) {
    const dateMap = {};
    for (const it of items) {
      const d = formatDate(it[dateField]);
      const srcKey = it.sourceUrl || it.sourceTitle || '__unknown__';
      if (!dateMap[d]) dateMap[d] = {};
      if (!dateMap[d][srcKey]) {
        dateMap[d][srcKey] = {
          sourceUrl: it.sourceUrl || '',
          sourceTitle: it.sourceTitle || '',
          items: [],
        };
      }
      dateMap[d][srcKey].items.push(it);
    }
    // 日期倒序；同一日期内按来源保持原有顺序。
    return Object.keys(dateMap)
      .sort()
      .reverse()
      .map((d) => ({
        date: d,
        sources: Object.keys(dateMap[d]).map((k) => dateMap[d][k]),
      }));
  }

  // 把两级分组结构展平为有序条目数组（日期倒序 → 来源分组），供网格视图保持与列表一致的排序。
  function flattenGroups(groups) {
    const out = [];
    for (const g of groups) {
      for (const s of g.sources) {
        for (const it of s.items) out.push(it);
      }
    }
    return out;
  }

  // 渲染两级分组（日期组 + 来源组），buildItem 用于构建每个条目。
  // 日期组标题可点击折叠；每个日期组带 data-date 供左侧日期导航定位。
  function appendGroupedItems(container, groups, buildItem) {
    for (const g of groups) {
      const dateGroup = document.createElement('div');
      dateGroup.className = 'date-group';
      dateGroup.dataset.date = g.date;

      const dateTitle = document.createElement('button');
      dateTitle.type = 'button';
      dateTitle.className = 'date-group-title';
      const totalCount = g.sources.reduce((s, src) => s + src.items.length, 0);
      const chevron = document.createElement('span');
      chevron.className = 'date-chevron';
      chevron.textContent = '▾';
      dateTitle.appendChild(chevron);
      dateTitle.appendChild(document.createTextNode(g.date + '（' + totalCount + '）'));
      dateTitle.addEventListener('click', () => dateGroup.classList.toggle('collapsed'));
      dateGroup.appendChild(dateTitle);

      const body = document.createElement('div');
      body.className = 'date-group-body';
      for (const src of g.sources) {
        const srcGroup = document.createElement('div');
        srcGroup.className = 'source-group';

        const srcTitle = document.createElement('div');
        srcTitle.className = 'source-group-title';
        const label = src.sourceTitle || src.sourceUrl || '未知来源';
        const suffix = '（' + src.items.length + '）';
        if (src.sourceUrl) {
          const a = document.createElement('a');
          a.href = src.sourceUrl;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = label + suffix;
          srcTitle.appendChild(a);
        } else {
          srcTitle.textContent = label + suffix;
        }
        srcGroup.appendChild(srcTitle);

        for (const it of src.items) {
          srcGroup.appendChild(buildItem(it));
        }
        body.appendChild(srcGroup);
      }
      dateGroup.appendChild(body);
      container.appendChild(dateGroup);
    }
  }

  /* ---------- 标签切换 ---------- */

  const navItems = document.querySelectorAll('.nav-item');
  const panels = {
    list: document.getElementById('tab-list'),
    review: document.getElementById('tab-review'),
    memorized: document.getElementById('tab-memorized'),
    sentences: document.getElementById('tab-sentences'),
    tutorial: document.getElementById('tab-tutorial'),
    generator: document.getElementById('tab-generator'),
    settings: document.getElementById('tab-settings'),
  };

  function switchTab(name) {
    currentTab = name;
    navItems.forEach((n) => n.classList.toggle('active', n.dataset.tab === name));
    Object.keys(panels).forEach((k) => panels[k].classList.toggle('active', k === name));
    if (name === 'list') renderList();
    if (name === 'memorized') renderMemorized();
    if (name === 'sentences') renderSentences();
    if (name === 'generator') renderGeneratedBooks();
    if (name === 'settings') refreshDictStatus();
    // 日历高亮口径随页面变化，切换页面时同步刷新。
    renderCalendar();
  }

  navItems.forEach((item) => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });

  /* ---------- 词书切换 ---------- */

  const bookSelectEl = document.getElementById('book-select');
  const reviewBookSelectEl = document.getElementById('review-book-select');
  const memorizedBookSelectEl = document.getElementById('memorized-book-select');
  const bookSelects = [bookSelectEl, reviewBookSelectEl, memorizedBookSelectEl];

  // 重建三个词书下拉框的选项并同步当前选中值。
  function renderBookSelects() {
    const books = availableBooks();
    for (const sel of bookSelects) {
      sel.innerHTML = '';
      for (const b of books) {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = shortBookName(b.name);
        opt.title = b.name;
        sel.appendChild(opt);
      }
      sel.value = currentBook;
    }
    updateBookControls();
    updateReviewScopeUI();
  }

  function switchBook(bookId) {
    currentBook = bookId;
    ensureCurrentBookValid();
    wordPage = 0;
    memorizedPage = 0;
    // 非「生词本」词书时退出选择模式，避免把预设词误当作自有词删除/移动。
    if (currentBook !== 'own') {
      if (wordDeleteMode) setWordDeleteMode(false);
      if (memorizedMode !== 'none') setMemorizedMode('none');
    }
    renderBookSelects();
    renderAll();
  }

  bookSelects.forEach((sel) => {
    sel.addEventListener('change', () => switchBook(sel.value));
  });

  // 非「生词本」词书时，禁用删除/清空/移动等针对用户自有单词的操作，避免误操作预设词表。
  function updateBookControls() {
    const isOwn = currentBook === 'own';
    const ids = ['word-delete-toggle', 're-add-toggle', 'memorized-delete-toggle'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.disabled = !isOwn;
      el.title = isOwn ? '' : '预设词表请在「设置 - 词典」中移除';
    }
  }

  /* ---------- 统计 ---------- */

  const statsEl = document.getElementById('stats');
  const calendarEl = document.getElementById('calendar');

  // 背诵日历状态：默认显示当月，点击标题切换为全年视图。
  let calView = 'month'; // 'month' | 'year'
  let calMonth = new Date().getMonth();
  let calYear = new Date().getFullYear();

  function renderStats() {
    // 侧栏统计始终展示“全部词书”的汇总（生词本 + 所有已导入预设词书），
    // 避免仅显示当前所选词书而漏掉预设词书的词数。includeMemorized 确保已背的预设词也计入总数。
    const all = getBookEntries('all', { includeMemorized: true });
    const now = Date.now();
    const pending = all.filter((w) => {
      if (w.status !== 'memorized') return true;
      return w.nextReviewAt && w.nextReviewAt <= now;
    });
    const memorized = all.filter((w) => w.status === 'memorized');
    statsEl.innerHTML =
      '总生词：' + all.length + '<br>' +
      '待背：' + pending.length + '<br>' +
      '已背：' + memorized.length;
  }

  /* ---------- 背诵日历（月历 ↔ 全年） ---------- */

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dateKey(y, m, d) {
    return y + '-' + pad2(m + 1) + '-' + pad2(d);
  }

  // 按当前页面口径收集需要高亮的日期：
  //   - 生词本：那天有新词加入（双击添加 + 导入预设词书）
  //   - 背单词：那天点过「开始背单词」
  //   - 句子收藏：那天收藏过句子
  //   - 已背：当天新增「认识」的单词
  //   - 其他页面（教程/设置等）：上述任一操作均高亮
  function collectActiveDates() {
    const dates = new Set();
    const own = Object.values(wordsMap);

    const addWordDates = () => {
      for (const w of own) if (w.addedAt) dates.add(formatDate(w.addedAt));
      for (const pid in presetImportDates) {
        if (presetImportDates[pid]) dates.add(formatDate(presetImportDates[pid]));
      }
    };
    const addMemorizedDates = () => {
      for (const w of own) if (w.memorizedAt) dates.add(formatDate(w.memorizedAt));
      for (const key in presetState) {
        const st = presetState[key];
        if (st && st.memorizedAt) dates.add(formatDate(st.memorizedAt));
      }
    };
    const addSentenceDates = () => {
      for (const s of sentencesList) if (s.addedAt) dates.add(formatDate(s.addedAt));
    };
    const addReviewDates = () => {
      for (const d of reviewStartDates) dates.add(d);
    };

    switch (currentTab) {
      case 'list':
        addWordDates();
        break;
      case 'review':
        addReviewDates();
        break;
      case 'sentences':
        addSentenceDates();
        break;
      case 'memorized':
        addMemorizedDates();
        break;
      default:
        addWordDates();
        addMemorizedDates();
        addSentenceDates();
        addReviewDates();
    }
    return dates;
  }

  // 生成一周标题行（周日为首）。
  function buildCalendarWeekdays() {
    const row = document.createElement('div');
    row.className = 'cal-grid cal-weekdays';
    for (const w of ['日', '一', '二', '三', '四', '五', '六']) {
      const c = document.createElement('span');
      c.className = 'cal-wd';
      c.textContent = w;
      row.appendChild(c);
    }
    return row;
  }

  // 生成某个月份的日期格子（带前导空位；背诵日标记为主题色，今天加描边）。
  function buildCalendarMonthDays(y, m, reviewDates, mini) {
    const days = document.createElement('div');
    days.className = 'cal-grid';
    const firstDay = new Date(y, m, 1).getDay();
    const dim = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < firstDay; i++) {
      const c = document.createElement('span');
      c.className = 'cal-cell cal-empty';
      days.appendChild(c);
    }
    const today = new Date();
    for (let d = 1; d <= dim; d++) {
      const cell = document.createElement('span');
      cell.className = 'cal-cell';
      cell.textContent = d;
      const dk = dateKey(y, m, d);
      if (reviewDates.has(dk)) {
        cell.classList.add('active');
        // 高亮日期可点击：快速滑到生词本 / 已背 / 句子收藏中对应日期的分组。
        cell.addEventListener('click', () => jumpToDate(dk));
      }
      if (!mini && today.getFullYear() === y && today.getMonth() === m && today.getDate() === d) {
        cell.classList.add('today');
      }
      days.appendChild(cell);
    }
    return days;
  }

  // 构建某个月份导航（上一月 / 标题 / 下一月）。
  function buildCalNav(prevTitle, onPrev, titleText, titleHint, onTitle, nextTitle, onNext) {
    const head = document.createElement('div');
    head.className = 'cal-head';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'cal-nav';
    prev.textContent = '‹';
    prev.title = prevTitle;
    prev.addEventListener('click', (e) => { e.stopPropagation(); onPrev(); });

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'cal-title';
    title.textContent = titleText;
    title.title = titleHint;
    title.addEventListener('click', onTitle);

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'cal-nav';
    next.textContent = '›';
    next.title = nextTitle;
    next.addEventListener('click', (e) => { e.stopPropagation(); onNext(); });

    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);
    return head;
  }

  function buildMonthView(y, m, reviewDates) {
    const wrap = document.createElement('div');
    wrap.className = 'cal-month';
    wrap.appendChild(buildCalNav(
      '上个月',
      () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); },
      y + '年' + (m + 1) + '月',
      '点击查看全年日历',
      () => { calView = 'year'; renderCalendar(); },
      '下个月',
      () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); }
    ));
    wrap.appendChild(buildCalendarWeekdays());
    wrap.appendChild(buildCalendarMonthDays(y, m, reviewDates, false));
    return wrap;
  }

  function buildYearView(y, reviewDates) {
    const wrap = document.createElement('div');
    wrap.className = 'cal-year';
    wrap.appendChild(buildCalNav(
      '上一年',
      () => { calYear--; renderCalendar(); },
      y + '年',
      '点击返回当月日历',
      () => { calView = 'month'; const now = new Date(); calMonth = now.getMonth(); calYear = now.getFullYear(); renderCalendar(); },
      '下一年',
      () => { calYear++; renderCalendar(); }
    ));
    for (let m = 0; m < 12; m++) {
      const mm = document.createElement('div');
      mm.className = 'cal-mini';
      const mt = document.createElement('div');
      mt.className = 'cal-mini-title';
      mt.textContent = (m + 1) + '月';
      mm.appendChild(mt);
      mm.appendChild(buildCalendarMonthDays(y, m, reviewDates, true));
      wrap.appendChild(mm);
    }
    return wrap;
  }

  function renderCalendar() {
    calendarEl.innerHTML = '';
    const reviewDates = collectActiveDates();
    if (calView === 'year') {
      calendarEl.appendChild(buildYearView(calYear, reviewDates));
    } else {
      calendarEl.appendChild(buildMonthView(calYear, calMonth, reviewDates));
    }
  }

  // 点击日历高亮日期后，快速定位到当前页面（生词本 / 已背 / 句子收藏）中对应日期的分组。
  // 分页列表会先算好目标日期所在页再重渲染，句子收藏为整页渲染直接定位。
  function jumpToDate(dateStr) {
    // 仅在支持日期定位的三个页面生效；其他页面忽略。
    if (currentTab !== 'list' && currentTab !== 'memorized' && currentTab !== 'sentences') return;

    if (currentTab === 'list') {
      searchEl.value = '';
      wordGridView = false;
      const entries = getCurrentBookEntries().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      const idx = entries.findIndex((w) => formatDate(w.addedAt) === dateStr);
      wordPage = idx === -1 ? wordPage : Math.floor(idx / PAGE_SIZE);
      renderList();
    } else if (currentTab === 'memorized') {
      memorizedSearchEl.value = '';
      memorizedGridView = false;
      const list = getCurrentBookEntries(true)
        .filter((w) => w.status === 'memorized')
        .sort(memorizedComparator());
      const idx = list.findIndex((w) => formatDate(w.memorizedAt) === dateStr);
      memorizedPage = idx === -1 ? memorizedPage : Math.floor(idx / PAGE_SIZE);
      renderMemorized();
    } else {
      sentenceSearchEl.value = '';
      renderSentences();
    }

    // 渲染完成后滚动到目标日期分组并闪烁提示。
    requestAnimationFrame(() => {
      const target = document.querySelector('.date-group[data-date="' + dateStr + '"]');
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('date-flash');
      setTimeout(() => target.classList.remove('date-flash'), 1400);
    });
  }

  /* ---------- 生词本列表 ---------- */

  const wordListEl = document.getElementById('word-list');
  const wordPagerEl = document.getElementById('word-pager');
  const emptyEl = document.getElementById('empty');
  const searchEl = document.getElementById('search');

  // 按 PAGE_SIZE 切片并夹取页码，返回当前页条目与分页信息。
  function slicePage(items, page) {
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const p = Math.min(Math.max(0, page || 0), totalPages - 1);
    return {
      items: items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE),
      page: p,
      totalPages,
      total: items.length,
    };
  }

  // 在指定容器中渲染「上一页 / 页码信息 / 下一页」分页控件。
  function renderPagerInto(containerEl, slice, onPage) {
    containerEl.innerHTML = '';
    if (slice.totalPages <= 1) {
      containerEl.classList.add('hidden');
      return;
    }
    containerEl.classList.remove('hidden');

    const prev = document.createElement('button');
    prev.className = 'btn pager-btn';
    prev.textContent = '‹ 上一页';
    prev.disabled = slice.page === 0;
    prev.addEventListener('click', () => onPage(slice.page - 1));
    containerEl.appendChild(prev);

    const info = document.createElement('span');
    info.className = 'pager-info';
    info.textContent = '共 ' + slice.total + ' 个';
    containerEl.appendChild(info);

    // 页码输入框 + 跳转按钮，让用户直接选择第几页，而不是只能逐页点击。
    const pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.className = 'pager-input';
    pageInput.min = '1';
    pageInput.max = String(slice.totalPages);
    pageInput.value = String(slice.page + 1);
    pageInput.title = '输入页码后回车或点「跳转」';
    const goPage = () => {
      const n = parseInt(pageInput.value, 10);
      if (!Number.isNaN(n)) onPage(n - 1);
    };
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') goPage();
    });
    containerEl.appendChild(pageInput);

    const totalInfo = document.createElement('span');
    totalInfo.className = 'pager-info';
    totalInfo.textContent = '/ ' + slice.totalPages + ' 页';
    containerEl.appendChild(totalInfo);

    const go = document.createElement('button');
    go.className = 'btn pager-btn';
    go.textContent = '跳转';
    go.addEventListener('click', goPage);
    containerEl.appendChild(go);

    const next = document.createElement('button');
    next.className = 'btn pager-btn';
    next.textContent = '下一页 ›';
    next.disabled = slice.page >= slice.totalPages - 1;
    next.addEventListener('click', () => onPage(slice.page + 1));
    containerEl.appendChild(next);
  }

  function renderList() {
    const keyword = searchEl.value.trim().toLowerCase();
    const entries = getCurrentBookEntries().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    const filtered = keyword
      ? entries.filter(
          (w) =>
            w.word.toLowerCase().includes(keyword) ||
            (w.translation && w.translation.toLowerCase().includes(keyword))
        )
      : entries;

    const slice = slicePage(filtered, wordPage);
    wordPage = slice.page;
    visibleWords = slice.items;
    wordListEl.innerHTML = '';
    flippedWordCards = [];

    if (filtered.length === 0) {
      emptyEl.classList.remove('hidden');
      wordPagerEl.classList.add('hidden');
      wordPagerEl.innerHTML = '';
      updateWordToolbar();
      return;
    }
    emptyEl.classList.add('hidden');

    // 网格视图：扁平排列卡片；列表视图：按日期与来源分组。
    wordListEl.classList.toggle('grid', wordGridView);
    panels.list.classList.toggle('grid-mode', wordGridView);
    wordListEl.style.setProperty('--grid-cols', wordGridCols);
    const groups = groupByDateAndSource(slice.items, 'addedAt');
    if (wordGridView) {
      const flat = flattenGroups(groups);
      for (const w of flat) wordListEl.appendChild(buildWordItem(w));
    } else {
      appendGroupedItems(wordListEl, groups, buildWordItem);
    }
    renderPagerInto(wordPagerEl, slice, (p) => {
      wordPage = p;
      renderList();
    });
    updateWordToolbar();
  }

  // 通用：为列表容器绑定“点击卡片任意位置选中 / 取消选中”，并支持按住鼠标拖拽刷选多张。
  // selectedSet：选中集合；getKey(el)：从卡片 DOM 读取条目键（word 或 id）；onChange：选中集合变化后回调。
  function bindSelectionByClick(listEl, selectedSet, getKey, onChange) {
    let dragging = false;
    let paintValue = false;    // 本次拖拽刷选的目标状态：true=选中，false=取消选中
    const painted = new Set(); // 本次拖拽已处理过的卡片，避免重复触发

    function apply(card) {
      const key = getKey(card);
      if (key == null || painted.has(card)) return;
      painted.add(card);
      const has = selectedSet.has(key);
      if (has !== paintValue) {
        if (paintValue) selectedSet.add(key);
        else selectedSet.delete(key);
        card.classList.toggle('selected', paintValue);
      }
    }

    listEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 仅响应鼠标左键
      // 保留链接与发音按钮的原有行为，不参与点选。
      if (e.target.closest('a') || e.target.closest('.lv-speaker')) return;
      const card = e.target.closest('.selectable');
      if (!card || !listEl.contains(card)) return;

      const key = getKey(card);
      paintValue = !selectedSet.has(key); // 以首张卡片为准决定本次刷选是选中还是取消
      painted.clear();
      dragging = true;
      apply(card);
      onChange();

      const onMove = (ev) => {
        if (!dragging) return;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!el) return;
        const c = el.closest('.selectable');
        if (c && listEl.contains(c)) apply(c);
      };
      const onUp = () => {
        dragging = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      // 阻止默认行为，避免拖拽时选中文本。
      e.preventDefault();
    });
  }

  // 给条目头部/例句区域绑定“点击展开释义”。点击发音按钮或来源链接时不触发，避免误展开。
  function bindItemToggle(item, targets) {
    targets.forEach((t) => {
      if (!t) return;
      t.addEventListener('click', (e) => {
        if (e.target.closest('.lv-speaker') || e.target.closest('a') || e.target.closest('input')) return;
        item.classList.toggle('open');
      });
    });
  }

  function buildWordItem(w) {
    return wordGridView ? buildWordCard(w) : buildWordListItem(w);
  }

  function buildWordListItem(w) {
    const item = document.createElement('div');
    item.className = 'word-item';
    item.dataset.word = w.word;

    const head = document.createElement('div');
    head.className = 'word-head';

    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.textContent = w.word;
    head.appendChild(wordSpan);

    if (w.phonetic) {
      const ph = document.createElement('span');
      ph.className = 'phonetic';
      ph.textContent = '/' + w.phonetic + '/';
      head.appendChild(ph);
    }

    head.appendChild(LV_TTS.speakerButton(w.word));

    if (w.status === 'memorized') {
      const badge = document.createElement('span');
      badge.className = 'badge memorized';
      badge.textContent = '已背';
      head.appendChild(badge);
    }

    item.appendChild(head);

    // 例句：默认展示，无需点击；点击例句同样可展开释义。
    let examples = null;
    if (w.sentences && w.sentences.length) {
      examples = document.createElement('div');
      examples.className = 'word-examples';
      for (const s of w.sentences) {
        examples.appendChild(buildSentenceRow(s, w.word));
      }
      item.appendChild(examples);
    }

    // 释义（翻译 + 结构化释义 + 英文释义）：点击头部或例句展开。
    const body = document.createElement('div');
    body.className = 'word-body';
    const bodyInner = document.createElement('div');
    bodyInner.className = 'word-body-inner';

    if (w.translation) {
      const trans = document.createElement('div');
      trans.className = 'trans';
      trans.textContent = w.translation;
      bodyInner.appendChild(trans);
    }

    appendEntryDetail(bodyInner, w);
    body.appendChild(bodyInner);
    item.appendChild(body);

    if (wordDeleteMode) {
      item.classList.add('selectable');
      item.classList.toggle('selected', selectedWords.has(w.word));
    } else {
      bindItemToggle(item, [head, examples]);
    }
    return item;
  }

  // 网格卡片翻转：限制同时最多 maxFlipCards 张翻转；超出时自动翻回最早翻转的卡片。
  function bindCardFlip(card, queue) {
    card.addEventListener('click', () => {
      if (card.classList.contains('flipped')) {
        card.classList.remove('flipped');
        const i = queue.indexOf(card);
        if (i >= 0) queue.splice(i, 1);
      } else {
        card.classList.add('flipped');
        queue.push(card);
        if (queue.length > maxFlipCards) {
          const first = queue.shift();
          first.classList.remove('flipped');
        }
      }
    });
  }

  // 网格卡片：正面显示音标/例句/发音，点击翻转显示释义。
  function buildWordCard(w) {
    const card = document.createElement('div');
    card.className = 'word-card';
    card.dataset.word = w.word;

    const inner = document.createElement('div');
    inner.className = 'word-card-inner';

    const front = document.createElement('div');
    front.className = 'word-card-face word-card-front';
    const wordRow = document.createElement('div');
    wordRow.className = 'word-card-word-row';
    const wordSpan = document.createElement('div');
    wordSpan.className = 'word-card-word';
    wordSpan.textContent = w.word;
    wordRow.appendChild(wordSpan);
    wordRow.appendChild(LV_TTS.speakerButton(w.word));
    front.appendChild(wordRow);

    if (w.phonetic) {
      const ph = document.createElement('div');
      ph.className = 'word-card-phonetic';
      ph.textContent = '/' + w.phonetic + '/';
      front.appendChild(ph);
    }
    if (w.sentences && w.sentences.length) {
      const ex = document.createElement('div');
      ex.className = 'word-card-example';
      const exText = document.createElement('span');
      exText.className = 'word-card-example-text';
      exText.appendChild(highlightWordInSentence(w.sentences[0], w.word));
      ex.appendChild(exText);
      ex.appendChild(LV_TTS.speakerButton(w.sentences[0]));
      front.appendChild(ex);
    }
    inner.appendChild(front);

    const back = document.createElement('div');
    back.className = 'word-card-face word-card-back';
    if (w.translation) {
      const trans = document.createElement('div');
      trans.className = 'trans';
      trans.textContent = w.translation;
      back.appendChild(trans);
    }
    appendEntryDetail(back, w);
    inner.appendChild(back);

    card.appendChild(inner);
    if (wordDeleteMode) {
      card.classList.add('selectable');
      card.classList.toggle('selected', selectedWords.has(w.word));
    } else {
      bindCardFlip(card, flippedWordCards);
    }
    return card;
  }

  const selectAllWordsBtn = document.getElementById('select-all-words');
  const deleteSelectedWordsBtn = document.getElementById('delete-selected-words');
  const wordDeleteToggle = document.getElementById('word-delete-toggle');
  const wordSelectionBar = document.getElementById('word-selection-bar');
  const cancelWordDelete = document.getElementById('cancel-word-delete');
  const wordGridToggle = document.getElementById('word-grid-toggle');

  function updateWordToolbar() {
    deleteSelectedWordsBtn.disabled = selectedWords.size === 0;
    const allSelected = visibleWords.length > 0 && visibleWords.every((w) => selectedWords.has(w.word));
    selectAllWordsBtn.textContent = allSelected ? '取消全选' : '全选';
    wordGridToggle.innerHTML = wordGridView ? LIST_ICON_SVG : GRID_ICON_SVG;
    wordGridToggle.title = wordGridView ? '切换为列表视图' : '切换为网格视图';
  }

  // 绑定生词本点选/拖选逻辑：进入删除模式后卡片带 .selectable，点击或拖拽即可选中。
  bindSelectionByClick(wordListEl, selectedWords, (el) => el.dataset.word, updateWordToolbar);

  function setWordDeleteMode(on) {
    wordDeleteMode = on;
    selectedWords.clear();
    wordPage = 0;
    wordSelectionBar.classList.toggle('hidden', !on);
    wordDeleteToggle.classList.toggle('hidden', on);
    renderList();
  }

  selectAllWordsBtn.addEventListener('click', () => {
    const allSelected = visibleWords.length > 0 && visibleWords.every((w) => selectedWords.has(w.word));
    if (allSelected) {
      visibleWords.forEach((w) => selectedWords.delete(w.word));
    } else {
      visibleWords.forEach((w) => selectedWords.add(w.word));
    }
    renderList();
  });

  wordDeleteToggle.addEventListener('click', () => setWordDeleteMode(true));
  cancelWordDelete.addEventListener('click', () => setWordDeleteMode(false));

  deleteSelectedWordsBtn.addEventListener('click', () => {
    if (!selectedWords.size) return;
    if (!confirm('确定删除选中的 ' + selectedWords.size + ' 个生词吗？此操作不可恢复。')) return;
    for (const key of selectedWords) delete wordsMap[key];
    setWordDeleteMode(false);
    saveWords().then(renderAll);
  });

  wordGridToggle.addEventListener('click', () => {
    wordGridView = !wordGridView;
    renderList();
  });

  searchEl.addEventListener('input', () => {
    wordPage = 0;
    renderList();
  });

  function clearAllWords() {
    if (Object.keys(wordsMap).length === 0) return;
    if (!confirm('确定要清空所有生词吗？此操作不可恢复。')) return;
    wordsMap = {};
    selectedMemorized.clear();
    selectedWords.clear();
    setWordDeleteMode(false);
    saveWords().then(renderAll);
  }

  /* ---------- 背单词 ---------- */

  const reviewSetupEl = document.getElementById('review-setup');
  const reviewCardEl = document.getElementById('review-card');
  const reviewProgressEl = document.getElementById('review-progress');
  const reviewWordEl = document.getElementById('review-word');
  const reviewSpeakerBtn = document.getElementById('review-speaker');
  const reviewPhoneticEl = document.getElementById('review-phonetic');
  const reviewUnknownEl = document.getElementById('review-unknown');
  const reviewExamplesEl = document.getElementById('review-examples');
  const reviewAnswerEl = document.getElementById('review-answer');
  const showAnswerBtn = document.getElementById('show-answer');
  const knowBtn = document.getElementById('know');
  const dontKnowBtn = document.getElementById('dont-know');

  // 背单词配置：范围筛选（仅「生词本」可用）与模式（全随机 / 补充模式）。
  const reviewScopeGroupEl = document.getElementById('review-scope-group');
  const reviewScopeEl = document.getElementById('review-scope');
  const reviewScopeValueEl = document.getElementById('review-scope-value');
  const batchSizeWrapEl = document.getElementById('batch-size-wrap');
  const batchSizeEl = document.getElementById('batch-size');

  let reviewScope = 'all';   // 'all' | 'date' | 'source'
  let reviewScopeValue = ''; // 选中的日期或来源
  let reviewMode = 'random'; // 'random' | 'batch'
  let batchSize = 10;        // 补充模式每批词数（最低 10）
  let reviewQueue = [];      // 补充模式当前批次队列

  function sourceKeyOf(w) {
    return w.sourceUrl || w.sourceTitle || '__unknown__';
  }
  function sourceLabelOf(w) {
    return w.sourceTitle || w.sourceUrl || '未知来源';
  }

  // 生词本专属范围：按当前范围填充「日期 / 来源」下拉，并显示或隐藏相关控件。
  function updateReviewScopeUI() {
    const isOwn = currentBook === 'own';
    reviewScopeGroupEl.classList.toggle('hidden', !isOwn);
    if (!isOwn) return;

    reviewScopeValueEl.innerHTML = '';
    if (reviewScope === 'all') {
      reviewScopeValueEl.classList.add('hidden');
      return;
    }
    reviewScopeValueEl.classList.remove('hidden');

    const own = Object.values(wordsMap);
    if (reviewScope === 'date') {
      const dates = Array.from(new Set(own.map((w) => formatDate(w.addedAt)))).sort().reverse();
      for (const d of dates) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        reviewScopeValueEl.appendChild(opt);
      }
      if (!dates.includes(reviewScopeValue)) reviewScopeValue = dates[0] || '';
    } else {
      const map = new Map();
      for (const w of own) map.set(sourceKeyOf(w), sourceLabelOf(w));
      for (const [key, label] of map) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = shortBookName(label);
        opt.title = label;
        reviewScopeValueEl.appendChild(opt);
      }
      if (!map.has(reviewScopeValue)) reviewScopeValue = map.keys().next().value || '';
    }
    reviewScopeValueEl.value = reviewScopeValue;
  }

  function updateReviewModeUI() {
    batchSizeWrapEl.classList.toggle('hidden', reviewMode !== 'batch');
  }

  // 应用范围筛选后的待背池。
  function getReviewPool() {
    let list = getPendingWords();
    if (currentBook === 'own' && reviewScope !== 'all') {
      if (reviewScope === 'date') {
        list = list.filter((w) => formatDate(w.addedAt) === reviewScopeValue);
      } else if (reviewScope === 'source') {
        list = list.filter((w) => sourceKeyOf(w) === reviewScopeValue);
      }
    }
    return list;
  }

  reviewScopeEl.addEventListener('change', () => {
    reviewScope = reviewScopeEl.value;
    updateReviewScopeUI();
  });

  reviewScopeValueEl.addEventListener('change', () => {
    reviewScopeValue = reviewScopeValueEl.value;
  });

  document.querySelectorAll('input[name="review-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      reviewMode = r.value;
      updateReviewModeUI();
    });
  });

  batchSizeEl.addEventListener('change', () => {
    batchSize = Math.max(10, parseInt(batchSizeEl.value, 10) || 10);
    batchSizeEl.value = batchSize;
  });

  updateReviewModeUI();

  // 主发音按钮：固定图标，点击朗读当前单词。
  reviewSpeakerBtn.innerHTML = SPEAKER_SVG;
  reviewSpeakerBtn.addEventListener('click', () => {
    if (currentWord) LV_TTS.speak(currentWord.word);
  });

  // 右上角淡色叉：终止背诵，回到选书界面。
  document.getElementById('review-close').addEventListener('click', () => {
    reviewCardEl.classList.add('hidden');
    reviewSetupEl.classList.remove('hidden');
    currentWord = null;
    lastReviewWord = null;
  });

  document.getElementById('start-review').addEventListener('click', () => {
    const pool = getReviewPool();
    if (pool.length === 0) {
      alert('暂无可背单词。请先在网页双击添加生词，或切换到已导入的预设词表；已背单词到复习时间后也会重新出现在待背中。');
      return;
    }
    if (reviewMode === 'batch') startBatch();
    recordReviewStartDate();
    renderCalendar();
    reviewSetupEl.classList.add('hidden');
    reviewCardEl.classList.remove('hidden');
    showNextWord();
  });

  // 随机打乱数组并抽取前 n 个（补充模式初始化批次）。
  function pickRandomBatch(list, n) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
  }

  function startBatch() {
    reviewQueue = pickRandomBatch(getReviewPool(), batchSize);
  }

  // 认识一个词后补充一个新词，保持批次数量不变（直到待背池耗尽）。
  function refillBatch() {
    const pool = getReviewPool();
    const inQueue = new Set(reviewQueue.map((w) => w.word));
    const candidates = pool.filter((w) => !inQueue.has(w.word));
    if (candidates.length) {
      reviewQueue.push(candidates[Math.floor(Math.random() * candidates.length)]);
    }
  }

  // 按“不认识次数”加权随机抽取：忘记越多的单词权重越高、出现越频繁。
  function pickWeighted(pending) {
    const totalWeight = pending.reduce((s, w) => s + (1 + (w.unknownCount || 0)), 0);
    let r = Math.random() * totalWeight;
    for (const w of pending) {
      r -= 1 + (w.unknownCount || 0);
      if (r <= 0) return w;
    }
    return pending[pending.length - 1];
  }

  function showNextWord() {
    let pool;
    if (reviewMode === 'batch') {
      pool = reviewQueue;
      // 若批次已空但待背池仍有词（如状态变化），重新初始化一批。
      if (!pool.length) {
        if (!getReviewPool().length) {
          reviewCardEl.classList.add('hidden');
          reviewSetupEl.classList.remove('hidden');
          return;
        }
        startBatch();
        pool = reviewQueue;
      }
    } else {
      pool = getReviewPool();
      if (!pool.length) {
        reviewCardEl.classList.add('hidden');
        reviewSetupEl.classList.remove('hidden');
        return;
      }
    }

    // 避免同一个单词连续出现：候选词多于 1 个时，排除上一次展示的单词。
    let candidates = pool;
    if (lastReviewWord && pool.length > 1) {
      const filtered = pool.filter((w) => w.word !== lastReviewWord);
      if (filtered.length) candidates = filtered;
    }

    currentWord = pickWeighted(candidates);
    lastReviewWord = currentWord.word;
    if (reviewMode === 'batch') {
      reviewProgressEl.textContent = '本批剩余 ' + reviewQueue.length + ' 个';
    } else {
      reviewProgressEl.textContent = '待背 ' + pool.length + ' 个单词';
    }
    reviewWordEl.textContent = currentWord.word;
    reviewPhoneticEl.textContent = currentWord.phonetic
      ? '/' + currentWord.phonetic + '/'
      : '';

    const unk = currentWord.unknownCount || 0;
    reviewUnknownEl.textContent = unk > 0 ? '已忘记 ' + unk + ' 次' : '';

    // 例句在点击“显示答案”前就展示，且可发音。
    renderReviewExamples(currentWord);

    reviewAnswerEl.classList.add('hidden');
    reviewAnswerEl.innerHTML = '';
    showAnswerBtn.classList.remove('hidden');
    knowBtn.classList.add('hidden');
    dontKnowBtn.classList.add('hidden');

    // 每个单词出现时自动发音一次。
    LV_TTS.speak(currentWord.word);
  }

  function renderReviewExamples(w) {
    reviewExamplesEl.innerHTML = '';
    const sentences = w.sentences || [];
    if (!sentences.length) return;

    const title = document.createElement('div');
    title.className = 'examples-title';
    title.textContent = '例句';
    reviewExamplesEl.appendChild(title);

    for (const s of sentences) {
      reviewExamplesEl.appendChild(buildSentenceRow(s, w.word));
    }
  }

  showAnswerBtn.addEventListener('click', () => {
    if (!currentWord) return;
    reviewAnswerEl.innerHTML = '';

    if (currentWord.translation) {
      const div = document.createElement('div');
      div.textContent = currentWord.translation;
      reviewAnswerEl.appendChild(div);
    }

    appendEntryDetail(reviewAnswerEl, currentWord);

    reviewAnswerEl.classList.remove('hidden');
    showAnswerBtn.classList.add('hidden');
    knowBtn.classList.remove('hidden');
    dontKnowBtn.classList.remove('hidden');
  });

  // “认识”：移入已背，按当前复习阶段设置下次复习时间。
  function markKnown(entry) {
    entry.knownCount = (entry.knownCount || 0) + 1;
    entry.lastReviewedAt = Date.now();
    const stage = Math.min(entry.reviewStage || 0, EBBINGHAUS.length - 1);
    entry.status = 'memorized';
    entry.memorizedAt = Date.now();
    entry.nextReviewAt = Date.now() + EBBINGHAUS[stage];
    entry.reviewStage = stage + 1;
  }

  // “不认识”：记录一次遗忘，保持待背状态。
  function markUnknown(entry) {
    entry.unknownCount = (entry.unknownCount || 0) + 1;
    entry.lastReviewedAt = Date.now();
  }

  knowBtn.addEventListener('click', () => {
    if (!currentWord) return;
    markKnown(currentWord);
    if (reviewMode === 'batch') {
      reviewQueue = reviewQueue.filter((w) => w.word !== currentWord.word);
    }
    persistCurrentWord(currentWord).then(() => {
      renderStats();
      if (reviewMode === 'batch') refillBatch();
      showNextWord();
    });
  });

  dontKnowBtn.addEventListener('click', () => {
    if (!currentWord) return;
    markUnknown(currentWord);
    persistCurrentWord(currentWord).then(() => {
      renderStats();
      showNextWord();
    });
  });

  /* ---------- 已背 ---------- */

  const memorizedListEl = document.getElementById('memorized-list');
  const memorizedPagerEl = document.getElementById('memorized-pager');
  const memorizedEmptyEl = document.getElementById('memorized-empty');
  const reAddToggle = document.getElementById('re-add-toggle');
  const memorizedDeleteToggle = document.getElementById('memorized-delete-toggle');
  const memorizedSelectionBar = document.getElementById('memorized-selection-bar');
  const selectAllMemorizedBtn = document.getElementById('select-all-memorized');
  const memorizedActionBtn = document.getElementById('memorized-action-btn');
  const cancelMemorized = document.getElementById('cancel-memorized');
  const memorizedGridToggle = document.getElementById('memorized-grid-toggle');
  const memorizedSearchEl = document.getElementById('memorized-search');
  const memorizedSortEl = document.getElementById('memorized-sort');
  const memorizedSortDirBtn = document.getElementById('memorized-sort-dir');

  // 已背排序比较器：按字段与方向返回比较函数。
  function memorizedComparator() {
    const sign = memorizedSortDir === 'asc' ? 1 : -1;
    return (a, b) => {
      const va = memorizedSortKey === 'date' ? (a.memorizedAt || 0) : (a.unknownCount || 0);
      const vb = memorizedSortKey === 'date' ? (b.memorizedAt || 0) : (b.unknownCount || 0);
      return (va - vb) * sign;
    };
  }

  // 同步排序方向按钮图标：↓ 降序，↑ 升序。
  function updateMemorizedSortDirUI() {
    memorizedSortDirBtn.textContent = memorizedSortDir === 'asc' ? '↑' : '↓';
    memorizedSortDirBtn.title = memorizedSortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序';
  }

  function renderMemorized() {
    const keyword = memorizedSearchEl.value.trim().toLowerCase();
    let memorized = getCurrentBookEntries(true)
      .filter((w) => w.status === 'memorized')
      .sort(memorizedComparator());

    if (keyword) {
      memorized = memorized.filter(
        (w) =>
          w.word.toLowerCase().includes(keyword) ||
          (w.translation && w.translation.toLowerCase().includes(keyword))
      );
    }

    const slice = slicePage(memorized, memorizedPage);
    memorizedPage = slice.page;
    visibleMemorized = slice.items;
    memorizedListEl.innerHTML = '';
    flippedMemorizedCards = [];

    if (!memorized.length) {
      memorizedEmptyEl.classList.remove('hidden');
      memorizedPagerEl.classList.add('hidden');
      memorizedPagerEl.innerHTML = '';
      updateMemorizedToolbar();
      return;
    }
    memorizedEmptyEl.classList.add('hidden');

    // 网格视图：扁平卡片；列表视图：按记忆日期分组。
    memorizedListEl.classList.toggle('grid', memorizedGridView);
    panels.memorized.classList.toggle('grid-mode', memorizedGridView);
    memorizedListEl.style.setProperty('--grid-cols', memorizedGridCols);
    if (memorizedGridView) {
      for (const w of slice.items) memorizedListEl.appendChild(buildMemorizedItem(w));
    } else {
      const dateMap = {};
      for (const w of slice.items) {
        const d = formatDate(w.memorizedAt);
        (dateMap[d] = dateMap[d] || []).push(w);
      }
      const dates = Object.keys(dateMap).sort().reverse();
      for (const date of dates) {
        const group = document.createElement('div');
        group.className = 'date-group';
        group.dataset.date = date;
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'date-group-title';
        const chevron = document.createElement('span');
        chevron.className = 'date-chevron';
        chevron.textContent = '▾';
        title.appendChild(chevron);
        title.appendChild(document.createTextNode(date + '（' + dateMap[date].length + '）'));
        title.addEventListener('click', () => group.classList.toggle('collapsed'));
        group.appendChild(title);
        const body = document.createElement('div');
        body.className = 'date-group-body';
        for (const w of dateMap[date]) body.appendChild(buildMemorizedItem(w));
        group.appendChild(body);
        memorizedListEl.appendChild(group);
      }
    }
    renderPagerInto(memorizedPagerEl, slice, (p) => {
      memorizedPage = p;
      renderMemorized();
    });

    updateMemorizedToolbar();
  }

  function buildMemorizedItem(w) {
    return memorizedGridView ? buildMemorizedCard(w) : buildMemorizedListItem(w);
  }

  function buildMemorizedListItem(w) {
    const item = document.createElement('div');
    item.className = 'memorized-item';
    item.dataset.word = w.word;

    const head = document.createElement('div');
    head.className = 'memorized-head';

    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.textContent = w.word;
    head.appendChild(wordSpan);

    if (w.phonetic) {
      const ph = document.createElement('span');
      ph.className = 'phonetic';
      ph.textContent = '/' + w.phonetic + '/';
      head.appendChild(ph);
    }
    head.appendChild(LV_TTS.speakerButton(w.word));
    item.appendChild(head);

    // 例句：默认展示，与生词本一致；点击例句同样可展开释义。
    let examples = null;
    if (w.sentences && w.sentences.length) {
      examples = document.createElement('div');
      examples.className = 'memorized-examples';
      for (const s of w.sentences) {
        examples.appendChild(buildSentenceRow(s, w.word));
      }
      item.appendChild(examples);
    }

    // 释义 + 来源：点击头部或例句展开。
    const body = document.createElement('div');
    body.className = 'memorized-body';
    const bodyInner = document.createElement('div');
    bodyInner.className = 'memorized-body-inner';
    if (w.translation) {
      const trans = document.createElement('div');
      trans.className = 'trans';
      trans.textContent = w.translation;
      bodyInner.appendChild(trans);
    }
    appendEntryDetail(bodyInner, w);
    bodyInner.appendChild(buildSourceLine(w));
    body.appendChild(bodyInner);
    item.appendChild(body);

    if (memorizedMode !== 'none') {
      item.classList.add('selectable');
      item.classList.toggle('selected', selectedMemorized.has(w.word));
    } else {
      bindItemToggle(item, [head, examples]);
    }
    return item;
  }

  function buildMemorizedCard(w) {
    const card = document.createElement('div');
    card.className = 'word-card';
    card.dataset.word = w.word;

    const inner = document.createElement('div');
    inner.className = 'word-card-inner';

    const front = document.createElement('div');
    front.className = 'word-card-face word-card-front';
    const wordRow = document.createElement('div');
    wordRow.className = 'word-card-word-row';
    const wordSpan = document.createElement('div');
    wordSpan.className = 'word-card-word';
    wordSpan.textContent = w.word;
    wordRow.appendChild(wordSpan);
    wordRow.appendChild(LV_TTS.speakerButton(w.word));
    front.appendChild(wordRow);
    if (w.phonetic) {
      const ph = document.createElement('div');
      ph.className = 'word-card-phonetic';
      ph.textContent = '/' + w.phonetic + '/';
      front.appendChild(ph);
    }
    if (w.sentences && w.sentences.length) {
      const ex = document.createElement('div');
      ex.className = 'word-card-example';
      const exText = document.createElement('span');
      exText.className = 'word-card-example-text';
      exText.appendChild(highlightWordInSentence(w.sentences[0], w.word));
      ex.appendChild(exText);
      ex.appendChild(LV_TTS.speakerButton(w.sentences[0]));
      front.appendChild(ex);
    }
    inner.appendChild(front);

    const back = document.createElement('div');
    back.className = 'word-card-face word-card-back';
    if (w.translation) {
      const trans = document.createElement('div');
      trans.className = 'trans';
      trans.textContent = w.translation;
      back.appendChild(trans);
    }
    appendEntryDetail(back, w);
    back.appendChild(buildSourceLine(w));
    inner.appendChild(back);

    card.appendChild(inner);
    if (memorizedMode !== 'none') {
      card.classList.add('selectable');
      card.classList.toggle('selected', selectedMemorized.has(w.word));
    } else {
      bindCardFlip(card, flippedMemorizedCards);
    }
    return card;
  }

  // 来源网页链接（点击跳转，阻止冒泡以免触发卡片翻转/展开）。
  function buildSourceLine(w) {
    const line = document.createElement('div');
    line.className = 'source-line';
    if (w.sourceUrl) {
      const a = document.createElement('a');
      a.href = w.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = w.sourceTitle || w.sourceUrl;
      a.addEventListener('click', (e) => e.stopPropagation());
      line.appendChild(document.createTextNode('来源：'));
      line.appendChild(a);
    } else if (w.sourceTitle) {
      line.textContent = '来源：' + w.sourceTitle;
    }
    return line;
  }

  function updateMemorizedToolbar() {
    memorizedActionBtn.disabled = selectedMemorized.size === 0;
    const allSelected = visibleMemorized.length > 0 && visibleMemorized.every((w) => selectedMemorized.has(w.word));
    selectAllMemorizedBtn.textContent = allSelected ? '取消全选' : '全选';
    memorizedGridToggle.innerHTML = memorizedGridView ? LIST_ICON_SVG : GRID_ICON_SVG;
    memorizedGridToggle.title = memorizedGridView ? '切换为列表视图' : '切换为网格视图';
  }

  // 绑定已背点选/拖选逻辑：进入删除或“忘记”模式后卡片带 .selectable。
  bindSelectionByClick(memorizedListEl, selectedMemorized, (el) => el.dataset.word, updateMemorizedToolbar);

  function setMemorizedMode(mode) {
    memorizedMode = mode;
    selectedMemorized.clear();
    memorizedPage = 0;
    const active = mode !== 'none';
    // 删除/移动按钮保持可见，避免切换时搜索框宽度来回变化。
    memorizedSelectionBar.classList.toggle('hidden', !active);
    const isDelete = mode === 'delete';
    memorizedActionBtn.textContent = isDelete ? '删除选中' : '忘记';
    memorizedActionBtn.className = 'btn ' + (isDelete ? 'danger' : 'primary');
    renderMemorized();
  }

  selectAllMemorizedBtn.addEventListener('click', () => {
    const allSelected = visibleMemorized.length > 0 && visibleMemorized.every((w) => selectedMemorized.has(w.word));
    if (allSelected) {
      visibleMemorized.forEach((w) => selectedMemorized.delete(w.word));
    } else {
      visibleMemorized.forEach((w) => selectedMemorized.add(w.word));
    }
    renderMemorized();
  });

  reAddToggle.addEventListener('click', () => setMemorizedMode('readd'));
  memorizedDeleteToggle.addEventListener('click', () => setMemorizedMode('delete'));
  cancelMemorized.addEventListener('click', () => setMemorizedMode('none'));

  memorizedActionBtn.addEventListener('click', () => {
    if (!selectedMemorized.size) return;
    if (memorizedMode === 'delete') {
      if (!confirm('确定删除选中的 ' + selectedMemorized.size + ' 个已背单词吗？此操作不可恢复。')) return;
      for (const key of selectedMemorized) delete wordsMap[key];
      setMemorizedMode('none');
      saveWords().then(renderAll);
    } else {
      for (const key of selectedMemorized) {
        const entry = wordsMap[key];
        if (!entry) continue;
        entry.status = 'pending';
        entry.memorizedAt = null;
        entry.reviewStage = 0;
        entry.nextReviewAt = null;
      }
      setMemorizedMode('none');
      saveWords().then(renderAll);
    }
  });

  memorizedGridToggle.addEventListener('click', () => {
    memorizedGridView = !memorizedGridView;
    renderMemorized();
  });

  memorizedSearchEl.addEventListener('input', () => {
    memorizedPage = 0;
    renderMemorized();
  });
  memorizedSortEl.addEventListener('change', () => {
    memorizedSortKey = memorizedSortEl.value;
    memorizedPage = 0;
    renderMemorized();
  });
  memorizedSortDirBtn.addEventListener('click', () => {
    memorizedSortDir = memorizedSortDir === 'desc' ? 'asc' : 'desc';
    memorizedPage = 0;
    updateMemorizedSortDirUI();
    renderMemorized();
  });
  updateMemorizedSortDirUI();

  /* ---------- 网格视图设置弹窗（每行卡片数 + 最多翻转卡片数） ---------- */

  const gridSettingsModal = document.getElementById('grid-settings-modal');
  const gridSettingsCols = document.getElementById('grid-settings-cols');
  const gridSettingsColsValue = document.getElementById('grid-settings-cols-value');
  const gridSettingsMaxflip = document.getElementById('grid-settings-maxflip');
  const gridSettingsClose = document.getElementById('grid-settings-close');

  function openGridSettings(target) {
    gridSettingsTarget = target;
    const cols = target === 'word' ? wordGridCols : memorizedGridCols;
    gridSettingsCols.value = cols;
    gridSettingsColsValue.textContent = cols;
    gridSettingsMaxflip.value = maxFlipCards;
    gridSettingsModal.classList.remove('hidden');
  }

  function closeGridSettings() {
    gridSettingsModal.classList.add('hidden');
  }

  gridSettingsClose.addEventListener('click', closeGridSettings);
  gridSettingsModal.addEventListener('click', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.closeGridSettings !== undefined) {
      closeGridSettings();
    }
  });

  // 每行卡片数：实时更新对应面板的网格列数。
  gridSettingsCols.addEventListener('input', () => {
    const n = parseInt(gridSettingsCols.value, 10) || 4;
    const cols = Math.min(8, Math.max(2, n));
    gridSettingsCols.value = cols;
    gridSettingsColsValue.textContent = cols;
    if (gridSettingsTarget === 'word') {
      wordGridCols = cols;
      renderList();
    } else {
      memorizedGridCols = cols;
      renderMemorized();
    }
  });

  // 最多同时翻转卡片数：持久化到 appearance。
  gridSettingsMaxflip.addEventListener('input', () => {
    maxFlipCards = clampInt(gridSettingsMaxflip.value, 1, 20, 3);
    gridSettingsMaxflip.value = maxFlipCards;
    saveAppearance();
  });

  /* ---------- 句子收藏 ---------- */

  const sentencesListEl = document.getElementById('sentences-list');
  const sentencesEmptyEl = document.getElementById('sentences-empty');
  const sentencesInfoEl = document.getElementById('sentences-info');
  const selectAllSentencesBtn = document.getElementById('select-all-sentences');
  const deleteSelectedSentencesBtn = document.getElementById('delete-selected-sentences');
  const sentenceDeleteToggle = document.getElementById('sentence-delete-toggle');
  const sentenceSelectionBar = document.getElementById('sentence-selection-bar');
  const cancelSentenceDelete = document.getElementById('cancel-sentence-delete');
  const sentenceSearchEl = document.getElementById('sentence-search');

  function renderSentences() {
    const keyword = sentenceSearchEl.value.trim().toLowerCase();
    let list = sentencesList.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    if (keyword) {
      list = list.filter(
        (s) =>
          (s.text && s.text.toLowerCase().includes(keyword)) ||
          (s.translation && s.translation.toLowerCase().includes(keyword))
      );
    }
    visibleSentences = list;
    sentencesListEl.innerHTML = '';
    sentencesInfoEl.textContent = '共 ' + list.length + ' 条（按日期与来源分组）';

    if (!list.length) {
      sentencesEmptyEl.classList.remove('hidden');
      updateSentenceToolbar();
      return;
    }
    sentencesEmptyEl.classList.add('hidden');
    const groups = groupByDateAndSource(list, 'addedAt');
    appendGroupedItems(sentencesListEl, groups, buildSentenceItem);
    updateSentenceToolbar();
  }

  function updateSentenceToolbar() {
    deleteSelectedSentencesBtn.disabled = selectedSentences.size === 0;
    const allSelected = visibleSentences.length > 0 && visibleSentences.every((s) => selectedSentences.has(s.id));
    selectAllSentencesBtn.textContent = allSelected ? '取消全选' : '全选';
  }

  // 绑定句子收藏点选/拖选逻辑：进入删除模式后卡片带 .selectable。
  bindSelectionByClick(sentencesListEl, selectedSentences, (el) => el.dataset.id, updateSentenceToolbar);

  function setSentenceDeleteMode(on) {
    sentenceDeleteMode = on;
    selectedSentences.clear();
    sentenceSelectionBar.classList.toggle('hidden', !on);
    sentenceDeleteToggle.classList.toggle('hidden', on);
    renderSentences();
  }

  selectAllSentencesBtn.addEventListener('click', () => {
    const allSelected = visibleSentences.length > 0 && visibleSentences.every((s) => selectedSentences.has(s.id));
    if (allSelected) {
      visibleSentences.forEach((s) => selectedSentences.delete(s.id));
    } else {
      visibleSentences.forEach((s) => selectedSentences.add(s.id));
    }
    renderSentences();
  });

  sentenceDeleteToggle.addEventListener('click', () => setSentenceDeleteMode(true));
  cancelSentenceDelete.addEventListener('click', () => setSentenceDeleteMode(false));
  sentenceSearchEl.addEventListener('input', renderSentences);

  deleteSelectedSentencesBtn.addEventListener('click', () => {
    if (!selectedSentences.size) return;
    if (!confirm('确定删除选中的 ' + selectedSentences.size + ' 条句子收藏吗？此操作不可恢复。')) return;
    sentencesList = sentencesList.filter((s) => !selectedSentences.has(s.id));
    setSentenceDeleteMode(false);
    chrome.storage.local.set({ sentences: sentencesList }).then(renderAll);
  });

  function buildSentenceItem(s) {
    const item = document.createElement('div');
    item.className = 'sentence-item';
    item.dataset.id = s.id;

    if (sentenceDeleteMode) {
      item.classList.add('selectable');
      item.classList.toggle('selected', selectedSentences.has(s.id));
    }

    const head = document.createElement('div');
    head.className = 'sentence-item-head';

    const left = document.createElement('div');
    left.className = 'sentence-item-left';

    const time = document.createElement('span');
    time.className = 'sentence-item-time';
    time.textContent = formatDateTime(s.addedAt);
    left.appendChild(time);

    head.appendChild(left);
    item.appendChild(head);

    const en = document.createElement('div');
    en.className = 'sentence-item-en';
    const enText = document.createElement('span');
    enText.className = 'sentence-item-en-text';
    enText.textContent = s.text;
    en.appendChild(enText);
    en.appendChild(LV_TTS.speakerButton(s.text));
    item.appendChild(en);

    if (s.translation) {
      const zh = document.createElement('div');
      zh.className = 'sentence-item-zh';
      zh.textContent = s.translation;
      item.appendChild(zh);
    }

    return item;
  }

  /* ---------- 设置 ---------- */

  const configMsgEl = document.getElementById('config-msg');
  const shortcutEl = document.getElementById('shortcut');
  const shortcutMsgEl = document.getElementById('shortcut-msg');

  // 翻译接口输入框（key 与 background 中各 provider 的配置字段一致）。
  const providerInputs = {
    youdao: {
      appKey: document.getElementById('youdao-app-key'),
      appSecret: document.getElementById('youdao-app-secret'),
    },
    baidu: {
      appId: document.getElementById('baidu-app-id'),
      secret: document.getElementById('baidu-secret'),
    },
    google: {
      apiKey: document.getElementById('google-api-key'),
    },
    caiyun: {
      token: document.getElementById('caiyun-token'),
    },
    deepseek: {
      apiKey: document.getElementById('deepseek-api-key'),
      model: document.getElementById('deepseek-model'),
    },
    gemini: {
      apiKey: document.getElementById('gemini-api-key'),
      model: document.getElementById('gemini-model'),
    },
    gpt: {
      apiKey: document.getElementById('gpt-api-key'),
      model: document.getElementById('gpt-model'),
      baseUrl: document.getElementById('gpt-base-url'),
    },
  };

  const providerRadios = Array.from(document.querySelectorAll('input[name="provider"]'));
  const providerOptions = Array.from(document.querySelectorAll('.provider-option'));

  function currentProvider() {
    const checked = document.querySelector('input[name="provider"]:checked');
    return checked ? checked.value : 'youdao';
  }

  function syncProviderUI() {
    const p = currentProvider();
    providerOptions.forEach((opt) => {
      const radio = opt.querySelector('input[name="provider"]');
      opt.classList.toggle('active', radio && radio.value === p);
    });
  }

  providerRadios.forEach((r) => r.addEventListener('change', syncProviderUI));

  function showConfigMsg(text, ok) {
    configMsgEl.textContent = text;
    configMsgEl.className = 'config-msg ' + (ok ? 'ok' : 'err');
  }

  // 汇总当前表单中的全部接口配置。
  function collectProviderConfig() {
    return {
      provider: currentProvider(),
      youdao: {
        appKey: providerInputs.youdao.appKey.value.trim(),
        appSecret: providerInputs.youdao.appSecret.value.trim(),
      },
      baidu: {
        appId: providerInputs.baidu.appId.value.trim(),
        secret: providerInputs.baidu.secret.value.trim(),
      },
      google: {
        apiKey: providerInputs.google.apiKey.value.trim(),
      },
      caiyun: {
        token: providerInputs.caiyun.token.value.trim(),
      },
      deepseek: {
        apiKey: providerInputs.deepseek.apiKey.value.trim(),
        model: providerInputs.deepseek.model.value.trim(),
      },
      gemini: {
        apiKey: providerInputs.gemini.apiKey.value.trim(),
        model: providerInputs.gemini.model.value.trim(),
      },
      gpt: {
        apiKey: providerInputs.gpt.apiKey.value.trim(),
        model: providerInputs.gpt.model.value.trim(),
        baseUrl: providerInputs.gpt.baseUrl.value.trim(),
      },
    };
  }

  // 校验当前所选接口是否已填齐必需字段。
  function currentProviderReady(cfg) {
    const p = cfg.provider;
    if (p === 'youdao') return !!(cfg.youdao.appKey && cfg.youdao.appSecret);
    if (p === 'baidu') return !!(cfg.baidu.appId && cfg.baidu.secret);
    if (p === 'google') return !!cfg.google.apiKey;
    if (p === 'caiyun') return !!cfg.caiyun.token;
    if (p === 'deepseek') return !!cfg.deepseek.apiKey;
    if (p === 'gemini') return !!cfg.gemini.apiKey;
    if (p === 'gpt') return !!cfg.gpt.apiKey;
    return false;
  }

  chrome.storage.local.get('config').then(({ config }) => {
    if (!config) {
      syncProviderUI();
      return;
    }
    const p = config.provider || 'youdao';
    const radio = document.querySelector('input[name="provider"][value="' + p + '"]');
    if (radio) radio.checked = true;

    // 有道兼容旧版扁平字段 { appKey, appSecret }。
    const youdao = config.youdao || { appKey: config.appKey, appSecret: config.appSecret };
    providerInputs.youdao.appKey.value = youdao.appKey || '';
    providerInputs.youdao.appSecret.value = youdao.appSecret || '';

    if (config.baidu) {
      providerInputs.baidu.appId.value = config.baidu.appId || '';
      providerInputs.baidu.secret.value = config.baidu.secret || '';
    }
    if (config.google) {
      providerInputs.google.apiKey.value = config.google.apiKey || '';
    }
    if (config.caiyun) {
      providerInputs.caiyun.token.value = config.caiyun.token || '';
    }
    if (config.deepseek) {
      providerInputs.deepseek.apiKey.value = config.deepseek.apiKey || '';
      providerInputs.deepseek.model.value = config.deepseek.model || '';
    }
    if (config.gemini) {
      providerInputs.gemini.apiKey.value = config.gemini.apiKey || '';
      providerInputs.gemini.model.value = config.gemini.model || '';
    }
    if (config.gpt) {
      providerInputs.gpt.apiKey.value = config.gpt.apiKey || '';
      providerInputs.gpt.model.value = config.gpt.model || '';
      providerInputs.gpt.baseUrl.value = config.gpt.baseUrl || '';
    }
    shortcutEl.value = config.shortcut || 'Alt+T';
    syncProviderUI();
  });

  document.getElementById('save-config').addEventListener('click', async () => {
    const cfg = collectProviderConfig();
    if (!currentProviderReady(cfg)) {
      showConfigMsg('请先填写当前所选接口的密钥', false);
      return;
    }
    const cur = await chrome.storage.local.get('config');
    const config = Object.assign({}, cur.config, cfg);
    await chrome.storage.local.set({ config });
    showConfigMsg('保存成功（当前接口：' + cfg.provider + '）', true);
  });

  document.getElementById('test-config').addEventListener('click', async () => {
    const cfg = collectProviderConfig();
    if (!currentProviderReady(cfg)) {
      showConfigMsg('请先填写当前所选接口的密钥', false);
      return;
    }
    // 先落库，确保 background 读取到最新配置再测试。
    const cur = await chrome.storage.local.get('config');
    await chrome.storage.local.set({ config: Object.assign({}, cur.config, cfg) });
    showConfigMsg('测试中（' + cfg.provider + '）…', true);

    chrome.runtime.sendMessage({ type: 'testProvider', text: 'hello' }, (res) => {
      if (chrome.runtime.lastError) {
        showConfigMsg('测试失败：' + chrome.runtime.lastError.message, false);
        return;
      }
      if (res && res.ok) {
        showConfigMsg('测试成功：hello → ' + res.translation, true);
      } else {
        showConfigMsg('测试失败：' + ((res && res.message) || '未知错误'), false);
      }
    });
  });

  document.getElementById('save-shortcut').addEventListener('click', async () => {
    let value = shortcutEl.value.trim().replace(/\s/g, '');
    if (!value) {
      shortcutMsgEl.textContent = '请输入快捷键，例如 Alt+T';
      shortcutMsgEl.className = 'config-msg err';
      return;
    }
    // 简单校验：以字母或数字结尾，且必须包含至少一个修饰键，避免干扰正常输入。
    if (!/[a-z0-9]$/i.test(value)) {
      shortcutMsgEl.textContent = '快捷键需以字母或数字结尾，例如 Alt+T 或 Ctrl+Shift+T';
      shortcutMsgEl.className = 'config-msg err';
      return;
    }
    if (!/(ctrl|control|alt|shift|cmd|meta|win)/i.test(value)) {
      shortcutMsgEl.textContent = '快捷键需包含修饰键（Ctrl / Alt / Shift / Cmd），例如 Alt+T';
      shortcutMsgEl.className = 'config-msg err';
      return;
    }
    const cur = await chrome.storage.local.get('config');
    const config = Object.assign({}, cur.config, { shortcut: value });
    await chrome.storage.local.set({ config });
    shortcutMsgEl.textContent = '保存成功（' + value + '）';
    shortcutMsgEl.className = 'config-msg ok';
  });

  /* ---------- 个性化设置（主题色 / 暗黑模式 / 中英文字体 / 悬浮窗字体） ---------- */

  const themeColorInput = document.getElementById('theme-color');
  const darkModeInput = document.getElementById('dark-mode');
  const highlightWebInput = document.getElementById('highlight-web');
  const highlightExtInput = document.getElementById('highlight-ext');
  const previewHighlightWeb = document.getElementById('preview-highlight-web');
  const previewHighlightExt = document.getElementById('preview-highlight-ext');
  const cnFontSelect = document.getElementById('cn-font');
  const enFontSelect = document.getElementById('en-font');
  const popupFontSelect = document.getElementById('popup-font');
  const popupFontSizeInput = document.getElementById('popup-font-size');
  const fontSizeInput = document.getElementById('base-font-size');
  const previewPopupEl = document.getElementById('preview-popup');
  const bookColorsEl = document.getElementById('book-colors');
  const toggleColorInput = document.getElementById('toggle-color');
  const toggleColorFollowInput = document.getElementById('toggle-color-follow');
  const toggleOpacityInput = document.getElementById('toggle-opacity');
  const toggleOpacityValue = document.getElementById('toggle-opacity-value');
  const pageMarginInput = document.getElementById('margin-settings-value');
  const pageMarginValueLabel = document.getElementById('margin-settings-value-label');

  const DEFAULT_APPEARANCE = {
    accent: '#2563eb',
    dark: false,
    fontSize: 16,
    cnFont: 'default',
    enFont: 'default',
    popupFont: 'default',
    popupFontSize: 14,
    highlightWeb: '#fff3b0',
    highlightExt: '#fff3b0',
    bookColors: {},
    maxFlipCards: 3,
    // 网页右侧圆形按钮颜色（空串 = 跟随主题色）与透明度。
    toggleColor: '',
    toggleOpacity: 0.72,
    // 四个内容页面的左右页边距（px），到屏幕边缘的距离。
    pageMargin: 28,
  };

  // 预设词书默认高亮颜色，未单独设置时与网页高亮色一致。
  const DEFAULT_BOOK_COLOR = '#fff3b0';

  const FONT_FALLBACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif";

  // 中文字体与英文字体的默认候选列表（未扫描本地字体时使用）。
  const CN_FONT_OPTIONS = [
    { value: 'default', label: '系统默认' },
    { value: 'Microsoft YaHei', label: '微软雅黑' },
    { value: 'PingFang SC', label: '苹方' },
    { value: 'SimSun', label: '宋体' },
    { value: 'SimHei', label: '黑体' },
    { value: 'KaiTi', label: '楷体' },
    { value: 'FangSong', label: '仿宋' },
    { value: 'Microsoft JhengHei', label: '微软正黑体' },
    { value: 'Noto Sans SC', label: '思源黑体' },
    { value: 'Noto Serif SC', label: '思源宋体' },
  ];

  const EN_FONT_OPTIONS = [
    { value: 'default', label: '系统默认' },
    { value: 'Arial', label: 'Arial' },
    { value: 'Helvetica', label: 'Helvetica' },
    { value: 'Georgia', label: 'Georgia' },
    { value: 'Times New Roman', label: 'Times New Roman' },
    { value: 'Verdana', label: 'Verdana' },
    { value: 'Tahoma', label: 'Tahoma' },
    { value: 'Trebuchet MS', label: 'Trebuchet MS' },
    { value: 'Courier New', label: 'Courier New' },
  ];

  function fillSelect(select, options) {
    select.innerHTML = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      select.appendChild(opt);
    }
  }

  function initFontSelects() {
    fillSelect(cnFontSelect, CN_FONT_OPTIONS);
    fillSelect(enFontSelect, EN_FONT_OPTIONS);
    fillSelect(popupFontSelect, CN_FONT_OPTIONS.concat(EN_FONT_OPTIONS.slice(1)));
  }

  // 把字体名转成 CSS font-family 片段；系统默认返回空串。
  function fontPart(name) {
    if (!name || name === 'default' || name === 'system') return '';
    return '"' + String(name).replace(/"/g, '\\"') + '", ';
  }

  // 界面字体 = 英文字体优先（拉丁字符用英文），中文回退到中文字体。
  function buildInterfaceFont(a) {
    return fontPart(a.enFont) + fontPart(a.cnFont) + FONT_FALLBACK;
  }

  function buildPopupFont(a) {
    return fontPart(a.popupFont) + FONT_FALLBACK;
  }

  function applyAppearance(a) {
    const root = document.documentElement;
    root.style.setProperty('--accent', a.accent || DEFAULT_APPEARANCE.accent);
    root.style.setProperty('--base-font-size', (a.fontSize || DEFAULT_APPEARANCE.fontSize) + 'px');
    root.style.setProperty('--font-family', buildInterfaceFont(a));
    // 四个内容页面的左右页边距（到屏幕边缘的距离）。
    root.style.setProperty('--page-margin', (a.pageMargin != null ? a.pageMargin : DEFAULT_APPEARANCE.pageMargin) + 'px');
    // 扩展页面内部的高亮色（例句/卡片中的高亮词），独立于网页高亮色。
    // 写在 body 内联上，覆盖 body.dark 中的默认高亮色，确保暗黑模式下也实时跟随用户选择。
    const extHighlight = a.highlightExt || DEFAULT_APPEARANCE.highlightExt;
    root.style.setProperty('--highlight-bg', extHighlight);
    document.body.style.setProperty('--highlight-bg', extHighlight);
    document.body.classList.toggle('dark', !!a.dark);
    // 预览卡片中的悬浮窗部分，实时跟随悬浮窗字体/字号。
    previewPopupEl.style.fontFamily = buildPopupFont(a);
    previewPopupEl.style.fontSize = (a.popupFontSize || DEFAULT_APPEARANCE.popupFontSize) + 'px';
    // 高亮色实时预览：网页 / 扩展两处独立展示。
    previewHighlightWeb.style.backgroundColor = a.highlightWeb || DEFAULT_APPEARANCE.highlightWeb;
    previewHighlightExt.style.backgroundColor = a.highlightExt || DEFAULT_APPEARANCE.highlightExt;
    // 右侧按钮「跟随主题色」时，颜色选择器实时显示当前主题色。
    if (toggleColorFollowInput.checked) {
      toggleColorInput.value = a.accent || DEFAULT_APPEARANCE.accent;
    }
  }

  function clampInt(n, min, max, fallback) {
    n = parseInt(n, 10);
    return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
  }

  function clampFloat(n, min, max, fallback) {
    n = parseFloat(n);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function currentAppearance() {
    return {
      accent: themeColorInput.value || DEFAULT_APPEARANCE.accent,
      dark: darkModeInput.checked,
      cnFont: cnFontSelect.value,
      enFont: enFontSelect.value,
      popupFont: popupFontSelect.value,
      fontSize: clampInt(fontSizeInput.value, 12, 22, DEFAULT_APPEARANCE.fontSize),
      popupFontSize: clampInt(popupFontSizeInput.value, 12, 24, DEFAULT_APPEARANCE.popupFontSize),
      highlightWeb: highlightWebInput.value || DEFAULT_APPEARANCE.highlightWeb,
      highlightExt: highlightExtInput.value || DEFAULT_APPEARANCE.highlightExt,
      bookColors: Object.assign({}, bookColors),
      maxFlipCards: clampInt(maxFlipCards, 1, 20, DEFAULT_APPEARANCE.maxFlipCards),
      toggleColor: toggleColorFollowInput.checked ? '' : (toggleColorInput.value || DEFAULT_APPEARANCE.accent),
      toggleOpacity: clampFloat(toggleOpacityInput.value, 0.1, 1, DEFAULT_APPEARANCE.toggleOpacity),
      pageMargin: clampInt(pageMarginInput.value, 0, 200, DEFAULT_APPEARANCE.pageMargin),
    };
  }

  function saveAppearance() {
    const a = currentAppearance();
    applyAppearance(a);
    chrome.storage.local.set({ appearance: a });
  }

  // 「右侧按钮颜色」跟随主题色时，禁用颜色选择器并同步显示当前主题色。
  function syncToggleColorUI() {
    const follow = toggleColorFollowInput.checked;
    toggleColorInput.disabled = follow;
    if (follow) toggleColorInput.value = themeColorInput.value || DEFAULT_APPEARANCE.accent;
  }

  // 保存的字体若不在当前下拉框中（如扫描出的本地字体），补充进去避免选中丢失。
  function ensureFontOption(select, name) {
    if (!name || name === 'default' || name === 'system') return;
    if (Array.from(select.options).some((o) => o.value === name)) return;
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }

  function loadAppearance() {
    return chrome.storage.local.get('appearance').then(({ appearance }) => {
      const a = Object.assign({}, DEFAULT_APPEARANCE, appearance || {});
      bookColors = Object.assign({}, a.bookColors || {});
      maxFlipCards = clampInt(a.maxFlipCards, 1, 20, DEFAULT_APPEARANCE.maxFlipCards);
      themeColorInput.value = a.accent || DEFAULT_APPEARANCE.accent;
      darkModeInput.checked = !!a.dark;
      fontSizeInput.value = a.fontSize || DEFAULT_APPEARANCE.fontSize;
      popupFontSizeInput.value = a.popupFontSize || DEFAULT_APPEARANCE.popupFontSize;
      highlightWebInput.value = a.highlightWeb || DEFAULT_APPEARANCE.highlightWeb;
      highlightExtInput.value = a.highlightExt || DEFAULT_APPEARANCE.highlightExt;
      toggleColorFollowInput.checked = !a.toggleColor;
      toggleColorInput.value = a.toggleColor || a.accent || DEFAULT_APPEARANCE.accent;
      syncToggleColorUI();
      toggleOpacityInput.value = a.toggleOpacity != null ? a.toggleOpacity : DEFAULT_APPEARANCE.toggleOpacity;
      toggleOpacityValue.textContent = toggleOpacityInput.value;
      pageMarginInput.value = a.pageMargin != null ? a.pageMargin : DEFAULT_APPEARANCE.pageMargin;
      pageMarginValueLabel.textContent = pageMarginInput.value + 'px';
      cnFontSelect.value = a.cnFont || 'default';
      enFontSelect.value = a.enFont || 'default';
      popupFontSelect.value = a.popupFont || 'default';
      ensureFontOption(cnFontSelect, a.cnFont);
      ensureFontOption(enFontSelect, a.enFont);
      ensureFontOption(popupFontSelect, a.popupFont);
      applyAppearance(a);
    });
  }

  // 渲染每本已导入词书的高亮颜色选择器（保存到 appearance.bookColors）。
  function renderBookColors() {
    bookColorsEl.innerHTML = '';
    const books = PRESET_SOURCES.filter((s) => importedPresetIds.has(s.id));
    if (!books.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = '尚未导入预设词书。';
      bookColorsEl.appendChild(empty);
      return;
    }
    for (const b of books) {
      const row = document.createElement('div');
      row.className = 'book-color-row';

      const label = document.createElement('span');
      label.className = 'book-color-name';
      label.textContent = shortBookName(b.name);
      label.title = b.name;
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'color-input';
      input.value = bookColors[b.id] || DEFAULT_BOOK_COLOR;
      input.addEventListener('input', () => {
        bookColors[b.id] = input.value;
        saveAppearance();
      });
      row.appendChild(input);

      bookColorsEl.appendChild(row);
    }
  }

  initFontSelects();

  themeColorInput.addEventListener('input', saveAppearance);
  darkModeInput.addEventListener('change', saveAppearance);
  highlightWebInput.addEventListener('input', saveAppearance);
  highlightExtInput.addEventListener('input', saveAppearance);
  fontSizeInput.addEventListener('input', saveAppearance);
  cnFontSelect.addEventListener('change', saveAppearance);
  enFontSelect.addEventListener('change', saveAppearance);
  popupFontSelect.addEventListener('change', saveAppearance);
  popupFontSizeInput.addEventListener('input', saveAppearance);
  toggleColorInput.addEventListener('input', saveAppearance);
  toggleColorFollowInput.addEventListener('change', () => {
    syncToggleColorUI();
    saveAppearance();
  });
  toggleOpacityInput.addEventListener('input', () => {
    const o = clampFloat(toggleOpacityInput.value, 0.1, 1, DEFAULT_APPEARANCE.toggleOpacity);
    toggleOpacityInput.value = o;
    toggleOpacityValue.textContent = String(o);
    saveAppearance();
  });
  pageMarginInput.addEventListener('input', () => {
    const n = clampInt(pageMarginInput.value, 0, 200, DEFAULT_APPEARANCE.pageMargin);
    pageMarginInput.value = n;
    pageMarginValueLabel.textContent = n + 'px';
    saveAppearance();
  });

  /* ---------- 页边距设置弹窗 ---------- */

  const marginSettingsModal = document.getElementById('margin-settings-modal');
  const marginSettingsClose = document.getElementById('margin-settings-close');

  function openMarginSettings() {
    // 打开时同步一次当前值，确保滑杆与已保存的边距一致。
    pageMarginInput.value = clampInt(pageMarginInput.value, 0, 200, DEFAULT_APPEARANCE.pageMargin);
    pageMarginValueLabel.textContent = pageMarginInput.value + 'px';
    marginSettingsModal.classList.remove('hidden');
  }

  function closeMarginSettings() {
    marginSettingsModal.classList.add('hidden');
  }

  // 齿轮设置菜单：填充齿轮图标，点击展开/收起；菜单项按当前页面动态生成。
  const settingsMenu = document.getElementById('settings-menu');

  function settingsMenuItems() {
    const items = [{ action: 'margin', label: '页边距设置' }];
    // 网格视图下提供「每行卡片数 / 翻转卡片数」设置入口。
    if ((currentTab === 'list' && wordGridView) || (currentTab === 'memorized' && memorizedGridView)) {
      items.push({ action: 'grid', label: '网格视图设置' });
    }
    // 生词本页面提供清空入口（仅用户自有词书）。
    if (currentTab === 'list' && currentBook === 'own') {
      items.push({ action: 'clear', label: '清空生词本' });
    }
    return items;
  }

  function renderSettingsMenu() {
    settingsMenu.innerHTML = '';
    for (const it of settingsMenuItems()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-menu-item';
      btn.dataset.action = it.action;
      btn.textContent = it.label;
      if (it.action === 'clear') btn.classList.add('danger');
      settingsMenu.appendChild(btn);
    }
  }

  document.querySelectorAll('.settings-menu-btn').forEach((btn) => {
    btn.innerHTML = GEAR_ICON_SVG;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !settingsMenu.classList.contains('hidden');
      settingsMenu.classList.add('hidden');
      if (isOpen) return;
      renderSettingsMenu();
      const rect = btn.getBoundingClientRect();
      settingsMenu.classList.remove('hidden');
      const menuW = settingsMenu.offsetWidth || 160;
      let left = rect.right - menuW;
      if (left < 8) left = 8;
      settingsMenu.style.top = (rect.bottom + 6) + 'px';
      settingsMenu.style.left = left + 'px';
    });
  });
  settingsMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.settings-menu-item');
    if (!item) return;
    settingsMenu.classList.add('hidden');
    const action = item.dataset.action;
    if (action === 'margin') openMarginSettings();
    else if (action === 'grid') openGridSettings(currentTab === 'list' ? 'word' : 'memorized');
    else if (action === 'clear') clearAllWords();
  });
  // 点击菜单外部时收起。
  document.addEventListener('click', (e) => {
    if (settingsMenu.classList.contains('hidden')) return;
    if (e.target.closest('.settings-menu-btn') || e.target.closest('.settings-menu')) return;
    settingsMenu.classList.add('hidden');
  });
  marginSettingsClose.addEventListener('click', closeMarginSettings);
  marginSettingsModal.addEventListener('click', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.closeMarginSettings !== undefined) {
      closeMarginSettings();
    }
  });

  /* ---------- 教程页：示例英文段落双击试词（仅演示高亮与翻译，不计入生词本） ---------- */
  const tutorialDemoTextEl = document.getElementById('tutorial-demo-text');

  function tutorialEscapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let tutorialPopupEl = null;
  function removeTutorialPopup() {
    if (tutorialPopupEl) {
      tutorialPopupEl.remove();
      tutorialPopupEl = null;
    }
  }

  function showTutorialPopup(anchor, data) {
    removeTutorialPopup();
    tutorialPopupEl = document.createElement('div');
    tutorialPopupEl.className = 'tutorial-popup';
    const word = data.lemma || data.word;
    const wordForm = data.word && data.lemma && data.word.toLowerCase() !== data.lemma.toLowerCase()
      ? tutorialEscapeHtml(data.word) + ' → ' : '';

    if (data.loading) {
      tutorialPopupEl.innerHTML =
        '<div class="tutorial-popup-word">' + wordForm + tutorialEscapeHtml(word) + '</div>' +
        '<div class="tutorial-popup-meta">查询中…</div>';
    } else if (data.error) {
      tutorialPopupEl.innerHTML =
        '<div class="tutorial-popup-word">' + wordForm + tutorialEscapeHtml(word) + '</div>' +
        '<div class="tutorial-popup-error">' + tutorialEscapeHtml(data.error) + '</div>';
    } else if (data.removed) {
      tutorialPopupEl.innerHTML =
        '<div class="tutorial-popup-word">' + tutorialEscapeHtml(word) + '</div>' +
        '<div class="tutorial-popup-meta">已取消高亮</div>';
    } else {
      tutorialPopupEl.innerHTML =
        '<div class="tutorial-popup-word">' + wordForm + tutorialEscapeHtml(word) +
        (data.phonetic ? ' <span class="tutorial-popup-phonetic">' + tutorialEscapeHtml(data.phonetic) + '</span>' : '') +
        '</div>' +
        (data.translation ? '<div class="tutorial-popup-trans">' + tutorialEscapeHtml(data.translation).replace(/\n/g, '<br>') + '</div>' : '') +
        '<div class="tutorial-popup-meta">演示模式 · 不计入生词本</div>';
      const wordEl = tutorialPopupEl.querySelector('.tutorial-popup-word');
      if (wordEl) wordEl.appendChild(LV_TTS.speakerButton(word));
    }

    document.body.appendChild(tutorialPopupEl);
    const rect = anchor.getBoundingClientRect();
    const box = tutorialPopupEl.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + box.width > window.innerWidth - 10) left = Math.max(10, window.innerWidth - 10 - box.width);
    if (top + box.height > window.innerHeight - 10) top = Math.max(10, rect.top - box.height - 6);
    tutorialPopupEl.style.left = left + 'px';
    tutorialPopupEl.style.top = top + 'px';
  }

  if (tutorialDemoTextEl) {
    tutorialDemoTextEl.addEventListener('dblclick', async (event) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const text = selection.toString().trim();
      const WORD_RE = /^[a-zA-Z][a-zA-Z'’-]*$/;
      if (!text || text.length > 40 || !WORD_RE.test(text)) return;

      // 若双击的词已经高亮，则取消高亮（演示模式的「双击取消高亮」）。
      const selRange = selection.getRangeAt(0);
      let hlNode = selRange.startContainer;
      if (hlNode.nodeType === Node.TEXT_NODE) hlNode = hlNode.parentElement;
      const existingHl = hlNode && hlNode.closest ? hlNode.closest('.tutorial-hl') : null;
      if (existingHl) {
        const word = existingHl.textContent;
        const rect = existingHl.getBoundingClientRect();
        const parent = existingHl.parentNode;
        if (parent) parent.replaceChild(document.createTextNode(word), existingHl);
        removeTutorialPopup();
        showTutorialPopup({ getBoundingClientRect: () => rect }, { word, removed: true });
        return;
      }

      // 高亮所双击的词（仅视觉提示，不写入生词本）。
      let anchor = event.target;
      try {
        const range = selection.getRangeAt(0);
        const span = document.createElement('span');
        span.className = 'tutorial-hl';
        range.surroundContents(span);
        anchor = span;
      } catch (e) {
        // 选区跨节点时忽略高亮包裹，仅弹出释义。
      }

      const surface = text;
      showTutorialPopup(anchor, { word: surface, loading: true });

      // 词形还原：结合候选原型 + 本地词典确认。
      let lemma = surface.toLowerCase();
      try {
        const candFn = LV_LEMMATIZER.lemmatizeCandidates || (() => []);
        const candidates = candFn(surface);
        if (candidates.length === 1) {
          lemma = candidates[0].toLowerCase();
        } else if (candidates.length > 1) {
          for (const c of candidates) {
            const hit = await dictLookup(c);
            if (hit) { lemma = c.toLowerCase(); break; }
          }
        }
      } catch (e) {
        // 词形还原失败则使用原词。
      }

      try {
        const res = await bgMessage({ type: 'translate', text: lemma });
        if (res && res.ok) {
          showTutorialPopup(anchor, { word: surface, lemma, phonetic: res.phonetic, translation: res.translation });
          LV_TTS.speak(lemma);
        } else {
          showTutorialPopup(anchor, { word: surface, lemma, error: (res && res.message) || '翻译失败' });
        }
      } catch (err) {
        showTutorialPopup(anchor, { word: surface, lemma, error: '翻译失败' });
      }
    });
  }

  // 点击弹窗外部时关闭教程试词弹窗。
  document.addEventListener('click', (e) => {
    if (tutorialPopupEl && !tutorialPopupEl.contains(e.target)) removeTutorialPopup();
  });

  /* ---------- 词典下载 / 本地载入 / 清理 ---------- */

  const dictStatusEl = document.getElementById('dict-status');
  const loadDictBtn = document.getElementById('load-dict');
  const loadDictLocalBtn = document.getElementById('load-dict-local');
  const dictFileEl = document.getElementById('dict-file');
  const supplementDictUrlEl = document.getElementById('supplement-dict-url');
  const loadSupplementDictBtn = document.getElementById('load-supplement-dict');
  const loadSupplementDictLocalBtn = document.getElementById('load-supplement-dict-local');
  const supplementDictFileEl = document.getElementById('supplement-dict-file');
  const dictProgressWrap = document.getElementById('dict-progress-wrap');
  const dictProgressFill = document.getElementById('dict-progress-fill');
  const dictProgressText = document.getElementById('dict-progress-text');
  const dictErrorEl = document.getElementById('dict-error');
  const dictErrorText = document.getElementById('dict-error-text');
  const copyDictErrorBtn = document.getElementById('copy-dict-error');
  const presetListEl = document.getElementById('preset-list');
  const customDictListEl = document.getElementById('custom-dict-list');
  const dictOrderListEl = document.getElementById('dict-order-list');
  const settingsNavEl = document.getElementById('settings-nav');
  const settingsPanelEl = document.getElementById('tab-settings');
  const settingsCardsEl = document.getElementById('settings-cards');
  const presetEnrichStatusEl = document.getElementById('preset-enrich-status');
  const loadMdxBtn = document.getElementById('load-mdx');
  const mdxFileEl = document.getElementById('mdx-file');
  const mdxProgressWrap = document.getElementById('mdx-progress-wrap');
  const mdxProgressFill = document.getElementById('mdx-progress-fill');
  const mdxProgressText = document.getElementById('mdx-progress-text');
  const refreshWordDefsBtn = document.getElementById('refresh-word-defs');
  const refreshWordDefsStatus = document.getElementById('refresh-word-defs-status');
  const mddFileEl = document.getElementById('mdd-file');
  const mddProgressWrap = document.getElementById('mdd-progress-wrap');
  const mddProgressFill = document.getElementById('mdd-progress-fill');
  const mddProgressText = document.getElementById('mdd-progress-text');
  const presetErrorEl = document.getElementById('preset-error');
  const mdxErrorEl = document.getElementById('mdx-error');
  const mddErrorEl = document.getElementById('mdd-error');
  // 用户点击某份词典的「导入 .mdd」时，记录其目标词典 id（每份 .mdx 对应自己的 .mdd）。
  let pendingMddDictId = null;

  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function setDictProgress(percent, text) {
    dictProgressWrap.classList.remove('hidden');
    dictProgressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    dictProgressText.textContent = text;
  }

  function hideDictProgress() {
    dictProgressWrap.classList.add('hidden');
    dictProgressFill.style.width = '0';
    dictProgressText.textContent = '';
  }

  function showDictError(message) {
    dictErrorEl.classList.remove('hidden');
    dictErrorText.value = message;
  }

  function hideDictError() {
    dictErrorEl.classList.add('hidden');
    dictErrorText.value = '';
  }

  // 在指定操作下方显示行内错误信息（用于 .mdx/.mdd/预设词书导入，避免错误跑到 ECDICT 区域）。
  function showInlineError(el, message) {
    el.textContent = message;
    el.className = 'config-msg err';
    el.classList.remove('hidden');
  }

  function hideInlineError(el) {
    el.textContent = '';
    el.className = 'config-msg';
    el.classList.add('hidden');
  }

  /* ---------- 设置页导航与模块排序 ---------- */

  // 读取设置模块顺序；缺失项补到末尾，未知项过滤。
  function loadSettingsOrder() {
    return chrome.storage.local.get('settingsOrder').then(({ settingsOrder: saved }) => {
      const list = Array.isArray(saved) && saved.length ? saved : DEFAULT_SETTINGS_ORDER;
      const seen = new Set();
      const next = [];
      for (const id of list) {
        if (!seen.has(id) && DEFAULT_SETTINGS_ORDER.includes(id)) {
          next.push(id);
          seen.add(id);
        }
      }
      for (const id of DEFAULT_SETTINGS_ORDER) {
        if (!seen.has(id)) next.push(id);
      }
      settingsOrder = next;
    });
  }

  function saveSettingsOrder() {
    return chrome.storage.local.set({ settingsOrder: settingsOrder });
  }

  function settingsCardEl(id) {
    return settingsPanelEl.querySelector('.settings-card[data-setting="' + id + '"]');
  }

  function settingsTitle(id) {
    const card = settingsCardEl(id);
    if (!card) return id;
    const h = card.querySelector('h2');
    return h ? h.textContent : id;
  }

  // 按 settingsOrder 重排设置卡片：依次把卡片移到卡片容器末尾，导航容器保持最前。
  function applySettingsOrder() {
    for (const id of settingsOrder) {
      const card = settingsCardEl(id);
      if (card) settingsCardsEl.appendChild(card);
    }
  }

  // 渲染设置导航：每行 = 拖拽手柄 + 标题按钮（点击定位），支持拖拽调整模块顺序。
  function renderSettingsNav() {
    settingsNavEl.innerHTML = '';
    settingsOrder.forEach((id, idx) => {
      const row = document.createElement('div');
      row.className = 'settings-nav-row';
      row.draggable = true;
      row.dataset.index = idx;

      const handle = document.createElement('span');
      handle.className = 'settings-nav-handle';
      handle.textContent = '⠿';
      handle.title = '拖拽调整顺序';
      row.appendChild(handle);

      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'settings-nav-link';
      link.textContent = settingsTitle(id);
      link.addEventListener('click', () => {
        const card = settingsCardEl(id);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      row.appendChild(link);

      row.addEventListener('dragstart', (e) => {
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        settingsNavEl.querySelectorAll('.settings-nav-row').forEach((r) => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!Number.isInteger(fromIdx) || fromIdx === idx) return;
        reorderSettingsNav(fromIdx, idx);
      });

      settingsNavEl.appendChild(row);
    });
  }

  // 拖拽后把 fromIdx 的模块移动到 toIdx 位置并持久化。
  function reorderSettingsNav(fromIdx, toIdx) {
    if (fromIdx < 0 || fromIdx >= settingsOrder.length) return;
    if (toIdx < 0 || toIdx >= settingsOrder.length || fromIdx === toIdx) return;
    const next = settingsOrder.slice();
    const moved = next.splice(fromIdx, 1)[0];
    next.splice(toIdx, 0, moved);
    settingsOrder = next;
    saveSettingsOrder();
    applySettingsOrder();
    renderSettingsNav();
  }

  function refreshDictStatus() {
    chrome.runtime.sendMessage({ type: 'dictStatus' }, (res) => {
      if (res && res.ok) {
        ecdictCount = res.dictCount || 0;
        dictStatusEl.textContent =
          '完整词典：' + res.dictCount + ' 词条；查询缓存：' + res.cacheCount + ' 条。';
        renderPresetList(res.presets || []);
        renderCustomDictList(res.customDicts || []);
        renderDictOrder(res.dictOrder || [], res.customDicts || []);
        // 例句补充进度持久展示，刷新后仍能看到剩余数量。
        const es = res.exampleStats;
        if (es && es.total > 0) {
          presetEnrichStatusEl.textContent =
            '例句：已补充 ' + es.done + ' / ' + es.total + ' 个（剩余 ' + es.remaining + ' 个）';
        } else {
          presetEnrichStatusEl.textContent = '';
        }
      } else {
        dictStatusEl.textContent = '词典状态获取失败。';
      }
    });
  }

  // 统一词典查询优先级：内置精简词典 / 完整 ECDICT / 各自定义词典同列表排序（预设词表不参与）。
  function dictSourceName(id, customDicts) {
    if (id === 'builtin') return '内置精简词典';
    if (id === 'ecdict') return '完整 ECDICT 词典';
    if (id.indexOf('custom:') === 0) {
      const did = id.slice('custom:'.length);
      const d = (customDicts || []).find((x) => x.id === did);
      return '自定义：' + (d ? (d.title || '未命名词典') : did);
    }
    return id;
  }

  function renderDictOrder(order, customDicts) {
    dictOrderListEl.innerHTML = '';
    // 预设词表（preset）是词书而非词典，从排序列表中剔除。
    const dictSources = (order || []).filter((id) => id !== 'preset');
    if (!dictSources.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = '暂无可用词典。';
      dictOrderListEl.appendChild(empty);
      return;
    }
    dictSources.forEach((id, idx) => {
      const row = document.createElement('div');
      row.className = 'dict-order-row';

      const name = document.createElement('span');
      name.className = 'dict-order-name';
      name.textContent = dictSourceName(id, customDicts);
      row.appendChild(name);

      const up = document.createElement('button');
      up.className = 'btn icon-btn';
      up.textContent = '↑';
      up.title = '上移（优先级更高）';
      up.disabled = idx === 0;
      up.addEventListener('click', () => moveDictOrder(idx, idx - 1));
      row.appendChild(up);

      const down = document.createElement('button');
      down.className = 'btn icon-btn';
      down.textContent = '↓';
      down.title = '下移（优先级更低）';
      down.disabled = idx === dictSources.length - 1;
      down.addEventListener('click', () => moveDictOrder(idx, idx + 1));
      row.appendChild(down);

      dictOrderListEl.appendChild(row);
    });
  }

  async function moveDictOrder(fromIdx, toIdx) {
    const res = await bgMessage({ type: 'dictStatus' });
    if (!res || !res.ok) return;
    const order = (res.dictOrder || []).slice();
    if (toIdx < 0 || toIdx >= order.length) return;
    const tmp = order[fromIdx];
    order[fromIdx] = order[toIdx];
    order[toIdx] = tmp;
    const r2 = await bgMessage({ type: 'reorderDictOrder', ids: order });
    if (r2 && r2.ok) refreshDictStatus();
  }

  // 按当前词典优先级重新查询生词本中所有词的本地释义（词典优先、缓存兜底，不触发翻译 API）。
  // 用于解决「更改词典优先级后，已收入生词本的词释义不随之改变」的问题。
  async function refreshWordDefinitions() {
    const keys = Object.keys(wordsMap);
    if (!keys.length) {
      refreshWordDefsStatus.textContent = '生词本暂无单词。';
      return;
    }
    refreshWordDefsBtn.disabled = true;
    refreshWordDefsStatus.textContent = '正在刷新 ' + keys.length + ' 个词的释义…';
    try {
      const res = await bgMessage({ type: 'refreshWordDefinitions', words: keys });
      if (!res || !res.ok) {
        refreshWordDefsStatus.textContent =
          '刷新失败：' + (res && res.message ? res.message : '未知错误');
        return;
      }
      const updated = res.updated || {};
      let n = 0;
      for (const key of keys) {
        const u = updated[key];
        if (!u) continue;
        const old = wordsMap[key] || {};
        wordsMap[key] = Object.assign({}, old, {
          translation: u.translation,
          phonetic: u.phonetic,
          explains: u.explains,
          senses: u.senses,
          definitions: u.definitions,
          html: u.html || '',
          sourceId: u.sourceId || '',
        });
        n++;
      }
      await saveWords();
      renderAll();
      refreshWordDefsStatus.textContent = '已更新 ' + n + ' / ' + keys.length + ' 个词的释义。';
    } catch (err) {
      refreshWordDefsStatus.textContent = '刷新失败：' + (err && err.message ? err.message : err);
    } finally {
      refreshWordDefsBtn.disabled = false;
    }
  }

  refreshWordDefsBtn.addEventListener('click', refreshWordDefinitions);

  function renderPresetList(presets) {
    presetListEl.innerHTML = '';
    if (!presets.length) {
      presetListEl.textContent = '暂无可用词表。';
      return;
    }
    for (const p of presets) {
      const wrap = document.createElement('div');
      wrap.className = 'preset-item';

      const row = document.createElement('div');
      row.className = 'preset-row';
      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = p.name;
      const count = document.createElement('span');
      count.className = 'preset-count';
      count.textContent = p.count > 0 ? '已导入 ' + p.count + ' 词' : '未导入';
      const btn = document.createElement('button');
      btn.className = 'btn' + (p.count > 0 ? ' danger' : ' primary');
      btn.textContent = p.count > 0 ? '移除' : '添加';
      btn.disabled = presetBusy === p.id;
      btn.addEventListener('click', () => togglePreset(p, btn));
      row.appendChild(name);

      // 附上词表源文件链接，便于下载失败时用户自行打开获取。
      const src = PRESET_SOURCES.find((s) => s.id === p.id);
      if (src && src.url) {
        const link = document.createElement('a');
        link.className = 'preset-link';
        link.href = src.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '源';
        link.title = '打开词表源文件';
        row.appendChild(link);
      }

      row.appendChild(count);
      row.appendChild(btn);
      wrap.appendChild(row);

      // 已导入的词书才显示「剔除高频词和常见词 / 剔除已背单词 / 补充本地释义 / 后台补充例句」四项控件。
      if (p.count > 0) {
        wrap.appendChild(buildPresetControls(p));
      }

      presetListEl.appendChild(wrap);
    }
  }

  function buildPresetControls(p) {
    const box = document.createElement('div');
    box.className = 'preset-filter';
    const f = presetFilters[p.id] || {};

    const common = document.createElement('label');
    common.className = 'preset-filter-label';
    const commonCb = document.createElement('input');
    commonCb.type = 'checkbox';
    commonCb.checked = f.removeCommon !== false;
    commonCb.addEventListener('change', () => setPresetFilter(p.id, 'removeCommon', commonCb.checked));
    common.appendChild(commonCb);
    common.appendChild(document.createTextNode('剔除高频词和常见词'));
    box.appendChild(common);

    const memorized = document.createElement('label');
    memorized.className = 'preset-filter-label';
    const memCb = document.createElement('input');
    memCb.type = 'checkbox';
    memCb.checked = f.removeMemorized !== false;
    memCb.addEventListener('change', () => setPresetFilter(p.id, 'removeMemorized', memCb.checked));
    memorized.appendChild(memCb);
    memorized.appendChild(document.createTextNode('剔除已背单词'));
    box.appendChild(memorized);

    const enrich = document.createElement('label');
    enrich.className = 'preset-filter-label';
    const enrichCb = document.createElement('input');
    enrichCb.type = 'checkbox';
    enrichCb.checked = f.enrichLocal !== false;
    enrichCb.addEventListener('change', () => setPresetFilter(p.id, 'enrichLocal', enrichCb.checked));
    enrich.appendChild(enrichCb);
    enrich.appendChild(document.createTextNode('补充本地释义'));
    box.appendChild(enrich);

    const supplement = document.createElement('label');
    supplement.className = 'preset-filter-label';
    const supplementCb = document.createElement('input');
    supplementCb.type = 'checkbox';
    supplementCb.checked = f.supplementExamples !== false;
    supplementCb.addEventListener('change', () => setPresetFilter(p.id, 'supplementExamples', supplementCb.checked));
    supplement.appendChild(supplementCb);
    supplement.appendChild(document.createTextNode('后台补充例句'));
    box.appendChild(supplement);

    return box;
  }

  // 更新某本词书的过滤选项，并同步刷新词书列表与网页高亮。
  async function setPresetFilter(presetId, key, value) {
    const cur = presetFilters[presetId] || {
      removeCommon: true,
      removeMemorized: true,
      enrichLocal: true,
      supplementExamples: true,
    };
    const next = Object.assign({}, cur, { [key]: !!value });
    presetFilters[presetId] = next;

    const res = await bgMessage({
      type: 'setPresetFilter',
      presetId,
      removeCommon: !!next.removeCommon,
      removeMemorized: !!next.removeMemorized,
      enrichLocal: !!next.enrichLocal,
      supplementExamples: !!next.supplementExamples,
    });
    if (res && res.ok && res.filters) {
      presetFilters = res.filters;
    }
    await refreshPresetWords();
    renderBookSelects();
    renderAll();
    refreshDictStatus();
  }

  // 渲染自定义词典列表：每份词典显示标题、词条数、.mdd 资源导入与移除按钮。
  // 仅当存在 .mdx 词典时才会渲染出 .mdd 导入入口，且每个词典对应自己的 .mdd 资源。
  function renderCustomDictList(customDicts) {
    customDictListEl.innerHTML = '';
    if (!customDicts.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = '尚未导入自定义词典。';
      customDictListEl.appendChild(empty);
      return;
    }
    customDicts.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'custom-dict-row';

      const name = document.createElement('span');
      name.className = 'custom-dict-name';
      name.textContent = d.title || '未命名词典';

      const count = document.createElement('span');
      count.className = 'custom-dict-count';
      count.textContent = d.count + ' 词条';

      const mdd = document.createElement('button');
      mdd.className = 'btn';
      mdd.textContent = '导入 .mdd';
      mdd.title = '为「' + (d.title || '未命名词典') + '」导入配套资源包（样式 / 图片 / 音频）';
      mdd.addEventListener('click', () => {
        pendingMddDictId = d.id;
        mddFileEl.click();
      });

      const remove = document.createElement('button');
      remove.className = 'btn danger';
      remove.textContent = '移除';
      remove.addEventListener('click', () => removeCustomDict(d));

      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(mdd);
      row.appendChild(remove);
      customDictListEl.appendChild(row);
    });
  }

  function removeCustomDict(d) {
    if (!confirm('确定移除自定义词典「' + (d.title || '未命名词典') + '」吗？此操作不可恢复。')) return;
    chrome.runtime.sendMessage({ type: 'removeCustomDict', dictId: d.id }, (res) => {
      if (res && res.ok) {
        refreshDictStatus();
      } else {
        const msg = (res && res.message) || '移除失败';
        showInlineError(mdxErrorEl, '词典移除失败：' + msg);
      }
    });
  }

  let presetBusy = null;

  // 预设词表增删后，重新读取词条并刷新词书下拉框与列表。
  function refreshPresetAndBooks() {
    return refreshPresetWords().then(() => {
      renderBookSelects();
      renderBookColors();
      renderAll();
    });
  }

  function togglePreset(p, btn) {
    if (p.count > 0) {
      if (!confirm('确定移除「' + p.name + '」词表吗？')) return;
      presetBusy = p.id;
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: 'removePreset', presetId: p.id }, () => {
        presetBusy = null;
        refreshPresetAndBooks();
        refreshDictStatus();
      });
    } else {
      presetBusy = p.id;
      btn.disabled = true;
      btn.textContent = '导入中…';
      hideInlineError(presetErrorEl);
      chrome.runtime.sendMessage({ type: 'downloadPreset', presetId: p.id }, (res) => {
        presetBusy = null;
        if (res && res.ok) {
          hideInlineError(presetErrorEl);
          refreshPresetAndBooks();
          refreshDictStatus();
          // 新增词书后自动执行「补充本地释义」与「后台补充例句」（默认开启）。
          runPresetAutoTasks(p.id);
        } else {
          const msg = (res && res.message) || '导入失败';
          showInlineError(presetErrorEl, '词表导入失败：' + msg);
          refreshDictStatus();
        }
      });
    }
  }

  // 用本地 ECDICT 为「指定词书」的预设词条补充结构化释义（音标 / 词性多义 / 英文释义）。
  async function enrichPreset(presetId) {
    presetEnrichStatusEl.textContent = '正在用本地词典补充释义…';
    const res = await bgMessage({ type: 'enrichPresetFromDict', presetId });
    if (res && res.ok) {
      presetEnrichStatusEl.textContent = res.enriched > 0
        ? '已为 ' + res.enriched + ' 个词补充释义'
        : '所有词均已补充释义';
      await refreshPresetAndBooks();
    } else {
      presetEnrichStatusEl.textContent = '补充失败：' + ((res && res.message) || '未知错误');
    }
  }

  // 后台为「指定词书」逐词联网补充例句（免费词典接口，每次 20 个，循环推进直到完成）。
  async function supplementExamplesForPreset(presetId) {
    presetEnrichStatusEl.textContent = '正在后台补充例句…';
    let total = 0;
    let remaining = 0;
    do {
      const res = await bgMessage({ type: 'supplementPresetExamples', limit: 20, presetId });
      if (!res || !res.ok) {
        presetEnrichStatusEl.textContent = '补充失败：' + ((res && res.message) || '未知错误');
        break;
      }
      total += res.processed || 0;
      remaining = res.remaining || 0;
      presetEnrichStatusEl.textContent = remaining > 0
        ? '已补充 ' + total + ' 个，剩余 ' + remaining + ' 个…'
        : '已补充 ' + total + ' 个例句';
    } while (remaining > 0);
    await refreshPresetAndBooks();
    // 用真实进度覆盖「已补充 N 个」，避免显示完成而实际仍有缺例句的词。
    refreshDictStatus();
  }

  // 新增预设词书后自动执行：先补充本地释义，再后台补充例句（后台任务，不阻塞界面）。
  // 仅当对应复选框开启时才执行（默认开启）。
  async function runPresetAutoTasks(presetId) {
    const f = presetFilters[presetId] || {};
    if (f.enrichLocal !== false) {
      try {
        await enrichPreset(presetId);
      } catch (e) {
        // 释义补充失败不阻断例句补充。
      }
    }
    if (f.supplementExamples !== false) {
      try {
        await supplementExamplesForPreset(presetId);
      } catch (e) {
        // 例句补充中断也刷新一次状态，保证界面一致。
        refreshDictStatus();
      }
    }
  }

  // 打开主页时，对已导入的预设词书检测「补充本地释义 / 后台补充例句」是否完成，
  // 未完成则按复选框设置自动补（后台任务，幂等，可重复调用）。
  function autoRunPresetTasksOnOpen() {
    const ids = Array.from(importedPresetIds);
    (async () => {
      for (const id of ids) {
        await runPresetAutoTasks(id);
      }
    })();
  }

  // 接收 background 下载时的进度广播（下载速度 / 解析 / 写入）。
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'loadDictProgress') return;
    if (message.phase === 'download') {
      const total = message.total || 0;
      const loaded = message.loaded || 0;
      const percent = total ? (loaded / total) * 100 : 0;
      const speed = formatBytes(message.speed) + '/s';
      setDictProgress(
        percent,
        total
          ? '下载中 ' + formatBytes(loaded) + ' / ' + formatBytes(total) + ' · ' + speed
          : '下载中 ' + formatBytes(loaded) + ' · ' + speed
      );
    } else if (message.phase === 'parse') {
      setDictProgress(100, '解析中，已解析 ' + (message.rowCount || 0) + ' 条…');
    } else if (message.phase === 'write') {
      const done = message.done || 0;
      const total = message.writeTotal || 0;
      const percent = total ? (done / total) * 100 : 0;
      setDictProgress(
        percent,
        '写入中 ' + done + '/' + total + ' 批 · 共 ' + (message.rowCount || 0) + ' 条…'
      );
    }
  });

  loadDictBtn.addEventListener('click', () => {
    loadDictBtn.disabled = true;
    loadDictLocalBtn.disabled = true;
    hideDictError();
    dictStatusEl.textContent = '';
    setDictProgress(0, '正在连接并下载词典（约 66MB）…');

    chrome.runtime.sendMessage({ type: 'loadDict' }, (res) => {
      loadDictBtn.disabled = false;
      loadDictLocalBtn.disabled = false;
      if (res && res.ok) {
        hideDictProgress();
        dictStatusEl.textContent = '词典加载完成，共 ' + res.count + ' 词条。';
      } else {
        const msg = (res && res.message) || '词典下载失败：未知错误';
        dictStatusEl.textContent = msg;
        showDictError(msg);
      }
    });
  });

  loadDictLocalBtn.addEventListener('click', () => dictFileEl.click());

  dictFileEl.addEventListener('change', () => {
    const file = dictFileEl.files && dictFileEl.files[0];
    dictFileEl.value = '';
    if (!file) return;

    loadDictLocalBtn.disabled = true;
    loadDictBtn.disabled = true;
    hideDictError();
    dictStatusEl.textContent = '';
    setDictProgress(0, '正在读取文件 ' + file.name + ' …');

    const reader = new FileReader();
    reader.onerror = () => {
      loadDictLocalBtn.disabled = false;
      loadDictBtn.disabled = false;
      hideDictProgress();
      const msg = '文件读取失败：' + ((reader.error && reader.error.message) || '未知错误');
      dictStatusEl.textContent = msg;
      showDictError(msg);
    };
    reader.onload = () => {
      const text = reader.result || '';
      setDictProgress(0, '正在解析并写入词典…');
      // 先让“解析中”提示渲染出来，再执行同步解析（大文件会短暂阻塞 UI）。
      setTimeout(() => {
        loadCSVIntoDB(text, (p) => {
          if (p.phase === 'parse') {
            setDictProgress(0, '解析中，已解析 ' + (p.rowCount || 0) + ' 条…');
          } else if (p.phase === 'write') {
            const total = p.total || 0;
            const done = p.done || 0;
            const percent = total ? (done / total) * 100 : 0;
            setDictProgress(percent, '写入中 ' + done + '/' + total + ' 批…');
          }
        })
          .then((count) => {
            loadDictLocalBtn.disabled = false;
            loadDictBtn.disabled = false;
            hideDictProgress();
            dictStatusEl.textContent = '词典加载完成，共 ' + count + ' 词条。';
          })
          .catch((err) => {
            loadDictLocalBtn.disabled = false;
            loadDictBtn.disabled = false;
            hideDictProgress();
            const msg = '词典加载失败：' + ((err && err.message) || '未知错误');
            dictStatusEl.textContent = msg;
            showDictError(msg);
          });
      }, 30);
    };
    reader.readAsText(file, 'utf-8');
  });

  // 下载并合并补充词典（不清空现有词典，按 word 覆盖/新增）。
  loadSupplementDictBtn.addEventListener('click', () => {
    const url = (supplementDictUrlEl.value || '').trim();
    if (!url) {
      showDictError('请先填写补充词典 CSV 地址。');
      return;
    }
    loadSupplementDictBtn.disabled = true;
    loadSupplementDictLocalBtn.disabled = true;
    hideDictError();
    dictStatusEl.textContent = '';
    setDictProgress(0, '正在连接并下载补充词典…');

    chrome.runtime.sendMessage({ type: 'loadSupplementDict', url }, (res) => {
      loadSupplementDictBtn.disabled = false;
      loadSupplementDictLocalBtn.disabled = false;
      if (res && res.ok) {
        hideDictProgress();
        dictStatusEl.textContent = '补充词典合并完成，当前共 ' + res.count + ' 词条。';
      } else {
        const msg = (res && res.message) || '补充词典合并失败：未知错误';
        dictStatusEl.textContent = msg;
        showDictError(msg);
      }
    });
  });

  loadSupplementDictLocalBtn.addEventListener('click', () => supplementDictFileEl.click());

  supplementDictFileEl.addEventListener('change', () => {
    const file = supplementDictFileEl.files && supplementDictFileEl.files[0];
    supplementDictFileEl.value = '';
    if (!file) return;

    loadSupplementDictLocalBtn.disabled = true;
    loadSupplementDictBtn.disabled = true;
    hideDictError();
    dictStatusEl.textContent = '';
    setDictProgress(0, '正在读取文件 ' + file.name + ' …');

    const reader = new FileReader();
    reader.onerror = () => {
      loadSupplementDictLocalBtn.disabled = false;
      loadSupplementDictBtn.disabled = false;
      hideDictProgress();
      const msg = '文件读取失败：' + ((reader.error && reader.error.message) || '未知错误');
      dictStatusEl.textContent = msg;
      showDictError(msg);
    };
    reader.onload = () => {
      const text = reader.result || '';
      setDictProgress(0, '正在解析并合并词典…');
      setTimeout(() => {
        mergeCSVIntoDB(text, (p) => {
          if (p.phase === 'parse') {
            setDictProgress(0, '解析中，已解析 ' + (p.rowCount || 0) + ' 条…');
          } else if (p.phase === 'write') {
            const total = p.total || 0;
            const done = p.done || 0;
            const percent = total ? (done / total) * 100 : 0;
            setDictProgress(percent, '合并写入中 ' + done + '/' + total + ' 批…');
          }
        })
          .then((count) => {
            loadSupplementDictLocalBtn.disabled = false;
            loadSupplementDictBtn.disabled = false;
            hideDictProgress();
            dictStatusEl.textContent = '补充词典合并完成，当前共 ' + count + ' 词条。';
          })
          .catch((err) => {
            loadSupplementDictLocalBtn.disabled = false;
            loadSupplementDictBtn.disabled = false;
            hideDictProgress();
            const msg = '补充词典合并失败：' + ((err && err.message) || '未知错误');
            dictStatusEl.textContent = msg;
            showDictError(msg);
          });
      }, 30);
    };
    reader.readAsText(file, 'utf-8');
  });

  copyDictErrorBtn.addEventListener('click', async () => {
    const text = dictErrorText.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      dictErrorText.focus();
      dictErrorText.select();
      document.execCommand('copy');
    }
    copyDictErrorBtn.textContent = '已复制';
    setTimeout(() => { copyDictErrorBtn.textContent = '复制错误信息'; }, 1500);
  });

  function setMdxProgress(percent, text) {
    mdxProgressWrap.classList.remove('hidden');
    mdxProgressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    mdxProgressText.textContent = text;
  }

  function hideMdxProgress() {
    mdxProgressWrap.classList.add('hidden');
    mdxProgressFill.style.width = '0';
    mdxProgressText.textContent = '';
  }

  loadMdxBtn.addEventListener('click', () => mdxFileEl.click());

  mdxFileEl.addEventListener('change', () => {
    const file = mdxFileEl.files && mdxFileEl.files[0];
    mdxFileEl.value = '';
    if (!file) return;

    loadMdxBtn.disabled = true;
    hideInlineError(mdxErrorEl);
    setMdxProgress(0, '正在解析 ' + file.name + ' …');

    const parser = (window.LV_MDX && window.LV_MDX.parseMdxFile);
    if (!parser) {
      loadMdxBtn.disabled = false;
      hideMdxProgress();
      const msg = '解析器加载失败，请刷新页面后重试。';
      showInlineError(mdxErrorEl, msg);
      return;
    }

    // 每次导入都生成新的词典 id，多份词典并存；标题取词典头部或文件名。
    const dictId = 'c_' + Date.now().toString(36);
    parser(file, (p) => {
      if (p && p.phase === 'read') {
        setMdxProgress(0, p.text);
      } else if (p && p.phase === 'parse') {
        setMdxProgress(100, p.text);
      }
    }, dictId)
      .then((info) => {
        loadMdxBtn.disabled = false;
        hideMdxProgress();
        hideInlineError(mdxErrorEl);
        const meta = {
          id: info.dictId || dictId,
          title: info.title || file.name.replace(/\.mdx$/i, ''),
          count: info.count,
        };
        chrome.runtime.sendMessage({ type: 'addCustomDict', meta }, (res) => {
          if (res && res.ok) {
            refreshDictStatus();
          } else {
            const msg = (res && res.message) || '保存词典信息失败';
            showInlineError(mdxErrorEl, msg);
          }
        });
      })
      .catch((err) => {
        loadMdxBtn.disabled = false;
        hideMdxProgress();
        const msg = '词典导入失败：' + ((err && err.message) || '未知错误');
        showInlineError(mdxErrorEl, msg);
      });
  });

  function setMddProgress(percent, text) {
    mddProgressWrap.classList.remove('hidden');
    mddProgressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    mddProgressText.textContent = text;
  }

  function hideMddProgress() {
    mddProgressWrap.classList.add('hidden');
    mddProgressFill.style.width = '0';
    mddProgressText.textContent = '';
  }

  mddFileEl.addEventListener('change', () => {
    const file = mddFileEl.files && mddFileEl.files[0];
    mddFileEl.value = '';
    if (!file) return;

    const dictId = pendingMddDictId;
    if (!dictId) {
      showInlineError(mddErrorEl, '请先导入 .mdx 词典，再点击对应词典旁的「导入 .mdd」。');
      return;
    }

    hideInlineError(mddErrorEl);
    setMddProgress(0, '正在解析 ' + file.name + ' …');

    const parser = (window.LV_MDX && window.LV_MDX.parseMddFile);
    if (!parser) {
      hideMddProgress();
      showInlineError(mddErrorEl, '解析器加载失败，请刷新页面后重试。');
      return;
    }

    parser(file, (p) => {
      if (p && p.phase === 'read') {
        setMddProgress(0, p.text);
      } else if (p && p.phase === 'parse') {
        setMddProgress(100, p.text);
      } else if (p && p.phase === 'done') {
        setMddProgress(100, p.text);
      }
    }, dictId)
      .then((info) => {
        hideMddProgress();
        hideInlineError(mddErrorEl);
        dictStatusEl.textContent = '资源包导入完成：' + info.count + ' 个资源文件，已关联词典。';
        refreshDictStatus();
      })
      .catch((err) => {
        hideMddProgress();
        const msg = '资源包导入失败：' + ((err && err.message) || '未知错误');
        showInlineError(mddErrorEl, msg);
      });
  });

  const clearDataBtn = document.getElementById('clear-data');
  const clearDataMsgEl = document.getElementById('clear-data-msg');

  clearDataBtn.addEventListener('click', async () => {
    if (!confirm('确定要清空本扩展的全部数据吗？\n包括生词本、句子收藏、翻译接口配置、完整词典、预设词表与自定义词典。此操作不可恢复。')) return;
    clearDataBtn.disabled = true;
    clearDataMsgEl.textContent = '正在清理…';
    clearDataMsgEl.className = 'config-msg';
    try {
      await chrome.storage.local.clear();
    } catch (e) { /* 忽略 */ }
    try {
      await idbClear(STORE_DICT);
      await idbClear(STORE_CACHE);
      await idbClear(STORE_PRESET);
      await idbClear(STORE_CUSTOM);
      await idbClear(STORE_RES);
    } catch (e) { /* 忽略 */ }
    clearDataBtn.disabled = false;
    clearDataMsgEl.textContent = '清理完成。生词本、句子收藏、配置与词典已清空。';
    clearDataMsgEl.className = 'config-msg ok';
    // 同步清空表单输入，避免界面残留旧密钥。
    providerInputs.youdao.appKey.value = '';
    providerInputs.youdao.appSecret.value = '';
    providerInputs.baidu.appId.value = '';
    providerInputs.baidu.secret.value = '';
    providerInputs.google.apiKey.value = '';
    providerInputs.caiyun.token.value = '';
    providerInputs.deepseek.apiKey.value = '';
    providerInputs.deepseek.model.value = '';
    providerInputs.gemini.apiKey.value = '';
    providerInputs.gemini.model.value = '';
    providerInputs.gpt.apiKey.value = '';
    providerInputs.gpt.model.value = '';
    providerInputs.gpt.baseUrl.value = '';
    shortcutEl.value = 'Alt+T';
    wordsMap = {};
    sentencesList = [];
    presetWords = [];
    presetState = {};
    presetFilters = {};
    presetImportDates = {};
    reviewStartDates = [];
    bookColors = {};
    importedPresetIds = new Set();
    currentBook = 'own';
    wordPage = 0;
    memorizedPage = 0;
    settingsOrder = DEFAULT_SETTINGS_ORDER.slice();
    renderBookSelects();
    renderBookColors();
    applySettingsOrder();
    renderSettingsNav();
    renderAll();
    refreshDictStatus();
  });

  /* ---------- 数据导出 ---------- */

  const exportBtn = document.getElementById('export-data');
  const exportTypeEl = document.getElementById('export-type');
  const exportMsgEl = document.getElementById('export-msg');

  function buildExportPayload(type) {
    const all = Object.values(wordsMap);
    const pending = all.filter((w) => w.status !== 'memorized');
    const memorized = all.filter((w) => w.status === 'memorized');
    const payload = { exportedAt: new Date().toISOString() };
    if (type === 'all') {
      payload.words = pending;
      payload.memorized = memorized;
      payload.sentences = sentencesList;
    } else if (type === 'words') {
      payload.words = pending;
    } else if (type === 'memorized') {
      payload.memorized = memorized;
    } else if (type === 'sentences') {
      payload.sentences = sentencesList;
    }
    return payload;
  }

  function exportFileName(type) {
    const d = new Date();
    const stamp =
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
    const names = {
      all: '生词本全部数据',
      words: '生词本',
      memorized: '已背单词',
      sentences: '收藏句子',
    };
    return (names[type] || '数据') + '_' + stamp + '.json';
  }

  async function exportData() {
    const type = exportTypeEl.value;
    const json = JSON.stringify(buildExportPayload(type), null, 2);
    const fileName = exportFileName(type);

    try {
      // 优先使用 File System Access API，让用户选择保存路径。
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'JSON 文件', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
      } else {
        // 回退：通过临时 <a download> 触发浏览器默认下载。
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      exportMsgEl.textContent = '导出成功：' + fileName;
      exportMsgEl.className = 'config-msg ok';
    } catch (err) {
      // 用户取消保存对话框时静默返回。
      if (err && err.name === 'AbortError') return;
      exportMsgEl.textContent = '导出失败：' + (err && err.message ? err.message : err);
      exportMsgEl.className = 'config-msg err';
    }
  }

  exportBtn.addEventListener('click', exportData);

  /* ---------- 词书生成 ---------- */

  const genFileEl = document.getElementById('gen-file');
  const genPickBtn = document.getElementById('gen-pick');
  const genFileNameEl = document.getElementById('gen-file-name');
  const genStartBtn = document.getElementById('gen-start');
  const genProgressWrap = document.getElementById('gen-progress-wrap');
  const genProgressFill = document.getElementById('gen-progress-fill');
  const genProgressText = document.getElementById('gen-progress-text');
  const genErrorEl = document.getElementById('gen-error');
  const genResultEl = document.getElementById('gen-result');
  const genResultSummaryEl = document.getElementById('gen-result-summary');
  const genDownloadCsvBtn = document.getElementById('gen-download-csv');
  const genMinEl = document.getElementById('gen-percent-min');
  const genMaxEl = document.getElementById('gen-percent-max');
  const genRangeFillEl = document.getElementById('gen-range-fill');
  const genPercentValueEl = document.getElementById('gen-percent-value');
  const genRemoveCommonEl = document.getElementById('gen-remove-common');
  const genRemoveUnknownEl = document.getElementById('gen-remove-unknown');
  const genBookNameEl = document.getElementById('gen-book-name');
  const genCreateBtn = document.getElementById('gen-create');
  const genCreateStatusEl = document.getElementById('gen-create-status');
  const genBooksListEl = document.getElementById('gen-books-list');
  const genRemovedBodyEl = document.getElementById('gen-removed-body');
  const genRestoreBtn = document.getElementById('gen-restore');
  const genIncludedToggle = document.getElementById('gen-included-toggle');
  const genIncludedBodyEl = document.getElementById('gen-included-body');
  const genIncludedListEl = document.getElementById('gen-included-list');
  const genExcludeBtn = document.getElementById('gen-exclude');
  const editCommonWordsBtn = document.getElementById('edit-common-words');
  const commonWordsModal = document.getElementById('common-words-modal');
  const commonWordsClose = document.getElementById('common-words-close');
  const commonWordsAddInput = document.getElementById('common-words-add-input');
  const commonWordsAddBtn = document.getElementById('common-words-add');
  const commonWordsDeleteBtn = document.getElementById('common-words-delete');
  const commonWordsListEl = document.getElementById('common-words-list');

  let genSelectedFile = null;
  // 用户从「收录词列表」中手动排除的词（不写入最终词书）。
  let genExcluded = new Set();

  function setGenProgress(percent, text) {
    genProgressWrap.classList.remove('hidden');
    genProgressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    genProgressText.textContent = text;
  }

  function hideGenProgress() {
    genProgressWrap.classList.add('hidden');
    genProgressFill.style.width = '0';
    genProgressText.textContent = '';
  }

  function syncGenRange(dragged) {
    let min = parseInt(genMinEl.value, 10) || 0;
    let max = parseInt(genMaxEl.value, 10) || 100;
    if (min > max) {
      if (dragged === 'min') max = min;
      else min = max;
      genMinEl.value = min;
      genMaxEl.value = max;
    }
    genRangeFillEl.style.left = min + '%';
    genRangeFillEl.style.width = (max - min) + '%';
    genPercentValueEl.textContent = min + '% ~ ' + max + '%';
  }
  genMinEl.addEventListener('input', () => syncGenRange('min'));
  genMaxEl.addEventListener('input', () => syncGenRange('max'));
  syncGenRange();

  genPickBtn.addEventListener('click', () => genFileEl.click());

  genFileEl.addEventListener('change', () => {
    const file = genFileEl.files && genFileEl.files[0];
    if (!file) return;
    genSelectedFile = file;
    genFileNameEl.textContent = file.name + '（' + formatBytes(file.size) + '）';
    genStartBtn.disabled = false;
    genParsed = null;
    genExcluded = new Set();
    genResultEl.classList.add('hidden');
    genCreateStatusEl.textContent = '';
    hideInlineError(genErrorEl);
    hideGenProgress();
  });

  // 2 字母的合法英文单词白名单：其余 2 字母 token 视为噪声片段（如 ys、ze、zo、du、fo、gi）。
  const TWO_LETTER_WORDS = new Set([
    'ad', 'am', 'an', 'as', 'at', 'ax', 'be', 'by', 'do', 'em', 'en', 'ex', 'go', 'he', 'hi', 'id',
    'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'oh', 'on', 'or', 'ox', 'pi', 'so', 'to', 'up', 'us', 'we',
  ]);

  // 语气词 / 拟声词 / 网络用语等「非生词」噪声：即便词典收录，也不应进入背单词词书。
  const NOISE_WORDS = new Set([
    'aah', 'ahh', 'aha', 'ahem', 'alas', 'argh', 'bah', 'blah', 'boo', 'duh', 'eek', 'eww', 'gee',
    'gosh', 'grr', 'hah', 'haha', 'heh', 'hehe', 'hmm', 'huh', 'hurrah', 'hush', 'meh', 'nah', 'ooh',
    'ouch', 'oww', 'phew', 'psst', 'shh', 'uhuh', 'uhoh', 'whoa', 'whoops', 'wow', 'yah', 'yay',
    'yeah', 'yep', 'yikes', 'yuck', 'zing', 'zap', 'zip', 'arr', 'mhm', 'mmm', 'hmph',
  ]);

  // 判定词是否为噪声词并返回原因（来源）；返回 null 表示保留。
  // 说明：已移除「依据大小写判断疑似人名」的过滤。误删正常词（abyss / abyssal）或专有名词
  // （abaddon / abydos）的代价远大于多收几个词，故遵循「宁多勿漏」，只过滤确凿的噪声。
  function classifyNoise(word, rec) {
    if (word.length === 1) return '单字母';
    if (word.length === 2 && !TWO_LETTER_WORDS.has(word)) return '过短非词';
    if (NOISE_WORDS.has(word)) return '语气词/无意义词';
    if (/([a-z])\1\1/.test(word)) return '连续重复字母';
    if (!/[aeiouy]/.test(word)) return '无元音';
    if (word.length <= 4 && /(aa|ii|uu)/.test(word)) return '罕见双元音';
    return null;
  }

  // 提取英文单词并按「原始词形」统计词频；词形还原移到解析阶段，配合词典消除 -ed/-ing 去 e 的歧义。
  // 返回 Map<原始词形, { count }>。
  function countWords(text) {
    const freq = new Map();
    const re = /[a-zA-Z]+(?:'[a-zA-Z]+)*/g;
    let m;
    while ((m = re.exec(text))) {
      // 缩写拆分（don't -> don / t；I'm -> i / m），每段单独计数。
      const parts = m[0].toLowerCase().split("'");
      for (const raw of parts) {
        if (!raw) continue;
        // 单字母仅保留 a / i，其余视为缩写残留噪声（t / m / s / d 等）。
        if (raw.length === 1 && raw !== 'a' && raw !== 'i') continue;
        let rec = freq.get(raw);
        if (!rec) { rec = { count: 0 }; freq.set(raw, rec); }
        rec.count++;
      }
    }
    return freq;
  }

  // ZIP 条目使用裸 DEFLATE（RFC 1951），Chrome 需 deflate-raw；失败回退 deflate（兼容个别实现）。
  async function inflateRaw(u8) {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }
  }

  // 解析 ZIP 中央目录，返回 [{ name, method, compSize, localOffset }]。
  function zipEntries(buf) {
    const dv = new DataView(buf);
    const len = buf.byteLength;
    let eocd = -1;
    const maxScan = Math.min(len, 22 + 65535);
    for (let i = len - 22; i >= 0 && i >= len - maxScan; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB 文件（缺少 ZIP 目录）');
    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(new Uint8Array(buf, p + 46, nameLen));
      entries.push({ name, method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // 读取 ZIP 内某个条目的 UTF-8 文本（支持无压缩 / DEFLATE）。
  async function zipReadText(buf, entry) {
    const dv = new DataView(buf);
    const p = entry.localOffset;
    if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('EPUB 条目损坏：' + entry.name);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const dataStart = p + 30 + nameLen + extraLen;
    const comp = new Uint8Array(buf, dataStart, entry.compSize);
    if (entry.method === 0) return new TextDecoder('utf-8').decode(comp);
    if (entry.method === 8) {
      const raw = await inflateRaw(comp);
      return new TextDecoder('utf-8').decode(raw);
    }
    throw new Error('不支持的压缩方式：' + entry.method);
  }

  function pathBase(p) {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i + 1) : '';
  }

  // 解析 OPF 里的相对路径（处理 ../ 与 ./，忽略外链）。
  function resolveEpubPath(baseDir, href) {
    if (!href) return '';
    href = href.split(/[?#]/)[0];
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return '';
    const out = [];
    for (const seg of (baseDir + href).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }

  // 从 XHTML/HTML 中提取纯文本（去掉样式与脚本，避免 CSS/JS 文本混入词频）。
  function epubNodeText(markup) {
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    const body = doc.body;
    if (body) {
      body.querySelectorAll('style, script').forEach((el) => el.remove());
      return body.textContent || '';
    }
    // 兜底：直接去标签。
    return markup.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  }

  // 解析 EPUB：container.xml → OPF → spine 顺序读取正文，返回纯文本。
  async function parseEpubText(buf, onProgress) {
    const entries = zipEntries(buf);
    const byName = new Map();
    for (const e of entries) byName.set(e.name, e);

    onProgress && onProgress(8, '解析 EPUB 结构…');
    const containerEntry = byName.get('META-INF/container.xml');
    if (!containerEntry) throw new Error('EPUB 缺少 META-INF/container.xml');
    const containerXml = await zipReadText(buf, containerEntry);
    const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const rootfile = containerDoc.getElementsByTagName('rootfile')[0];
    const opfPath = rootfile ? rootfile.getAttribute('full-path') : '';
    if (!opfPath) throw new Error('EPUB 的 container.xml 缺少 rootfile');

    const opfEntry = byName.get(opfPath);
    if (!opfEntry) throw new Error('EPUB 找不到 OPF 文件：' + opfPath);
    const opfXml = await zipReadText(buf, opfEntry);
    const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
    const baseDir = pathBase(opfPath);

    const manifest = {};
    const items = opfDoc.getElementsByTagName('item');
    for (const it of items) {
      const id = it.getAttribute('id');
      const href = it.getAttribute('href');
      if (id && href) manifest[id] = href;
    }
    const spine = [];
    const itemrefs = opfDoc.getElementsByTagName('itemref');
    for (const ir of itemrefs) {
      const idref = ir.getAttribute('idref');
      if (idref && manifest[idref]) spine.push(manifest[idref]);
    }
    if (!spine.length) throw new Error('EPUB 的 spine 为空，无法读取正文');

    const texts = [];
    const total = spine.length;
    for (let i = 0; i < total; i++) {
      const rel = resolveEpubPath(baseDir, spine[i]);
      const entry = byName.get(rel);
      if (entry) {
        const markup = await zipReadText(buf, entry);
        texts.push(epubNodeText(markup));
      }
      onProgress && onProgress(10 + Math.round(((i + 1) / total) * 55), '提取正文 ' + (i + 1) + '/' + total + '…');
    }
    return texts.join('\n');
  }

  async function parseSelectedFile(onProgress) {
    const file = genSelectedFile;
    if (!file) throw new Error('请先选择文件');
    const name = (file.name || '').toLowerCase();
    let text;
    if (name.endsWith('.epub')) {
      onProgress && onProgress(2, '读取 EPUB 文件…');
      const buf = await file.arrayBuffer();
      text = await parseEpubText(buf, onProgress);
    } else {
      onProgress && onProgress(2, '读取文本文件…');
      text = await file.text();
    }
    onProgress && onProgress(70, '统计单词频次…');
    const rawFreq = countWords(text);

    // 收集每个原始词形的候选原型，供后续用词典消除 -ed/-ing 去 e 的歧义（abridged→abridge 而非 abridg）。
    const candidateSet = new Set();
    const rawList = [];
    for (const [raw, rec] of rawFreq) {
      const candidates = LV_LEMMATIZER.lemmatizeCandidates(raw);
      const list = (candidates && candidates.length) ? candidates : [raw];
      // 原始词形也作为兜底候选：处理 catharsis→catharsi、basis→basi 这类 -s 被误剥的情况。
      if (list.indexOf(raw) === -1) list.push(raw);
      rawList.push({ raw, candidates: list, rec });
      for (const c of list) candidateSet.add(c);
    }

    // 若已下载完整词典，用词典一次性校验所有候选原型。
    let inDict = new Set();
    if (ecdictCount > 5000 && candidateSet.size) {
      onProgress && onProgress(80, '词典校验…');
      try {
        const r = await bgMessage({ type: 'validateWords', words: Array.from(candidateSet) });
        if (r && r.ok && Array.isArray(r.found)) inDict = new Set(r.found);
      } catch (e) {
        // 校验失败则退化为启发式还原，不影响解析。
      }
    }

    // 合并到原型：有词典时优先选命中的候选，否则退回单结果还原（保持原行为）。
    const freq = new Map();
    for (const { raw, candidates, rec } of rawList) {
      let lemma = null;
      for (const c of candidates) {
        if (inDict.has(c)) { lemma = c; break; }
      }
      if (!lemma) lemma = LV_LEMMATIZER.lemmatize(raw);
      let lr = freq.get(lemma);
      if (!lr) { lr = { count: 0 }; freq.set(lemma, lr); }
      lr.count += rec.count;
    }

    const removed = [];   // 被过滤掉的词及其原因（来源），用于展示；count 用于「恢复」时放回频次。
    let freqList = [];
    for (const [word, rec] of freq) {
      const reason = classifyNoise(word, rec);
      if (reason) { removed.push({ word, reason, count: rec.count }); continue; }
      freqList.push({ word, count: rec.count });
    }
    freqList.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

    // 有完整词典且用户勾选「剔除词典中不存在的词」时，才剔除词典未收录的词。
    // 默认不剔除：宁多勿漏，避免把词典未收录的罕见/专有词汇误删（事后可在过滤列表中恢复）。
    if (ecdictCount > 5000 && genRemoveUnknownEl && genRemoveUnknownEl.checked) {
      const kept = [];
      for (const x of freqList) {
        if (inDict.has(x.word)) kept.push(x);
        else removed.push({ word: x.word, reason: '词典中不存在', count: x.count });
      }
      freqList = kept;
    }

    onProgress && onProgress(100, '解析完成');
    return { fileName: file.name, freqList, removed };
  }

  function renderGenResult() {
    if (!genParsed) return;
    const freqList = genParsed.freqList || [];
    const totalOcc = freqList.reduce((s, x) => s + x.count, 0);
    const removed = genParsed.removed || [];
    genResultSummaryEl.textContent =
      '解析完成：去重后 ' + freqList.length + ' 个词形，共 ' + totalOcc + ' 次出现，按出现频次降序排列。' +
      (removed.length ? '（已自动过滤 ' + removed.length + ' 个疑似噪声词，可展开查看）' : '');
    renderGenRemoved(removed);
    renderGenIncluded();
    genResultEl.classList.remove('hidden');
    if (!genBookNameEl.value.trim()) {
      genBookNameEl.value = genParsed.fileName.replace(/\.(epub|txt)$/i, '') || '我的词书';
    }
  }

  // 渲染被过滤掉的词列表（可点击/拖拽多选），供用户核对并恢复误删的词。
  function renderGenRemoved(removed) {
    const box = document.getElementById('gen-removed');
    const toggleEl = document.getElementById('gen-removed-toggle');
    const listEl = document.getElementById('gen-removed-list');
    if (!box || !toggleEl || !listEl) return;
    if (!removed.length) {
      box.classList.add('hidden');
      listEl.innerHTML = '';
      if (genRemovedBodyEl) genRemovedBodyEl.classList.add('hidden');
      return;
    }
    toggleEl.textContent = '查看被过滤的词（' + removed.length + '）';
    // 保留上一次展开/折叠状态；首次渲染默认折叠。
    const wasExpanded = genRemovedBodyEl && !genRemovedBodyEl.classList.contains('hidden');
    listEl.innerHTML = '';
    const sorted = removed.slice().sort((a, b) => a.word.localeCompare(b.word));
    for (const r of sorted) {
      const chip = document.createElement('span');
      chip.className = 'gen-chip';
      chip.textContent = r.word;
      chip.title = r.reason;
      chip.dataset.word = r.word;
      listEl.appendChild(chip);
    }
    bindChipList(listEl, updateRestoreBtn);
    box.classList.remove('hidden');
    if (genRemovedBodyEl) {
      if (wasExpanded) genRemovedBodyEl.classList.remove('hidden');
      else genRemovedBodyEl.classList.add('hidden');
    }
    updateRestoreBtn();
  }

  // 拖拽多选状态：按住鼠标在词上移动时，把经过的词统一设为 dragSelect 状态。
  let genChipDragging = false;
  let genChipDragSelect = false;

  // 通用 chip 列表拖拽多选：mousedown 切换首个词，按住拖动时 mouseenter 统一设为相同状态。
  // onSelectionChange 在每次选中状态变化后回调（用于更新对应按钮的可用状态/计数）。
  function bindChipList(listEl, onSelectionChange) {
    listEl.querySelectorAll('.gen-chip').forEach((chip) => {
      chip.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 避免按住拖动时选中文本
        const selected = chip.classList.contains('selected');
        genChipDragging = true;
        genChipDragSelect = !selected;
        setChipSelected(chip, genChipDragSelect, onSelectionChange);
      });
      chip.addEventListener('mouseenter', () => {
        if (genChipDragging) setChipSelected(chip, genChipDragSelect, onSelectionChange);
      });
    });
  }

  function setChipSelected(chip, on, onSelectionChange) {
    if (on) chip.classList.add('selected');
    else chip.classList.remove('selected');
    if (onSelectionChange) onSelectionChange();
  }

  function updateRestoreBtn() {
    if (!genRestoreBtn) return;
    const listEl = document.getElementById('gen-removed-list');
    const n = listEl ? listEl.querySelectorAll('.gen-chip.selected').length : 0;
    genRestoreBtn.disabled = n === 0;
    genRestoreBtn.textContent = n ? '恢复选中词（' + n + '）' : '恢复选中词';
  }

  // 把选中的过滤词从 removed 移回 freqList，并重新渲染结果。
  function restoreSelectedRemoved() {
    if (!genParsed) return;
    const listEl = document.getElementById('gen-removed-list');
    if (!listEl) return;
    const restoreSet = new Set();
    listEl.querySelectorAll('.gen-chip.selected').forEach((chip) => {
      restoreSet.add(chip.dataset.word);
    });
    if (!restoreSet.size) return;
    const restored = [];
    genParsed.removed = (genParsed.removed || []).filter((r) => {
      if (restoreSet.has(r.word)) { restored.push(r); return false; }
      return true;
    });
    for (const r of restored) {
      genParsed.freqList.push({ word: r.word, count: r.count || 0 });
    }
    genParsed.freqList.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
    renderGenResult();
  }

  // 渲染「收录词列表」：即 buildGenWordList() 最终会写入词书的词（词频区间 + 剔除常见词 + 排除词）。
  function renderGenIncluded() {
    if (!genIncludedToggle || !genIncludedBodyEl || !genIncludedListEl) return;
    if (!genParsed) {
      genIncludedToggle.closest('.gen-removed').classList.add('hidden');
      return;
    }
    const words = buildGenWordList();
    if (!words.length) {
      genIncludedToggle.textContent = '查看收录词（0）';
      genIncludedListEl.innerHTML = '';
      if (genExcludeBtn) { genExcludeBtn.disabled = true; genExcludeBtn.textContent = '排除选中词'; }
      genIncludedToggle.closest('.gen-removed').classList.remove('hidden');
      genIncludedBodyEl.classList.add('hidden');
      return;
    }
    const wasExpanded = !genIncludedBodyEl.classList.contains('hidden');
    genIncludedToggle.textContent = '查看收录词（' + words.length + '）';
    genIncludedListEl.innerHTML = '';
    const sorted = words.slice().sort((a, b) => a.word.localeCompare(b.word));
    for (const x of sorted) {
      const chip = document.createElement('span');
      chip.className = 'gen-chip';
      chip.textContent = x.word;
      chip.title = '出现 ' + x.count + ' 次';
      chip.dataset.word = x.word;
      genIncludedListEl.appendChild(chip);
    }
    bindChipList(genIncludedListEl, updateExcludeBtn);
    genIncludedToggle.closest('.gen-removed').classList.remove('hidden');
    if (wasExpanded) genIncludedBodyEl.classList.remove('hidden');
    else genIncludedBodyEl.classList.add('hidden');
    updateExcludeBtn();
  }

  function updateExcludeBtn() {
    if (!genExcludeBtn) return;
    const n = genIncludedListEl ? genIncludedListEl.querySelectorAll('.gen-chip.selected').length : 0;
    genExcludeBtn.disabled = n === 0;
    genExcludeBtn.textContent = n ? '排除选中词（' + n + '）' : '排除选中词';
  }

  function excludeSelectedIncluded() {
    if (!genIncludedListEl) return;
    let changed = false;
    genIncludedListEl.querySelectorAll('.gen-chip.selected').forEach((chip) => {
      genExcluded.add(chip.dataset.word);
      changed = true;
    });
    if (!changed) return;
    renderGenIncluded();
  }

  genStartBtn.addEventListener('click', async () => {
    if (!genSelectedFile) return;
    genStartBtn.disabled = true;
    hideInlineError(genErrorEl);
    genResultEl.classList.add('hidden');
    setGenProgress(0, '准备解析…');
    try {
      genParsed = await parseSelectedFile(setGenProgress);
      renderGenResult();
    } catch (e) {
      showInlineError(genErrorEl, '解析失败：' + (e && e.message ? e.message : e));
    } finally {
      genStartBtn.disabled = false;
    }
  });

  function csvEscape(v) {
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadGenCsv() {
    if (!genParsed) return;
    const rows = ['单词,出现次数'];
    for (const x of genParsed.freqList) rows.push(csvEscape(x.word) + ',' + x.count);
    const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (genParsed.fileName.replace(/\.(epub|txt)$/i, '') || '词频') + '_词频.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  genDownloadCsvBtn.addEventListener('click', downloadGenCsv);

  // 折叠/展开「被过滤的词」列表（切换列表容器 gen-removed-body 的显隐）。
  const genRemovedToggle = document.getElementById('gen-removed-toggle');
  if (genRemovedToggle) {
    genRemovedToggle.addEventListener('click', () => {
      if (genRemovedBodyEl) genRemovedBodyEl.classList.toggle('hidden');
    });
  }

  // 把选中的过滤词恢复回词频列表。
  if (genRestoreBtn) genRestoreBtn.addEventListener('click', restoreSelectedRemoved);

  // 折叠/展开「收录词」列表。
  if (genIncludedToggle) {
    genIncludedToggle.addEventListener('click', () => {
      if (genIncludedBodyEl) genIncludedBodyEl.classList.toggle('hidden');
    });
  }

  // 从收录词列表中排除选中词。
  if (genExcludeBtn) genExcludeBtn.addEventListener('click', excludeSelectedIncluded);

  // 词频区间（松开滑块）与「剔除高频词和常见词」变化时，重新生成收录词列表。
  genMinEl.addEventListener('change', renderGenIncluded);
  genMaxEl.addEventListener('change', renderGenIncluded);
  genRemoveCommonEl.addEventListener('change', renderGenIncluded);

  // 拖拽结束时复位状态（即使鼠标在列表外松开也能正确结束拖拽）。
  document.addEventListener('mouseup', () => {
    genChipDragging = false;
  });

  // 依据「词频排名区间 [不低于%, 不高于%] + 是否剔除常见词 + 用户排除词」从解析结果中筛出最终单词列表。
  function buildGenWordList() {
    if (!genParsed) return [];
    let min = Math.max(0, Math.min(100, parseInt(genMinEl.value, 10) || 0));
    let max = Math.max(0, Math.min(100, parseInt(genMaxEl.value, 10) || 100));
    if (min > max) [min, max] = [max, min];
    let list = (genParsed.freqList || []).slice(); // 已按频次降序
    if (genRemoveCommonEl.checked) list = list.filter((x) => !isCommonWord(x.word));
    if (genExcluded.size) list = list.filter((x) => !genExcluded.has(x.word));
    const n = list.length;
    if (!n) return [];
    const start = Math.round(n * min / 100);
    const end = Math.max(start, Math.round(n * max / 100));
    return list.slice(start, end);
  }

  function renderGeneratedBooks() {
    const list = generatedBookList();
    genBooksListEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有生成的词书。';
      genBooksListEl.appendChild(empty);
      return;
    }
    for (const b of list) {
      const row = document.createElement('div');
      row.className = 'gen-book-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'gen-book-name';
      nameEl.textContent = b.name || b.id;
      nameEl.title = b.name || b.id;

      const countEl = document.createElement('span');
      countEl.className = 'gen-book-count';
      countEl.textContent = (b.count || 0) + ' 个词';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'btn';
      renameBtn.textContent = '重命名';
      renameBtn.addEventListener('click', () => renameGeneratedBook(b.id));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => deleteGeneratedBook(b.id));

      row.appendChild(nameEl);
      row.appendChild(countEl);
      row.appendChild(renameBtn);
      row.appendChild(delBtn);
      genBooksListEl.appendChild(row);
    }
  }

  async function renameGeneratedBook(id) {
    const g = generatedBooks[id];
    const current = (g && g.name) || id;
    const next = prompt('输入新的词书名称：', current);
    if (!next) return;
    const name = next.trim();
    if (!name) return;
    const res = await bgMessage({ type: 'renameGeneratedBook', id, name });
    if (res && res.ok) {
      await loadGeneratedBooks();
      renderGeneratedBooks();
      renderBookSelects();
      renderAll();
    } else {
      alert('重命名失败：' + ((res && res.message) || '未知错误'));
    }
  }

  async function deleteGeneratedBook(id) {
    const g = generatedBooks[id];
    const name = (g && g.name) || id;
    if (!confirm('确定删除词书「' + name + '」吗？其中的单词将从预设词表中移除（不影响生词本）。')) return;
    const res = await bgMessage({ type: 'deleteGeneratedBook', id });
    if (res && res.ok) {
      await refreshPresetAndBooks();
      await loadGeneratedBooks();
      renderGeneratedBooks();
      if (currentBook === id) {
        currentBook = 'own';
        renderBookSelects();
        renderAll();
      }
    } else {
      alert('删除失败：' + ((res && res.message) || '未知错误'));
    }
  }

  genCreateBtn.addEventListener('click', async () => {
    if (!genParsed) return;
    const words = buildGenWordList();
    if (!words.length) {
      genCreateStatusEl.textContent = '没有可收录的词（可能被“剔除常见词”过滤），请调整百分比或取消剔除。';
      return;
    }
    const name = (genBookNameEl.value || '').trim();
    if (!name) {
      genCreateStatusEl.textContent = '请先填写词书名称。';
      return;
    }
    const id = 'gen_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    genCreateBtn.disabled = true;
    genCreateStatusEl.textContent = '正在生成词书…';
    const res = await bgMessage({ type: 'generateBook', id, name, words });
    if (res && res.ok) {
      await refreshPresetAndBooks();
      await loadGeneratedBooks();
      renderGeneratedBooks();
      genCreateBtn.disabled = false;
      genCreateStatusEl.textContent = '已生成词书「' + name + '」，共 ' + words.length + ' 个词。释义与例句将在后台自动补充。';
      // 自动补充本地释义与例句（按默认开启的复选框，后台幂等任务）。
      runPresetAutoTasks(id);
    } else {
      genCreateBtn.disabled = false;
      genCreateStatusEl.textContent = '生成失败：' + ((res && res.message) || '未知错误');
    }
  });

  /* ---------- 编辑高频词和常见词 ---------- */

  // 计算当前生效的「高频词和常见词」完整列表（内置集合 + 手动添加 - 手动剔除）。
  function currentCommonWords() {
    const set = {};
    for (const w in COMMON_WORDS) {
      if (!COMMON_OVERRIDES.remove[w]) set[w] = 1;
    }
    for (const w in COMMON_OVERRIDES.add) set[w] = 1;
    return Object.keys(set).sort();
  }

  function renderCommonWords() {
    if (!commonWordsListEl) return;
    const words = currentCommonWords();
    commonWordsListEl.innerHTML = '';
    for (const w of words) {
      const chip = document.createElement('span');
      chip.className = 'gen-chip';
      chip.textContent = w;
      chip.title = w;
      chip.dataset.word = w;
      commonWordsListEl.appendChild(chip);
    }
    bindChipList(commonWordsListEl, updateCommonWordsDeleteBtn);
    updateCommonWordsDeleteBtn();
  }

  function updateCommonWordsDeleteBtn() {
    if (!commonWordsDeleteBtn) return;
    const n = commonWordsListEl ? commonWordsListEl.querySelectorAll('.gen-chip.selected').length : 0;
    commonWordsDeleteBtn.disabled = n === 0;
    commonWordsDeleteBtn.textContent = n ? '删除选中（' + n + '）' : '删除选中';
  }

  async function persistCommonOverrides() {
    await chrome.storage.local.set({
      commonWordOverrides: { add: COMMON_OVERRIDES.add, remove: COMMON_OVERRIDES.remove },
    });
    await loadCommonOverrides();
  }

  // 将选中的词移出「高频词和常见词」集合（重新保留在词书中）。
  function deleteSelectedCommonWords() {
    if (!commonWordsListEl) return;
    let changed = false;
    commonWordsListEl.querySelectorAll('.gen-chip.selected').forEach((chip) => {
      const w = chip.dataset.word;
      delete COMMON_OVERRIDES.add[w];
      COMMON_OVERRIDES.remove[w] = 1;
      changed = true;
    });
    if (!changed) return;
    persistCommonOverrides().then(() => {
      renderCommonWords();
      renderAll();
      if (genParsed) renderGenIncluded();
    });
  }

  function addCommonWord() {
    const raw = (commonWordsAddInput.value || '').trim().toLowerCase();
    if (!raw) return;
    if (!/^[a-z]+(?:'[a-z]+)*$/.test(raw)) {
      alert('请输入合法的英文单词（只含字母，可含撇号）。');
      return;
    }
    delete COMMON_OVERRIDES.remove[raw];
    COMMON_OVERRIDES.add[raw] = 1;
    commonWordsAddInput.value = '';
    persistCommonOverrides().then(() => {
      renderCommonWords();
      renderAll();
      if (genParsed) renderGenIncluded();
    });
  }

  function openCommonWordsEditor() {
    if (!commonWordsModal) return;
    renderCommonWords();
    commonWordsModal.classList.remove('hidden');
  }

  function closeCommonWordsEditor() {
    if (commonWordsModal) commonWordsModal.classList.add('hidden');
  }

  if (editCommonWordsBtn) editCommonWordsBtn.addEventListener('click', openCommonWordsEditor);
  if (commonWordsClose) commonWordsClose.addEventListener('click', closeCommonWordsEditor);
  if (commonWordsModal) {
    commonWordsModal.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.closeCommonWords !== undefined) {
        closeCommonWordsEditor();
      }
    });
  }
  if (commonWordsDeleteBtn) commonWordsDeleteBtn.addEventListener('click', deleteSelectedCommonWords);
  if (commonWordsAddBtn) commonWordsAddBtn.addEventListener('click', addCommonWord);
  if (commonWordsAddInput) {
    commonWordsAddInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCommonWord(); }
    });
  }

  /* ---------- 初始化 ---------- */

  function renderAll() {
    renderStats();
    renderCalendar();
    renderList();
    renderMemorized();
    renderSentences();
  }

  // 跨标签页同步：content script 在网页添加/移出生词、或其它页面改动数据时，
  // 实时刷新当前视图，无需手动 F5。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needRender = false;
    if (changes.words) {
      wordsMap = changes.words.newValue || {};
      needRender = true;
    }
    if (changes.sentences) {
      sentencesList = changes.sentences.newValue || [];
      needRender = true;
    }
    if (changes.presetState) {
      presetState = changes.presetState.newValue || {};
      needRender = true;
    }
    if (changes.presetImportDates) {
      presetImportDates = changes.presetImportDates.newValue || {};
      needRender = true;
    }
    if (changes.reviewStartDates) {
      reviewStartDates = changes.reviewStartDates.newValue || [];
      needRender = true;
    }
    if (changes.presetFilters) {
      presetFilters = changes.presetFilters.newValue || {};
      needRender = true;
    }
    if (changes.generatedBooks) {
      generatedBooks = changes.generatedBooks.newValue || {};
      if (currentTab === 'generator') renderGeneratedBooks();
      needRender = true;
    }
    if (changes.commonWordOverrides) {
      // 高频词和常见词覆盖变化后，重新加载并刷新可见单词与生成器收录列表。
      loadCommonOverrides().then(() => {
        renderAll();
        if (genParsed) renderGenIncluded();
      });
    }
    if (changes.presetRevision) {
      // 预设词表导入/移除后，重新读取词条并刷新词书下拉与列表。
      refreshPresetWords().then(() => {
        renderBookSelects();
        renderBookColors();
        renderAll();
      });
      return;
    }
    if (changes.appearance) {
      loadAppearance().then(() => renderAll());
      return;
    }
    if (changes.customDicts || changes.dictOrder) {
      refreshDictStatus();
    }
    if (needRender) renderAll();
  });

  Promise.all([loadWords(), loadSentences(), loadAppearance(), loadPresetState(), loadPresetFilters(), loadGeneratedBooks(), loadActivityDates(), refreshPresetWords(), loadSettingsOrder(), loadCommonOverrides()]).then(() => {
    applySettingsOrder();
    renderSettingsNav();
    renderBookSelects();
    renderBookColors();
    renderAll();
    // 打开主页时自动检测并补充已导入词书的释义/例句（按复选框设置，幂等）。
    autoRunPresetTasksOnOpen();
  });

  // 支持通过 review.html#settings 直接打开设置页（放在所有定义之后，避免 TDZ 报错）。
  if (location.hash === '#settings') {
    switchTab('settings');
  }
})();
