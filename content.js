/**
 * content.js —— 内容脚本
 *
 * 注入到每个网页（<all_urls>），负责：
 * 1. 双击识别英文单词，词形还原（ate→eat），查询翻译并加入/移出生词本。
 * 2. 加入时自动发音，弹窗显示音标、多义、发音按钮。
 * 3. 高亮生词：不仅高亮原型，也高亮其各种变形（eat/eats/ate/eaten/eating）。
 * 4. 抓取单词所在句子，作为例句保存（去重，最多 5 条）。
 *
 * 依赖：lemmatizer.js（LV_LEMMATIZER）、tts.js（LV_TTS），需在 manifest 中先加载。
 */
(() => {
  'use strict';

  // 生词本缓存：{ 原型(小写): { word, translation, phonetic, explains, sentences, ... } }
  let wordsMap = {};

  // 高亮匹配表：{ 变形(小写): { lemma, preset } }，用于把 eat/ate/eaten 等都映射回原型。
  // preset 为 true 表示该词来自预设词书（而非用户自行加入的生词本）。
  let formMap = {};

  // 预设词书单词缓存：{ 原型(小写): { sources:[presetId], t, p } }，用于网页高亮与悬浮释义。
  let presetWordsMap = {};

  // 各词书的高亮颜色：{ presetId: '#rrggbb' }，来自「个性化设置」。
  let bookColors = {};

  // 已导入的预设词书列表：{ id, name, count }，用于右侧圆钮悬停时的「屏蔽某本词书高亮」菜单。
  let presetBooks = [];

  // 单独屏蔽某本词书的高亮：{ 'own' | presetId: true }，存于 chrome.storage.local.hiddenBooks。
  let hiddenBooks = {};

  // 句子收藏：{ id, text, translation, addedAt }，按时间倒序展示。
  let sentencesList = [];
  // 划句翻译快捷键（默认 Alt+T。
  let shortcut = 'Alt+T';
  // 个性化外观配置（主题色/字体等），用于悬浮窗字体与字号。
  let appearance = {};

  // 逐站点高亮开关：highlightDisabled 表示“当前网页已关闭生词高亮”；
  // disabledSites 为已关闭高亮的站点 origin 映射（{ origin: true }），存于 chrome.storage.local。
  let highlightDisabled = false;
  let disabledSites = {};
  // 全局高亮总开关：关闭后所有网页都不再高亮（存于 chrome.storage.local.globalHighlightOff）。
  let highlightGlobalOff = false;

  // 仅识别纯英文单词（允许连字符与英文撇号）。
  const WORD_RE = /^[a-zA-Z][a-zA-Z'’-]*$/;

  // 短英文短语的最大词数（含）：选中该词数以内的短语时，松手自动查本地词典。
  const PHRASE_MAX_WORDS = 4;

  // 不处理这些标签内的文本。
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'NOSCRIPT', 'SVG', 'CANVAS', 'CODE', 'PRE', 'IFRAME',
  ]);

  /* ---------------- 存储 ---------------- */

  function loadWords() {
    return chrome.storage.local.get('words').then(async ({ words }) => {
      wordsMap = words || {};
      await migrateStaleLemmas();
      rebuildFormMap();
      highlightAll();
    });
  }

  function saveWords() {
    return chrome.storage.local.set({ words: wordsMap });
  }

  // 从后台拉取预设词表单词（已应用「剔除高频词和常见词/已背单词」过滤），用于网页高亮。
  function fetchPresetWords() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getPresetWords' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          resolve([]);
          return;
        }
        resolve(res.words || []);
      });
    });
  }

  function applyPresetWords(words) {
    presetWordsMap = {};
    for (const w of words) {
      if (w && w.word) presetWordsMap[w.word] = w;
    }
    rebuildFormMap();
    highlightAll();
  }

  async function loadPresetWords() {
    const words = await fetchPresetWords();
    applyPresetWords(words);
  }

  // 加载句子收藏、划句翻译快捷键与逐站点高亮开关状态。
  function loadSentences() {
    return chrome.storage.local.get(['sentences', 'config', 'appearance', 'disabledSites', 'globalHighlightOff', 'hiddenBooks']).then(({ sentences, config, appearance: a, disabledSites: ds, globalHighlightOff, hiddenBooks: hb }) => {
      sentencesList = sentences || [];
      shortcut = (config && config.shortcut) || 'Alt+T';
      appearance = a || {};
      disabledSites = ds || {};
      highlightGlobalOff = !!globalHighlightOff;
      hiddenBooks = hb || {};
      highlightDisabled = !!disabledSites[currentOrigin()];
      applyHighlightColor();
    });
  }

  // 是否已有可高亮的词形。改用「分词 + 对象查找」替代巨大正则，
  // 大词书下可显著降低正则编译/存储的内存占用与构建耗时。
  let hasHighlightForms = false;

  // 根据生词本 + 预设词书重新构建“变形 -> 原型”映射（自有生词优先于预设词书）。
  function rebuildFormMap() {
    formMap = {};
    // 自有生词本优先（被用户单独屏蔽「生词本」时跳过）。
    if (!(hiddenBooks && hiddenBooks['own'])) {
      Object.keys(wordsMap).forEach((lemma) => {
        const forms = LV_LEMMATIZER.getInflections(lemma);
        forms.forEach((f) => {
          if (!formMap[f]) formMap[f] = { lemma, preset: false };
        });
      });
    }
    // 预设词书单词（仅当该变形未被自有生词占用时加入；被屏蔽的词书来源不计入）。
    Object.keys(presetWordsMap).forEach((lemma) => {
      if (!visibleSourcesFor(lemma).length) return;
      const forms = LV_LEMMATIZER.getInflections(lemma);
      forms.forEach((f) => {
        if (!formMap[f]) formMap[f] = { lemma, preset: true };
      });
    });
    hasHighlightForms = Object.keys(formMap).length > 0;
  }

  // 计算某个预设词在当前「词书屏蔽」设置下仍可见的来源（已背/被剔除高频词和常见词的来源已由后台剔除）。
  function visibleSourcesFor(lemma) {
    const w = presetWordsMap[lemma];
    if (!w) return [];
    const sources = w.visibleSources || [];
    if (!hiddenBooks || !Object.keys(hiddenBooks).length) return sources;
    return sources.filter((id) => !hiddenBooks[id]);
  }

  // 监听其它标签页对生词本 / 配置 / 句子收藏 / 预设词表的改动，保持同步。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.words) {
      wordsMap = changes.words.newValue || {};
      rebuildFormMap();
      highlightAll();
    }
    if (changes.config) {
      shortcut = (changes.config.newValue && changes.config.newValue.shortcut) || 'Alt+T';
    }
    if (changes.sentences) {
      sentencesList = changes.sentences.newValue || [];
    }
    if (changes.appearance) {
      appearance = changes.appearance.newValue || {};
      applyHighlightColor();
    }
    if (changes.disabledSites) {
      disabledSites = changes.disabledSites.newValue || {};
      highlightDisabled = !!disabledSites[currentOrigin()];
      syncToggleButton();
      highlightAll();
    }
    if (changes.globalHighlightOff) {
      highlightGlobalOff = !!changes.globalHighlightOff.newValue;
      syncGlobalButton();
      highlightAll();
    }
    // 词书屏蔽设置变化（可能在其它标签页修改）后，重新渲染菜单并刷新高亮。
    if (changes.hiddenBooks) {
      hiddenBooks = changes.hiddenBooks.newValue || {};
      renderBooksMenu();
      rebuildFormMap();
      highlightAll();
    }
    // 预设词表增删 / 过滤选项变化后，重新拉取高亮词集。
    if (changes.presetRevision) {
      loadPresetWords();
    }
  });

  /* ---------------- 高亮 ---------------- */

  // 判断文本节点是否位于可编辑区域（输入框 / contenteditable 富文本 / 全局 designMode）。
  // 这些区域通常是用户自己正在输入或编辑的内容，不应被生词高亮干扰。
  function isEditableElement(el) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node.isContentEditable) return true;
      if (node === document.body) break;
      node = node.parentElement;
    }
    return document.designMode === 'on';
  }

  function acceptTextNode(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (parent.closest('.lv-highlight, .lv-popup, .lv-sentence-trans, .lv-sentence-btn, .lv-inline-trans')) return false;
    // 不处理输入框与可编辑区域内的文本（含 contenteditable 富文本编辑器）。
    if (isEditableElement(parent)) return false;
    return true;
  }

  function highlightIn(root) {
    if (!hasHighlightForms) return;

    const textNodes = [];
    if (root.nodeType === Node.TEXT_NODE) {
      if (acceptTextNode(root)) textNodes.push(root);
    } else if (root.nodeType === Node.ELEMENT_NODE) {
      if (root.classList && (root.classList.contains('lv-highlight') || root.classList.contains('lv-popup') || root.classList.contains('lv-sentence-trans') || root.classList.contains('lv-sentence-btn') || root.classList.contains('lv-inline-trans'))) {
        return;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (acceptTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      while (walker.nextNode()) textNodes.push(walker.currentNode);
    }

    for (const node of textNodes) highlightTextNode(node);
  }

  // 匹配文本中的英文单词（\b 边界，与原有正则行为一致），逐个查 formMap 并高亮命中项。
  const WORD_TOKEN_RE = /\b[a-zA-Z]+\b/g;

  function highlightTextNode(node) {
    if (!hasHighlightForms) return;
    const text = node.nodeValue;
    if (!/[a-zA-Z]/.test(text)) return;

    // 先收集所有命中，避免边匹配边插入 DOM。
    const matches = [];
    WORD_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = WORD_TOKEN_RE.exec(text)) !== null) {
      const info = formMap[m[0].toLowerCase()];
      if (info) matches.push({ surface: m[0], info, index: m.index, end: m.index + m[0].length });
    }
    if (!matches.length) return;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    for (const hit of matches) {
      const { surface, info, index, end } = hit;
      const lemma = info.lemma;
      const preset = info.preset;
      const entry = preset ? presetWordsMap[lemma] : wordsMap[lemma];
      if (!entry) continue;
      const translation = preset ? (entry.t || lemma) : (entry.translation || lemma);

      fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));

      const span = document.createElement('span');
      span.className = 'lv-highlight';
      span.textContent = surface;
      span.dataset.word = lemma;
      // 预设词书记录所属词书，供「每个词书独立高亮色」的 CSS 规则命中。
      if (preset) {
        const sources = visibleSourcesFor(lemma);
        if (sources[0]) span.dataset.book = sources[0];
      }
      span.title = translation;
      bindHighlightEvents(span);
      fragment.appendChild(span);

      lastIndex = end;
    }

    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.parentNode.replaceChild(fragment, node);
  }

  function highlightAll() {
    // 先还原所有已高亮节点；若当前站点已关闭高亮，则不再重新高亮。
    document.querySelectorAll('.lv-highlight').forEach((span) => {
      const parent = span.parentNode;
      if (parent) parent.replaceChild(document.createTextNode(span.textContent), span);
    });
    if (highlightDisabled || highlightGlobalOff) return;
    if (!document.body) return;
    highlightIn(document.body);
  }

  /* ---------------- 高亮词 hover：自动发音 + 详情 ---------------- */

  let hoverPopupEl = null;
  let hoverTimer = null;
  let speakTimer = null;

  // 给高亮 span 绑定鼠标移入事件：自动发音，并延迟显示结构化详情浮层。
  function bindHighlightEvents(span) {
    span.addEventListener('mouseenter', () => {
      const lemma = span.dataset.word;
      if (!lemma) return;
      // 双击结果弹窗打开时，不再弹出悬浮详情，避免两者重叠。
      if (popupEl) return;
      if (hoverTimer) clearTimeout(hoverTimer);
      if (speakTimer) clearTimeout(speakTimer);
      // 停留超过一定时间后才自动发音，避免鼠标快速划过时误触发发声。
      speakTimer = setTimeout(() => LV_TTS.speak(lemma), 500);
      hoverTimer = setTimeout(() => showHoverPopup(span, lemma), 150);
    });
    span.addEventListener('mouseleave', () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      if (speakTimer) {
        clearTimeout(speakTimer);
        speakTimer = null;
      }
      // 延迟关闭，给用户移入悬浮窗的时间，避免一离开单词就消失。
      hoverTimer = setTimeout(() => removeHoverPopup(), 200);
    });
  }

  // 若生词缺少结构化释义（老数据），惰性补齐并缓存，避免每次 hover 都查词典。
  async function ensureEntryDetail(lemma) {
    const entry = wordsMap[lemma];
    if (!entry) return null;
    if (entry.senses && entry.senses.length) return entry;
    try {
      const trans = await translateWord(lemma);
      const cur = wordsMap[lemma];
      if (cur) {
        cur.senses = trans.senses || [];
        cur.definitions = trans.definitions || [];
        cur.phonetic = cur.phonetic || trans.phonetic || '';
        cur.translation = cur.translation || trans.translation || '';
        cur.explains = trans.explains || cur.explains || [];
        saveWords();
      }
      return cur || entry;
    } catch (e) {
      return entry;
    }
  }

  async function showHoverPopup(span, lemma) {
    // 双击结果弹窗存在时不显示悬浮详情。
    if (popupEl) return;
    // 自有生词走完整释义；预设词书单词也按词典优先级查询（不触发翻译 API），
    // 查不到时退回词表导入时自带的简释义。
    let entry;
    if (wordsMap[lemma]) {
      entry = await ensureEntryDetail(lemma);
    } else {
      const pw = presetWordsMap[lemma];
      if (!pw) return;
      const hit = await dictLookup(lemma);
      if (hit) {
        entry = {
          phonetic: hit.phonetic || pw.p || '',
          senses: (hit.senses && hit.senses.length)
            ? hit.senses
            : (pw.t ? [{ pos: '', text: pw.t }] : []),
          definitions: hit.definitions || [],
          explains: hit.explains || [],
        };
      } else {
        entry = {
          phonetic: pw.p || '',
          senses: pw.t ? [{ pos: '', text: pw.t }] : [],
          definitions: [],
          explains: [],
        };
      }
    }
    if (!entry) return;
    removeHoverPopup();
    hoverTimer = null;

    hoverPopupEl = document.createElement('div');
    hoverPopupEl.className = 'lv-popup lv-hover-popup';
    applyPopupStyle(hoverPopupEl);
    hoverPopupEl.innerHTML =
      '<div class="lv-popup-word">' + escapeHtml(lemma) +
      (entry.phonetic ? ' <span class="lv-popup-phonetic">' + escapeHtml(entry.phonetic) + '</span>' : '') +
      '</div>' +
      detailHtml({ senses: entry.senses, definitions: entry.definitions, explains: entry.explains });

    document.body.appendChild(hoverPopupEl);
    const wordEl = hoverPopupEl.querySelector('.lv-popup-word');
    if (wordEl) wordEl.appendChild(LV_TTS.speakerButton(lemma));
    positionNearElement(hoverPopupEl, span);

    // 鼠标可移入悬浮窗内复制内容 / 点击发音，移出悬浮窗后再关闭。
    hoverPopupEl.addEventListener('mouseenter', () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    });
    hoverPopupEl.addEventListener('mouseleave', () => {
      removeHoverPopup();
    });
  }

  function positionNearElement(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    const gap = 8;
    const box = el.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top - box.height - gap;

    // 上方放不下就放元素下方。
    if (top < margin) top = rect.bottom + gap;
    if (left + box.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - box.width);
    }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function removeHoverPopup() {
    if (hoverPopupEl) {
      hoverPopupEl.remove();
      hoverPopupEl = null;
    }
  }

  // 把个性化设置里的悬浮窗字体/字号应用到弹窗根元素。
  function applyPopupStyle(el) {
    const font = appearance && appearance.popupFont;
    if (font && font !== 'default' && font !== 'system') {
      el.style.fontFamily =
        '"' + String(font).replace(/"/g, '\\"') + '", ' +
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif";
    }
    if (appearance && appearance.popupFontSize) {
      el.style.fontSize = appearance.popupFontSize + 'px';
    }
    // 暗黑模式下，双击弹窗/悬浮详情同步切换为暗色。
    if (appearance && appearance.dark) {
      el.classList.add('dark');
    }
  }

  // 动态注入/更新高亮色样式：网页高亮色可在设置中独立调整，每个词书也可单独指定颜色。
  let highlightStyleEl = null;
  function applyHighlightColor() {
    const color = (appearance && appearance.highlightWeb) || '#fff3b0';
    bookColors = (appearance && appearance.bookColors) || {};
    // 把主题色写入根元素变量，供「译」按钮、行内译文与右侧按钮跟随主题色。
    document.documentElement.style.setProperty('--lv-accent', (appearance && appearance.accent) || '#2563eb');
    if (!highlightStyleEl) {
      highlightStyleEl = document.createElement('style');
      (document.head || document.documentElement).appendChild(highlightStyleEl);
    }
    // 高亮文字颜色跟随高亮底色亮度自动选择深/浅色，避免深色网页（白字）上高亮后看不清。
    let css =
      '.lv-highlight{background-color:' + color + ' !important;color:' + readableTextColor(color) + ' !important;}' +
      '.lv-highlight:hover{background-color:' + darkenHex(color, 0.82) + ' !important;}';
    // 每个词书独立高亮色，通过 data-book 属性区分来源。
    for (const id in bookColors) {
      const c = bookColors[id];
      css +=
        '.lv-highlight[data-book="' + id + '"]{background-color:' + c + ' !important;color:' + readableTextColor(c) + ' !important;}' +
        '.lv-highlight[data-book="' + id + '"]:hover{background-color:' + darkenHex(c, 0.82) + ' !important;}';
    }
    highlightStyleEl.textContent = css;
    // 右侧圆形按钮颜色 / 透明度也可能随主题色或个性化设置变化。
    applyToggleStyle();
  }

  // 根据高亮底色亮度返回可读的文字颜色（浅底用深字、深底用白字）。
  function readableTextColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return '#111827';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum > 150 ? '#111827' : '#ffffff';
  }

  // 把 #rrggbb 颜色按系数变暗（0~1），用于生成 hover 高亮色。
  function darkenHex(hex, amount) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return '#ffe066';
    const n = parseInt(m[1], 16);
    const r = Math.max(0, Math.floor(((n >> 16) & 255) * amount));
    const g = Math.max(0, Math.floor(((n >> 8) & 255) * amount));
    const b = Math.max(0, Math.floor((n & 255) * amount));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // 动态内容增量高亮：用 requestAnimationFrame 合并一批 DOM 变更，避免高频变更
  // （SPA 滚动加载、聊天流、整页重渲染）时对巨大正则反复执行，造成 CPU 与内存飙升。
  let pendingHighlightNodes = [];
  let highlightRafScheduled = false;

  function scheduleHighlightIn(node) {
    if (node) pendingHighlightNodes.push(node);
    if (highlightRafScheduled) return;
    highlightRafScheduled = true;
    requestAnimationFrame(() => {
      highlightRafScheduled = false;
      const nodes = pendingHighlightNodes;
      pendingHighlightNodes = [];
      for (const n of nodes) {
        // 跳过已被移除/离屏的节点，避免对已卸载 DOM 做无谓处理。
        if (!n.isConnected) continue;
        highlightIn(n);
      }
    });
  }

  const observer = new MutationObserver((mutations) => {
    if (highlightDisabled || highlightGlobalOff) return;
    if (!Object.keys(formMap).length) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          scheduleHighlightIn(node);
        }
      }
    }
  });

  function startObserver() {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    else requestAnimationFrame(startObserver);
  }

  /* ---------------- 双击处理 ---------------- */

  function getSelectedWord() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!text || text.length > 40) return null;
    if (!WORD_RE.test(text)) return null;
    return text;
  }

  document.addEventListener('dblclick', (event) => {
    if (event.target.closest('.lv-popup')) return;
    const surface = getSelectedWord();
    if (!surface) return;
    handleWord(surface, event);
  });

  async function handleWord(surface, event) {
    // 快速通道：已高亮词（含变形）直接从 formMap 取原型，无需词形还原与词典检索，
    // 毫秒级弹出结果；对变形词也能拿到正确原型，避免误加入生词本或错误还原。
    const formInfo = formMap[surface.toLowerCase()];
    if (formInfo) {
      const lemma = formInfo.lemma;

      // 预设词书里的词 → 双击切换「已背 / 放回词书」，而不是加入生词本。
      if (presetWordsMap[lemma]) {
        const sources = presetWordsMap[lemma].sources || [];
        // 先立即弹出「已移入已背」，再异步更新状态与高亮，保证毫秒级反馈。
        showPopup(event, { word: surface, lemma, presetToggled: true, presetMemorized: true });
        const res = await togglePresetMemorized(lemma, sources);
        if (res && res.memorized && wordsMap[lemma]) {
          delete wordsMap[lemma];
          await saveWords();
        }
        await loadPresetWords();
        return;
      }

      // 自有生词 → 移出（再次双击取消加入），同样先弹出结果再异步处理。
      if (wordsMap[lemma]) {
        showPopup(event, { word: surface, lemma, removed: true });
        delete wordsMap[lemma];
        await saveWords();
        rebuildFormMap();
        highlightAll();
        return;
      }
    }

    // 未高亮的新词（或 formMap 未覆盖的变形）：显示“查询中”后走词形还原 + 翻译。
    showPopup(event, { word: surface, loading: true });

    // 词形还原：结合候选原型 + 本地词典确认（conditioning -> condition）。
    const lemma = await resolveLemma(surface);
    const lower = lemma.toLowerCase();

    // 预设词书里的词 → 双击切换「已背 / 放回词书」，而不是加入生词本。
    // 放在自有生词本判断之前：即使该词同时也在自有生词本中，也按预设词处理。
    if (presetWordsMap[lower]) {
      const sources = presetWordsMap[lower].sources || [];
      const res = await togglePresetMemorized(lower, sources);
      // 标记已背后，若该词也在自有生词本中则一并移除，避免它仍以生词本身份高亮。
      if (res && res.memorized && wordsMap[lower]) {
        delete wordsMap[lower];
        await saveWords();
      }
      await loadPresetWords();
      showPopup(event, {
        word: surface,
        lemma: lower,
        presetToggled: true,
        presetMemorized: !!(res && res.memorized),
      });
      return;
    }

    // 已在生词本 → 移出（再次双击取消加入）
    if (wordsMap[lower]) {
      delete wordsMap[lower];
      await saveWords();
      rebuildFormMap();
      highlightAll();
      showPopup(event, { word: surface, lemma: lower, removed: true });
      return;
    }

    const sentence = extractSentence(surface);

    try {
      const trans = await translateWord(lower);

      const existing = wordsMap[lower];
      const sentences = existing ? existing.sentences || [] : [];
      if (sentence && !sentences.includes(sentence)) {
        sentences.push(sentence);
        if (sentences.length > 5) sentences.shift();
      }

      wordsMap[lower] = {
        word: lower,
        translation: trans.translation || '',
        phonetic: trans.phonetic || '',
        explains: trans.explains || [],
        senses: trans.senses || [],
        definitions: trans.definitions || [],
        // 自定义词典命中时，保留原始 HTML 与来源 id，供生词本渲染带样式的释义。
        html: trans.html || '',
        sourceId: trans.sourceId || '',
        sentences,
        addedAt: existing ? existing.addedAt : Date.now(),
        unknownCount: existing ? existing.unknownCount || 0 : 0,
        knownCount: existing ? existing.knownCount || 0 : 0,
        status: existing ? existing.status || 'pending' : 'pending',
        memorizedAt: existing ? existing.memorizedAt || null : null,
        reviewStage: existing ? existing.reviewStage || 0 : 0,
        nextReviewAt: existing ? existing.nextReviewAt || null : null,
        lastReviewedAt: existing ? existing.lastReviewedAt || null : null,
        // 记录来源网页，便于在生词本中按来源追溯。
        sourceUrl: (existing && existing.sourceUrl) || location.href,
        sourceTitle: (existing && existing.sourceTitle) || document.title,
      };

      await saveWords();
      rebuildFormMap();
      highlightAll();

      // 加入后自动发音
      LV_TTS.speak(lower);

      showPopup(event, {
        word: surface,
        lemma: lower,
        translation: trans.translation,
        phonetic: trans.phonetic,
        explains: trans.explains,
        senses: trans.senses,
        definitions: trans.definitions,
        added: true,
      });
    } catch (err) {
      showPopup(event, { word: surface, lemma: lower, error: err.message, code: err.code });
    }
  }

  function translateWord(word) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'translate', text: word }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res || !res.ok) {
          const err = new Error((res && res.message) || '翻译失败');
          err.code = (res && res.code) || 'ERROR';
          reject(err);
          return;
        }
        resolve(res);
      });
    });
  }

  // 切换预设词的「已背」状态：把该词在所属预设词书中的复习状态在「已背 / 待背」之间切换，
  // 返回操作后的状态（memorized = 是否已背）。后台会刷新高亮词集，使已背词不再高亮。
  function togglePresetMemorized(word, sources) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'togglePresetMemorized', word, sources }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          resolve({ memorized: false });
          return;
        }
        resolve({ memorized: !!res.memorized });
      });
    });
  }

  // 仅查本地词典/缓存（不触发翻译 API）。命中返回结果对象，未命中返回 null。
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
  // 仅在本地词典（内置 + ECDICT）可用时执行一次，避免每次页面加载都做校验。
  async function migrateStaleLemmas() {
    const { staleLemmaMigrated } = await chrome.storage.local.get('staleLemmaMigrated');
    if (staleLemmaMigrated) return;

    const keys = Object.keys(wordsMap).filter(
      (k) => k.length > 3 && k.endsWith('e') && /^[a-z]+$/.test(k)
    );
    let changed = false;
    let dictAvailable = false;
    for (const key of keys) {
      const stem = key.slice(0, -1);
      const keyHit = await dictLookup(key);
      const stemHit = await dictLookup(stem);
      if (keyHit || stemHit) dictAvailable = true;
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
    // 有词典证据（或根本没有以 e 结尾的词）才标记完成；词典未加载时下次再尝试。
    if (dictAvailable || keys.length === 0) {
      await chrome.storage.local.set({ staleLemmaMigrated: true });
    }
  }

  // 词形还原：优先用候选原型 + 本地词典确认正确原型，避免把 conditioning 误还原成 conditione。
  async function resolveLemma(surface) {
    const candidates = LV_LEMMATIZER.lemmatizeCandidates(surface);
    if (!candidates.length) return surface.toLowerCase();
    if (candidates.length === 1) return candidates[0].toLowerCase();
    for (const c of candidates) {
      const hit = await dictLookup(c);
      if (hit) return c.toLowerCase();
    }
    // 本地词典/缓存未命中时退回规则还原结果。
    return LV_LEMMATIZER.lemmatize(surface).toLowerCase();
  }

  /* ---------------- 例句抓取 ---------------- */

  function extractSentence(word) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';

    let el = selection.getRangeAt(0).startContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!el) return '';

    let container = el;
    while (
      container &&
      container !== document.body &&
      (!container.textContent || container.textContent.length < 4 || !/[.!?。！？;；]/.test(container.textContent))
    ) {
      container = container.parentElement;
    }
    const fullText = ((container && container.textContent) || document.body.textContent || '').replace(/\s+/g, ' ');

    const sentences = fullText.split(/(?<=[.!?。！？;；])\s+/);
    const lower = word.toLowerCase();
    for (const s of sentences) {
      if (s.toLowerCase().includes(lower)) return trimAround(s, word, 500);
    }
    return trimAround(fullText, word, 200);
  }

  function trimAround(text, word, maxLen) {
    const textStr = text.trim();
    if (textStr.length <= maxLen) return textStr;
    const idx = textStr.toLowerCase().indexOf(word.toLowerCase());
    if (idx < 0) return textStr.slice(0, maxLen);
    const half = Math.floor((maxLen - word.length) / 2);
    const start = Math.max(0, idx - half);
    const end = Math.min(textStr.length, idx + word.length + half);
    return (start > 0 ? '…' : '') + textStr.slice(start, end) + (end < textStr.length ? '…' : '');
  }

  /* ---------------- 结果弹窗 ---------------- */

  let popupEl = null;
  // 当前待加入生词本的短语数据（含释义与来源），供“加入生词本”按钮使用。
  let pendingPhrase = null;

  function showPopup(event, data) {
    removePopup();
    removeHoverPopup();
    popupEl = document.createElement('div');
    popupEl.className = 'lv-popup';
    applyPopupStyle(popupEl);

    const displayWord = data.lemma || data.word;
    const wordWithForm = data.word && data.lemma && data.word.toLowerCase() !== data.lemma
      ? escapeHtml(data.word) + ' → '
      : '';

    if (data.loading) {
      popupEl.innerHTML =
        '<div class="lv-popup-word">' + wordWithForm + escapeHtml(displayWord) + '</div>' +
        '<div class="lv-popup-meta">查询中…</div>';
    } else if (data.error) {
      popupEl.innerHTML =
        '<div class="lv-popup-word">' + wordWithForm + escapeHtml(displayWord) + '</div>' +
        '<div class="lv-popup-error">' + escapeHtml(data.error) + '</div>' +
        (data.code === 'NO_CONFIG'
          ? '<button class="lv-popup-btn" data-lv-open-settings>去设置密钥</button>'
          : '');
    } else if (data.removed) {
      popupEl.innerHTML =
        '<div class="lv-popup-word">' + wordWithForm + escapeHtml(displayWord) + '</div>' +
        '<div class="lv-popup-meta">已移出生词本</div>';
    } else if (data.presetToggled) {
      popupEl.innerHTML =
        '<div class="lv-popup-word">' + wordWithForm + escapeHtml(displayWord) + '</div>' +
        '<div class="lv-popup-meta">' +
        (data.presetMemorized ? '已移入已背' : '已放回预设词书') +
        '</div>';
    } else if (data.phrase) {
      popupEl.innerHTML =
        '<div class="lv-popup-word">' + wordWithForm + escapeHtml(displayWord) +
        (data.phonetic ? ' <span class="lv-popup-phonetic">' + escapeHtml(data.phonetic) + '</span>' : '') +
        '</div>' +
        detailHtml(data) +
        (data.added
          ? '<div class="lv-popup-meta">已加入生词本</div>'
          : '<div class="lv-popup-meta">本地词典</div>' +
            '<button class="lv-popup-btn" data-lv-add-phrase>加入生词本</button>');
    } else if (data.added) {
      popupEl.innerHTML =
        '<div class="lv-popup-word">' + wordWithForm + escapeHtml(displayWord) +
        (data.phonetic ? ' <span class="lv-popup-phonetic">' + escapeHtml(data.phonetic) + '</span>' : '') +
        '</div>' +
        detailHtml(data) +
        '<div class="lv-popup-meta">已加入生词本</div>';
    }

    document.body.appendChild(popupEl);
    positionPopup(event);

    // 发音按钮：放在单词旁边。短语发音使用用户选中的原文（如 stood up），而非还原后的原型。
    if ((data.added || data.loading || data.phrase) && displayWord) {
      const wordEl = popupEl.querySelector('.lv-popup-word');
      if (wordEl) {
        const speakText = (data.phrase && data.word) ? data.word : displayWord;
        wordEl.appendChild(LV_TTS.speakerButton(speakText));
      }
    }

    const btn = popupEl.querySelector('[data-lv-open-settings]');
    if (btn) {
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'openSettings' });
        removePopup();
      });
    }

    const addPhraseBtn = popupEl.querySelector('[data-lv-add-phrase]');
    if (addPhraseBtn) {
      addPhraseBtn.addEventListener('click', addPhraseToVocab);
    }
  }

  function positionPopup(event) {
    const gap = 12;
    const margin = 10;
    const rect = popupEl.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;

    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, event.clientX - rect.width - gap);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, event.clientY - rect.height - gap);
    }
    popupEl.style.left = left + 'px';
    popupEl.style.top = top + 'px';
  }

  function removePopup() {
    if (popupEl) {
      popupEl.remove();
      popupEl = null;
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 生成结构化释义 HTML：中文多义（含词性）+ 英文释义。
  function detailHtml(data) {
    let html = '';
    const senses = data.senses && data.senses.length
      ? data.senses
      : (data.explains || []).map((text) => ({ pos: '', text }));
    if (senses.length) {
      html += '<div class="lv-senses">' + senses.map((s) =>
        '<div class="lv-sense">' +
        (s.pos ? '<span class="lv-sense-pos">' + escapeHtml(s.pos) + '</span>' : '') +
        '<span class="lv-sense-text">' + escapeHtml(s.text).replace(/\n/g, '<br>') + '</span>' +
        '</div>'
      ).join('') + '</div>';
    }
    if (data.definitions && data.definitions.length) {
      html += '<div class="lv-defs-title">英文释义</div><ul class="lv-defs">' +
        data.definitions.map((d) => '<li>' + escapeHtml(d).replace(/\n/g, '<br>') + '</li>').join('') +
        '</ul>';
    }
    return html;
  }

  /* ---------------- 划句翻译 ---------------- */

  let sentenceBtnEl = null;
  // 行内译文可同时存在多条（划 A 句、划 B 句互不覆盖）。
  const sentenceTransEls = [];

  // 判定“句子”选择：含字母，且要么带空格、要么足够长（避免与双击单词冲突）。
  // 短英文短语（2~4 个词）由“松手自动查本地词典”处理，这里只返回更长的句子。
  function getSelectedSentence() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!/[a-zA-Z]/.test(text)) return null;
    if (text.length < 2 || text.length > 1000) return null;

    const words = text.split(/\s+/).filter(Boolean);
    const isShortPhrase =
      words.length >= 2 &&
      words.length <= PHRASE_MAX_WORDS &&
      words.every((w) => WORD_RE.test(w));
    if (isShortPhrase) return null;

    if (!/\s/.test(text) && text.length < 20) return null;
    return { text, range: selection.getRangeAt(0) };
  }

  // 判定“短英文短语”选择：2~PHRASE_MAX_WORDS 个纯英文词，用于松手自动查本地词典。
  function getSelectedPhrase() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > PHRASE_MAX_WORDS) return null;
    if (!words.every((w) => WORD_RE.test(w))) return null;
    return { text, range: selection.getRangeAt(0) };
  }

  // 对短语中的每个单词做词形还原（stood up → stand up），再查本地词典命中短语原型。
  function lemmatizePhrase(text) {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => LV_LEMMATIZER.lemmatize(w))
      .join(' ');
  }

  // 短英文短语：松手后自动查本地词典（先原样、再词形还原），命中即发音并弹出释义。
  async function handlePhrase(phrase) {
    removeSentenceButton();
    let hit = await dictLookup(phrase.text);
    let lemma = phrase.text;
    if (!hit) {
      // 变形短语（如 stood up）在词典里以原型（stand up）存储，逐个词还原后重试。
      lemma = lemmatizePhrase(phrase.text);
      if (lemma.toLowerCase() !== phrase.text.toLowerCase()) {
        hit = await dictLookup(lemma);
      }
    }
    if (!hit) return; // 本地词典未收录该短语时静默忽略，长句仍可用快捷键/译按钮翻译

    const rect = phrase.range.getBoundingClientRect();
    const lower = lemma.toLowerCase();
    const event = { clientX: rect.left, clientY: rect.bottom + 4 };

    // 缓存待加入生词本的数据，供“加入生词本”按钮使用。
    pendingPhrase = {
      word: phrase.text,
      lemma,
      translation: hit.translation,
      phonetic: hit.phonetic,
      explains: hit.explains,
      senses: hit.senses,
      definitions: hit.definitions,
      html: hit.html || '',
      sourceId: hit.sourceId || '',
      sentence: extractSentence(phrase.text),
      event,
    };

    showPopup(event, {
      word: phrase.text,
      lemma,
      phrase: true,
      added: !!wordsMap[lower],
      phonetic: hit.phonetic,
      translation: hit.translation,
      explains: hit.explains,
      senses: hit.senses,
      definitions: hit.definitions,
    });

    // 短语自动发音
    LV_TTS.speak(phrase.text);
  }

  // 将短语加入生词本（key 为词形还原后的原型短语，如 stand up）。
  async function addPhraseToVocab() {
    if (!pendingPhrase) return;
    const p = pendingPhrase;
    const lower = p.lemma.toLowerCase();

    if (wordsMap[lower]) {
      showPopup(p.event, {
        word: p.word,
        lemma: p.lemma,
        phrase: true,
        added: true,
        phonetic: p.phonetic,
        translation: p.translation,
        explains: p.explains,
        senses: p.senses,
        definitions: p.definitions,
      });
      return;
    }

    wordsMap[lower] = {
      word: lower,
      translation: p.translation,
      phonetic: p.phonetic,
      explains: p.explains,
      senses: p.senses,
      definitions: p.definitions,
      html: p.html || '',
      sourceId: p.sourceId || '',
      sentences: p.sentence ? [p.sentence] : [],
      addedAt: Date.now(),
      unknownCount: 0,
      knownCount: 0,
      status: 'pending',
      memorizedAt: null,
      reviewStage: 0,
      nextReviewAt: null,
      lastReviewedAt: null,
      sourceUrl: location.href,
      sourceTitle: document.title,
    };

    await saveWords();
    rebuildFormMap();
    highlightAll();

    showPopup(p.event, {
      word: p.word,
      lemma: p.lemma,
      phrase: true,
      added: true,
      phonetic: p.phonetic,
      translation: p.translation,
      explains: p.explains,
      senses: p.senses,
      definitions: p.definitions,
    });
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // 已收藏的句子直接复用译文，不再调用 API。
  function findFavoritedTranslation(text) {
    const key = normalizeText(text);
    const hit = sentencesList.find((s) => normalizeText(s.text) === key);
    return hit ? hit.translation : null;
  }

  function isFavorited(text) {
    const key = normalizeText(text);
    return sentencesList.some((s) => normalizeText(s.text) === key);
  }

  function favoriteSentence(text, translation) {
    const key = normalizeText(text);
    if (sentencesList.some((s) => normalizeText(s.text) === key)) return true;
    sentencesList.push({
      id: 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      text,
      translation,
      addedAt: Date.now(),
      // 记录收藏来源网页，便于在句子收藏中按来源追溯。
      sourceUrl: location.href,
      sourceTitle: document.title,
    });
    sentencesList.sort((a, b) => b.addedAt - a.addedAt);
    chrome.storage.local.set({ sentences: sentencesList });
    return true;
  }

  function translateSentenceViaBg(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'translateSentence', text }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res || !res.ok) {
          const err = new Error((res && res.message) || '翻译失败');
          err.code = (res && res.code) || 'ERROR';
          reject(err);
          return;
        }
        resolve(res.translation || '');
      });
    });
  }

  function showSentenceButton() {
    const sel = getSelectedSentence();
    if (!sel) {
      removeSentenceButton();
      return;
    }
    // 定位到选区「末尾」位置，让按钮出现在选中内容末尾的右上角。
    const endRange = sel.range.cloneRange();
    endRange.collapse(false);
    const endRect = endRange.getBoundingClientRect();
    if (!endRect || (endRect.width === 0 && endRect.height === 0)) {
      removeSentenceButton();
      return;
    }

    if (!sentenceBtnEl) {
      sentenceBtnEl = document.createElement('button');
      sentenceBtnEl.type = 'button';
      sentenceBtnEl.className = 'lv-sentence-btn';
      sentenceBtnEl.textContent = '译';
      sentenceBtnEl.title = '翻译该句（' + shortcut + '）';
      // 阻止按钮抢走焦点导致选区被清除。
      sentenceBtnEl.addEventListener('mousedown', (e) => e.preventDefault());
      sentenceBtnEl.addEventListener('click', translateSelection);
      document.body.appendChild(sentenceBtnEl);
    }
    const size = 28; // 与 content.css 中按钮宽高保持一致
    const gap = 4;
    let left = endRect.right - size;
    let top = endRect.top - size - gap;
    left = Math.max(4, Math.min(left, window.innerWidth - size - 4));
    top = Math.max(4, top);
    sentenceBtnEl.style.left = left + 'px';
    sentenceBtnEl.style.top = top + 'px';
  }

  function removeSentenceButton() {
    if (sentenceBtnEl) {
      sentenceBtnEl.remove();
      sentenceBtnEl = null;
    }
  }

  // 关闭指定译文；不传参数则关闭全部（Esc 键使用）。
  function removeSentenceTranslation(el) {
    if (el) {
      const i = sentenceTransEls.indexOf(el);
      if (i !== -1) sentenceTransEls.splice(i, 1);
      if (el.parentNode) el.remove();
    } else {
      sentenceTransEls.forEach((e) => { if (e.parentNode) e.remove(); });
      sentenceTransEls.length = 0;
    }
  }

  async function translateSelection() {
    const sel = getSelectedSentence();
    if (!sel) return;
    const text = sel.text;
    removeSentenceButton();

    // 已收藏的句子直接复用译文，不再调用 API。
    let translation = findFavoritedTranslation(text);
    if (translation == null) {
      try {
        translation = await translateSentenceViaBg(text);
      } catch (err) {
        const rect = sel.range.getBoundingClientRect();
        showPopup(
          { clientX: rect.left, clientY: rect.top },
          { word: '', error: err.message, code: err.code }
        );
        return;
      }
    }
    if (!translation) return;
    showSentenceTranslation(sel.range, text, translation);
  }

  // 判定元素是否为块级容器（译文将作为其兄弟节点插入到其后）。
  function isBlockElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const display = window.getComputedStyle(el).display;
    return /block|list-item|flex|grid|table|table-row|table-cell|flow-root/.test(display);
  }

  // 找到选区所在的最近块级容器。
  function getBlockContainer(range) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node && node !== document.body && node.parentElement) {
      if (node.nodeType === Node.ELEMENT_NODE && isBlockElement(node)) return node;
      node = node.parentElement;
    }
    return document.body;
  }

  // 读取原句的计算样式，用于让译文尽量“融入”原网页。
  function getSourceStyle(range) {
    let el = range.commonAncestorContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return {};
    const cs = window.getComputedStyle(el);
    const out = {};
    ['fontFamily', 'fontSize', 'lineHeight', 'color', 'fontStyle', 'fontWeight', 'letterSpacing']
      .forEach((p) => { out[p] = cs[p]; });
    return out;
  }

  // 在块级容器后插入译文（表格/body 等特殊容器则追加到内部末尾，避免破坏布局）。
  function insertInlineTranslation(container, el) {
    const tag = container.tagName;
    if (tag === 'BODY' || tag === 'HTML' || tag === 'TD' || tag === 'TH' || tag === 'TR') {
      container.appendChild(el);
    } else {
      container.insertAdjacentElement('afterend', el);
    }
  }

  function showSentenceTranslation(range, text, translation) {
    const style = getSourceStyle(range);
    const key = normalizeText(text);

    // 同一句重复翻译时，先移除旧译文，避免叠加。
    const dup = sentenceTransEls.find((e) => e.dataset.normText === key);
    if (dup) removeSentenceTranslation(dup);

    const el = document.createElement('span');
    el.className = 'lv-inline-trans';
    el.dataset.normText = key;
    // 模仿原句字体样式，使其视觉上接近原文。
    if (style.fontFamily) el.style.fontFamily = style.fontFamily;
    if (style.fontSize) el.style.fontSize = style.fontSize;
    if (style.lineHeight) el.style.lineHeight = style.lineHeight;
    if (style.color) el.style.color = style.color;
    if (style.fontStyle) el.style.fontStyle = style.fontStyle;
    if (style.fontWeight) el.style.fontWeight = style.fontWeight;
    if (style.letterSpacing) el.style.letterSpacing = style.letterSpacing;

    const badge = document.createElement('span');
    badge.className = 'lv-inline-trans-badge';
    badge.textContent = '译';
    el.appendChild(badge);

    const transText = document.createElement('span');
    transText.className = 'lv-inline-trans-text';
    transText.textContent = translation;
    el.appendChild(transText);

    // 发音按钮：朗读原句。
    el.appendChild(LV_TTS.speakerButton(text));

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'lv-inline-trans-btn';
    favBtn.textContent = isFavorited(text) ? '已收藏' : '收藏';
    favBtn.addEventListener('click', () => {
      if (favoriteSentence(text, translation)) favBtn.textContent = '已收藏';
    });
    el.appendChild(favBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'lv-inline-trans-btn lv-inline-trans-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', () => removeSentenceTranslation(el));
    el.appendChild(closeBtn);

    // 紧贴选区末尾插入，确保译文出现在该句旁边，而非文章末尾。
    const endRange = range.cloneRange();
    endRange.collapse(false);
    try {
      endRange.insertNode(el);
    } catch (e) {
      // 极端情况下（如跨表格/特殊容器）退回插入到块级容器之后。
      insertInlineTranslation(getBlockContainer(range), el);
    }
    sentenceTransEls.push(el);
  }

  // 解析 "Ctrl+Alt+T" 这类快捷键字符串。
  function parseShortcut(shortcut) {
    const parts = String(shortcut || '').split('+').map((s) => s.trim());
    const mods = { ctrl: false, alt: false, shift: false, meta: false };
    let key = '';
    for (const p of parts) {
      const lower = p.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') mods.ctrl = true;
      else if (lower === 'alt') mods.alt = true;
      else if (lower === 'shift') mods.shift = true;
      else if (lower === 'meta' || lower === 'cmd' || lower === 'win') mods.meta = true;
      else key = p;
    }
    return { mods, key: key.toLowerCase() };
  }

  function matchesShortcut(event, shortcut) {
    const { mods, key } = parseShortcut(shortcut);
    if (!key || event.key.toLowerCase() !== key) return false;
    return (
      event.ctrlKey === mods.ctrl &&
      event.altKey === mods.alt &&
      event.shiftKey === mods.shift &&
      event.metaKey === mods.meta
    );
  }

  // 划句翻译的「译」按钮在鼠标松手后再出现（不再监听 selectionchange 实时弹出），
  // 松手后根据选择内容决定：短英文短语查本地词典，长句显示翻译按钮。
  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const phrase = getSelectedPhrase();
      if (phrase) handlePhrase(phrase);
      else showSentenceButton();
    }, 0);
  });

  document.addEventListener('click', (event) => {
    const t = event.target;
    if (popupEl && !popupEl.contains(t)) removePopup();
    if (hoverPopupEl && !hoverPopupEl.contains(t)) removeHoverPopup();
    if (sentenceBtnEl && !sentenceBtnEl.contains(t)) removeSentenceButton();
    // 行内译文已嵌入原文，不随点击其它区域而消失，仅通过「×」或 Esc 关闭。
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      removePopup();
      removeHoverPopup();
      removeSentenceButton();
      removeSentenceTranslation();
      return;
    }
    if (matchesShortcut(event, shortcut)) {
      // 仅在存在可翻译的句子选区时才拦截，避免影响正常输入。
      if (getSelectedSentence()) {
        event.preventDefault();
        event.stopPropagation();
        translateSelection();
      }
    }
  });

  window.addEventListener('scroll', () => {
    removePopup();
    removeHoverPopup();
    removeSentenceButton();
    scheduleToggleFade();
    // 行内译文随页面内容一起滚动，无需在滚动时清除。
  }, { passive: true });

  /* ---------------- 逐站点高亮开关 ---------------- */

  // 当前网页的 origin，作为逐站点开关的存储键。
  function currentOrigin() {
    return location.origin || (location.protocol + '//' + location.host);
  }

  let highlightToggleBtn = null;
  let highlightToggleWrap = null;
  let highlightGlobalBtn = null;
  let highlightBooksMenu = null;
  // 拖拽结束后抑制一次 click，避免误触“关闭高亮”开关。
  let suppressToggleClick = false;

  // 右侧按钮颜色：优先使用用户设置的 toggleColor，未设置则跟随主题色。
  function effectiveToggleColor() {
    return (appearance && appearance.toggleColor) || (appearance && appearance.accent) || '#2563eb';
  }

  // 右侧按钮透明度（0.1 ~ 1），默认 0.72。
  function effectiveToggleOpacity() {
    const o = parseFloat(appearance && appearance.toggleOpacity);
    return Number.isFinite(o) ? Math.min(1, Math.max(0.1, o)) : 0.72;
  }

  // 应用右侧按钮的颜色 / 透明度（关闭状态置为更醒目的中灰，避免太淡找不到）。
  function applyToggleStyle() {
    if (!highlightToggleBtn) return;
    highlightToggleBtn.style.setProperty('--lv-toggle-color', highlightDisabled ? '#6b7280' : effectiveToggleColor());
    highlightToggleBtn.style.setProperty('--lv-toggle-opacity', String(highlightDisabled ? 1 : effectiveToggleOpacity()));
    if (highlightGlobalBtn) {
      const c = effectiveToggleColor();
      // 未全局关闭时为「填充色按钮 + 白字」，全局关闭后变「白底 + 主题色字」，避免文字与背景同色看不清。
      highlightGlobalBtn.style.borderColor = c;
      highlightGlobalBtn.style.color = highlightGlobalOff ? c : '#ffffff';
      highlightGlobalBtn.style.backgroundColor = highlightGlobalOff ? '#ffffff' : c;
    }
  }

  // 同步主按钮视觉状态（开启 = 主题色“关”，关闭 = 灰色“开”）。
  function syncToggleButton() {
    if (!highlightToggleBtn) return;
    highlightToggleBtn.classList.toggle('lv-toggle-off', highlightDisabled);
    highlightToggleBtn.textContent = highlightDisabled ? '开' : '关';
    highlightToggleBtn.title = highlightDisabled
      ? '恢复本网页的生词高亮'
      : '关闭本网页的生词高亮';
    applyToggleStyle();
  }

  // 同步“关闭所有网页高亮”按钮的视觉状态。
  function syncGlobalButton() {
    if (!highlightGlobalBtn) return;
    highlightGlobalBtn.classList.toggle('lv-toggle-global-on', !highlightGlobalOff);
    highlightGlobalBtn.textContent = highlightGlobalOff ? '恢复所有网页高亮' : '关闭所有网页高亮';
    highlightGlobalBtn.title = highlightGlobalOff
      ? '重新在所有网页显示生词高亮'
      : '关闭所有网页的生词高亮';
    applyToggleStyle();
  }

  // 从后台拉取已导入的预设词书列表（id / name），用于悬停菜单。
  function fetchPresetBooks() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getPresetBooks' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          resolve([]);
          return;
        }
        resolve(res.books || []);
      });
    });
  }

  // 词书菜单里的颜色圆点：生词本用主题色，预设词书优先用独立高亮色，否则用暖色兜底。
  function bookColorOf(id) {
    if (id === 'own') return (appearance && appearance.accent) || '#2563eb';
    return (bookColors && bookColors[id]) || '#f59e0b';
  }

  // 渲染「屏蔽某本词书高亮」菜单（生词本 + 各预设词书）。
  // 词书名超长时截断为 6 个字符（超出用 … 代替），保持屏蔽菜单排版整洁。
  function shortBookName(name) {
    const s = String(name || '');
    return s.length > 6 ? s.slice(0, 6) + '…' : s;
  }

  function renderBooksMenu() {
    if (!highlightBooksMenu) return;
    highlightBooksMenu.innerHTML = '';
    const books = [{ id: 'own', name: '生词本' }].concat(presetBooks || []);
    for (const b of books) {
      const off = !!(hiddenBooks && hiddenBooks[b.id]);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lv-toggle-book' + (off ? ' lv-toggle-book-off' : '');
      btn.innerHTML =
        '<span class="lv-toggle-book-dot" style="background:' + bookColorOf(b.id) + '"></span>' +
        '<span>' + escapeHtml(shortBookName(b.name)) + '</span>';
      btn.title = off ? '恢复「' + b.name + '」的高亮' : '屏蔽「' + b.name + '」的高亮';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBookHidden(b.id);
      });
      highlightBooksMenu.appendChild(btn);
    }
  }

  // 切换某本词书的高亮屏蔽状态并持久化。
  function toggleBookHidden(id) {
    if (hiddenBooks[id]) delete hiddenBooks[id];
    else hiddenBooks[id] = true;
    chrome.storage.local.set({ hiddenBooks });
    renderBooksMenu();
    rebuildFormMap();
    highlightAll();
  }

  // 切换当前站点的高亮开关，并持久化到 chrome.storage.local。
  function setHighlightDisabled(on) {
    highlightDisabled = on;
    if (on) disabledSites[currentOrigin()] = true;
    else delete disabledSites[currentOrigin()];
    chrome.storage.local.set({ disabledSites });
    syncToggleButton();
    highlightAll();
  }

  // 切换“所有网页高亮”的全局总开关。
  function setGlobalHighlightOff(on) {
    highlightGlobalOff = on;
    chrome.storage.local.set({ globalHighlightOff: on });
    syncGlobalButton();
    highlightAll();
  }

  // 滚动时淡化主按钮，停止滚动后恢复。
  let scrollFadeTimer = null;
  function scheduleToggleFade() {
    if (!highlightToggleWrap) return;
    highlightToggleWrap.classList.add('lv-toggle-faded');
    if (scrollFadeTimer) clearTimeout(scrollFadeTimer);
    scrollFadeTimer = setTimeout(() => {
      highlightToggleWrap.classList.remove('lv-toggle-faded');
    }, 600);
  }

  // 拖拽主按钮调整位置；拖拽结束后保存到 chrome.storage.local，跨页面保持。
  function initToggleDrag(wrap, handle) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      const rect = wrap.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      wrap.classList.add('lv-toggle-dragging');
      if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      let left = origLeft + dx;
      let top = origTop + dy;
      left = Math.max(4, Math.min(left, window.innerWidth - wrap.offsetWidth - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - wrap.offsetHeight - 4));
      wrap.style.left = left + 'px';
      wrap.style.top = top + 'px';
      wrap.style.right = 'auto';
      wrap.style.transform = 'none';
    });

    const finish = () => {
      if (!dragging) return;
      dragging = false;
      wrap.classList.remove('lv-toggle-dragging');
      if (moved) {
        // 拖拽结束后的 click 由 suppressToggleClick 拦截，避免误触开关。
        suppressToggleClick = true;
        const rect = wrap.getBoundingClientRect();
        chrome.storage.local.set({ togglePos: { left: rect.left, top: rect.top } });
      }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  // 浏览器缩放 / 窗口尺寸变化时，把「拖拽后的绝对定位」按钮重新收拢到可视区域内，
  // 避免放大页面后按钮跑到屏幕外「消失」。默认右锚定模式（right/top 百分比）不受影响。
  function clampTogglePosition() {
    if (!highlightToggleWrap) return;
    // 仅处理拖拽后的绝对定位模式（此时 inline right 被置为 auto）。
    if (highlightToggleWrap.style.right !== 'auto') return;
    const margin = 4;
    const rect = highlightToggleWrap.getBoundingClientRect();
    let left = parseFloat(highlightToggleWrap.style.left);
    let top = parseFloat(highlightToggleWrap.style.top);
    if (!Number.isFinite(left)) left = rect.left;
    if (!Number.isFinite(top)) top = rect.top;
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin));
    highlightToggleWrap.style.left = left + 'px';
    highlightToggleWrap.style.top = top + 'px';
  }
  window.addEventListener('resize', clampTogglePosition);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', clampTogglePosition);
  }

  // 在网页右侧注入一个可拖拽的小圆钮：点击关闭/恢复当前网页高亮；
  // 悬停时弹出“关闭所有高亮”按钮与词书屏蔽菜单；滚动时淡化。
  function initHighlightToggle() {
    if (!document.body) return;

    highlightToggleWrap = document.createElement('div');
    highlightToggleWrap.className = 'lv-toggle-wrap';

    // 弹出层：悬停时在圆钮左侧展开（词书屏蔽菜单 + 关闭所有高亮按钮）。
    // 用绝对定位浮在圆钮左侧，展开/收起不改变圆钮位置，避免 hover 闪烁。
    const popover = document.createElement('div');
    popover.className = 'lv-toggle-popover';

    // 词书屏蔽菜单：悬停时列出「生词本 + 各预设词书」，点击某本即可单独屏蔽其高亮。
    highlightBooksMenu = document.createElement('div');
    highlightBooksMenu.className = 'lv-toggle-books';
    popover.appendChild(highlightBooksMenu);

    highlightGlobalBtn = document.createElement('button');
    highlightGlobalBtn.type = 'button';
    highlightGlobalBtn.className = 'lv-toggle-global';
    highlightGlobalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setGlobalHighlightOff(!highlightGlobalOff);
    });
    popover.appendChild(highlightGlobalBtn);

    highlightToggleWrap.appendChild(popover);

    highlightToggleBtn = document.createElement('button');
    highlightToggleBtn.type = 'button';
    highlightToggleBtn.className = 'lv-toggle';
    highlightToggleBtn.addEventListener('click', () => {
      if (suppressToggleClick) {
        suppressToggleClick = false;
        return;
      }
      setHighlightDisabled(!highlightDisabled);
    });
    highlightToggleWrap.appendChild(highlightToggleBtn);

    document.body.appendChild(highlightToggleWrap);
    syncToggleButton();
    syncGlobalButton();
    renderBooksMenu();
    initToggleDrag(highlightToggleWrap, highlightToggleBtn);

    // 恢复上次拖拽的位置（首次使用保持右侧居中）。
    chrome.storage.local.get('togglePos').then(({ togglePos }) => {
      if (togglePos && typeof togglePos.left === 'number' && typeof togglePos.top === 'number') {
        highlightToggleWrap.style.left = togglePos.left + 'px';
        highlightToggleWrap.style.top = togglePos.top + 'px';
        highlightToggleWrap.style.right = 'auto';
        highlightToggleWrap.style.transform = 'none';
        // 不同网页视口尺寸可能不同，载入后立即收拢到可视区内，避免跑到屏幕外「找不到」。
        clampTogglePosition();
      }
    });
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    // 先加载配置/外观以确定高亮色，再加载自有生词与预设词书并高亮。
    await loadSentences();
    await loadWords();
    await loadPresetWords();
    presetBooks = await fetchPresetBooks();
    initHighlightToggle();
    startObserver();
  }

  init();
})();
