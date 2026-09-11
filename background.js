/**
 * background.js —— Service Worker（后台服务）
 *
 * 职责：
 * 1. 点击扩展图标打开生词本标签页。
 * 2. 接收 content script 的翻译请求，按优先级查询：
 *       → 本地 ECDICT(IndexedDB) → 预设词表(IndexedDB)
 *      → 自定义 MDX 词典(IndexedDB，按优先级顺序) → 查询缓存(IndexedDB) → 翻译 API。
 * 3. 提供“加载完整词典(ECDICT)”能力：从 CDN 拉取 CSV 并解析后存入 IndexedDB。
 * 4. 有道翻译（英译中）与 v3 签名计算。
 */

// 加载内置精简词典（var BUILTIN_DICT）与词典存储模块（var DB_NAME/STORE_* 等）。
importScripts('dict-builtin.js', 'dict-store.js');

// 启动时加载「高频词和常见词」用户覆盖；后续存储变化时实时刷新，保证预设词表过滤一致。
loadCommonOverrides();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.commonWordOverrides) loadCommonOverrides();
});

// ECDICT 完整版 CSV 地址（raw.githubusercontent 无 20MB 单文件限制，jsDelivr 无法承载 66MB 文件）。
// 字段：word,phonetic,definition(英文释义),translation(中文释义,多义以换行分隔),pos,...
const ECDICT_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';
// 供用户手动下载的页面地址与文件名（下载失败提示用）。
const ECDICT_DOWNLOAD_PAGE = 'https://github.com/skywind3000/ECDICT';
const ECDICT_FILENAME = 'ecdict.csv';

/* ---------------- 翻译接口（多平台） ---------------- */

async function getConfig() {
  const data = await chrome.storage.local.get('config');
  return data.config || {};
}

/* ---------------- 自定义词典元数据 ---------------- */

// 多份自定义 MDX 词典的元信息：数组顺序即查询优先级（越靠前越先查）。
// 结构：{ id, title, count, addedAt }，存于 chrome.storage.local 并缓存在内存中。
let customDictsCache = null;

async function getCustomDicts() {
  if (customDictsCache) return customDictsCache;
  const data = await chrome.storage.local.get('customDicts');
  customDictsCache = Array.isArray(data.customDicts) ? data.customDicts : [];
  return customDictsCache;
}

async function setCustomDicts(list) {
  customDictsCache = list;
  await chrome.storage.local.set({ customDicts: list });
}

// 兼容旧版扁平有道配置 { appKey, appSecret }。
function youdaoCred(config) {
  if (config.youdao && (config.youdao.appKey || config.youdao.appSecret)) {
    return config.youdao;
  }
  return { appKey: config.appKey, appSecret: config.appSecret };
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// MD5（百度翻译签名需要；Web Crypto 不支持 MD5）。
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
  function hex32(x) {
    let h = '';
    for (let i = 0; i < 4; i++) h += ('0' + ((x >>> (i * 8)) & 0xff).toString(16)).slice(-2);
    return h;
  }

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  for (let off = 0; off < paddedLen; off += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      B = (B + rotl((A + F + K[i] + M[g]) | 0, S[i])) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  return hex32(a0) + hex32(b0) + hex32(c0) + hex32(d0);
}

function netErr() {
  const err = new Error('网络请求失败，请检查网络连接');
  err.code = 'NETWORK';
  return err;
}

function apiErr(msg) {
  const err = new Error(msg);
  err.code = 'API';
  return err;
}

function noConfigErr(msg) {
  const err = new Error(msg);
  err.code = 'NO_CONFIG';
  return err;
}

// 有道翻译（英译中），返回 { translation, phonetic, explains }。
async function translateViaYoudao(text) {
  const cfg = youdaoCred(await getConfig());
  if (!cfg.appKey || !cfg.appSecret) {
    throw noConfigErr('未配置有道翻译的 appKey / appSecret');
  }

  const salt = crypto.randomUUID();
  const curtime = String(Math.floor(Date.now() / 1000));
  const input =
    text.length <= 20
      ? text
      : text.slice(0, 10) + text.length + text.slice(text.length - 10, text.length);
  const sign = await sha256(cfg.appKey + input + salt + curtime + cfg.appSecret);

  const body = new URLSearchParams({
    q: text,
    from: 'en',
    to: 'zh-CHS',
    appKey: cfg.appKey,
    salt,
    sign,
    signType: 'v3',
    curtime,
  });

  let res;
  try {
    res = await fetch('https://openapi.youdao.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    throw netErr();
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw apiErr('有道翻译接口返回异常');
  }

  if (data.errorCode && data.errorCode !== '0') {
    throw apiErr('有道翻译失败（错误码：' + data.errorCode + '）');
  }

  return {
    translation: (data.translation && data.translation[0]) || '',
    phonetic: (data.basic && data.basic.phonetic) || '',
    explains: (data.basic && data.basic.explains) || [],
  };
}

// 百度翻译（通用文本翻译），返回 { translation }。
async function translateViaBaidu(text) {
  const config = await getConfig();
  const cfg = config.baidu || {};
  if (!cfg.appId || !cfg.secret) {
    throw noConfigErr('未配置百度翻译的 appid / 密钥');
  }

  const salt = String(Math.floor(Math.random() * 1e10));
  const sign = md5(cfg.appId + text + salt + cfg.secret);
  const body = new URLSearchParams({
    q: text,
    from: 'en',
    to: 'zh',
    appid: cfg.appId,
    salt,
    sign,
  });

  let res;
  try {
    res = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    throw netErr();
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw apiErr('百度翻译接口返回异常');
  }

  if (data.error_code && String(data.error_code) !== '52000') {
    throw apiErr('百度翻译失败（' + data.error_code + '：' + (data.error_msg || '未知错误') + '）');
  }

  const translation =
    data.trans_result && data.trans_result.length
      ? data.trans_result.map((t) => t.dst).join('')
      : '';
  return { translation, phonetic: '', explains: [] };
}

// Google 翻译（Cloud Translation v2），返回 { translation }。
async function translateViaGoogle(text) {
  const config = await getConfig();
  const cfg = config.google || {};
  if (!cfg.apiKey) {
    throw noConfigErr('未配置 Google 翻译 API Key');
  }

  let res;
  try {
    res = await fetch(
      'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(cfg.apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: 'en', target: 'zh-CN', format: 'text' }),
      }
    );
  } catch (e) {
    throw netErr();
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw apiErr('Google 翻译接口返回异常');
  }

  if (data.error) {
    throw apiErr('Google 翻译失败（' + (data.error.code || '') + '：' + (data.error.message || '未知错误') + '）');
  }

  const translation =
    data.data && data.data.translations && data.data.translations.length
      ? data.data.translations[0].translatedText
      : '';
  return { translation, phonetic: '', explains: [] };
}

// 彩云小译（translator v1），返回 { translation }。
async function translateViaCaiyun(text) {
  const config = await getConfig();
  const cfg = config.caiyun || {};
  if (!cfg.token) {
    throw noConfigErr('未配置彩云小译 Token');
  }

  let res;
  try {
    res = await fetch('https://api.interpreter.caiyunai.com/v1/translator', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-authorization': 'token ' + cfg.token,
      },
      body: JSON.stringify({
        source: [text],
        trans_type: 'en2zh',
        request_id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        detect: false,
      }),
    });
  } catch (e) {
    throw netErr();
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw apiErr('彩云小译接口返回异常');
  }

  const translation = data.target && data.target.length ? data.target[0] : '';
  if (!translation) {
    throw apiErr('彩云小译返回为空（可能是 token 无效或额度不足）');
  }
  return { translation, phonetic: '', explains: [] };
}

// 通用 OpenAI 兼容对话接口（DeepSeek / OpenAI / 其他兼容端点）。
// 用系统提示词约束“只输出简体中文译文”，temperature 调低以稳定输出。
async function translateViaOpenAICompat(url, apiKey, model, text) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              '你是一名中英翻译助手。请把用户输入的英文翻译成简体中文，只输出译文本身，不要解释、不要音标、不要原文。',
          },
          { role: 'user', content: text },
        ],
      }),
    });
  } catch (e) {
    throw netErr();
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw apiErr('大模型接口返回异常');
  }

  if (data.error) {
    throw apiErr('翻译失败（' + (data.error.message || data.error.code || '未知错误') + '）');
  }

  const translation =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  return { translation: (translation || '').trim(), phonetic: '', explains: [] };
}

// DeepSeek（OpenAI 兼容）。
async function translateViaDeepseek(text) {
  const config = await getConfig();
  const cfg = config.deepseek || {};
  if (!cfg.apiKey) {
    throw noConfigErr('未配置 DeepSeek API Key');
  }
  return translateViaOpenAICompat(
    'https://api.deepseek.com/chat/completions',
    cfg.apiKey,
    cfg.model || 'deepseek-chat',
    text
  );
}

// OpenAI / 其他 GPT 兼容端点。
async function translateViaGPT(text) {
  const config = await getConfig();
  const cfg = config.gpt || {};
  if (!cfg.apiKey) {
    throw noConfigErr('未配置 OpenAI API Key');
  }
  return translateViaOpenAICompat(
    cfg.baseUrl || 'https://api.openai.com/v1/chat/completions',
    cfg.apiKey,
    cfg.model || 'gpt-4o-mini',
    text
  );
}

// Google Gemini（原生 generateContent 接口）。
async function translateViaGemini(text) {
  const config = await getConfig();
  const cfg = config.gemini || {};
  if (!cfg.apiKey) {
    throw noConfigErr('未配置 Gemini API Key');
  }

  const model = cfg.model || 'gemini-1.5-flash';
  let res;
  try {
    res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) +
        ':generateContent?key=' +
        encodeURIComponent(cfg.apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    '把以下英文翻译成简体中文，只输出译文本身，不要解释、不要音标、不要原文：\n' + text,
                },
              ],
            },
          ],
        }),
      }
    );
  } catch (e) {
    throw netErr();
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw apiErr('Gemini 接口返回异常');
  }

  if (data.error) {
    throw apiErr('Gemini 翻译失败（' + (data.error.message || data.error.code || '未知错误') + '）');
  }

  const candidate =
    data.candidates && data.candidates[0] && data.candidates[0].content;
  const translation =
    candidate && candidate.parts && candidate.parts.length ? candidate.parts[0].text : '';
  return { translation: (translation || '').trim(), phonetic: '', explains: [] };
}

const PROVIDERS = {
  youdao: translateViaYoudao,
  baidu: translateViaBaidu,
  google: translateViaGoogle,
  caiyun: translateViaCaiyun,
  deepseek: translateViaDeepseek,
  gemini: translateViaGemini,
  gpt: translateViaGPT,
};

// 根据用户选择的接口翻译，返回 { translation, phonetic, explains }。
async function translateViaProvider(text) {
  const config = await getConfig();
  const provider = config.provider || 'youdao';
  const fn = PROVIDERS[provider] || translateViaYoudao;
  return fn(text);
}

// 句子翻译：始终调用用户选择的翻译接口。
async function translateSentence(text) {
  const result = await translateViaProvider(text);
  return result.translation || '';
}

/* ---------------- 词典查询 ---------------- */

// 把 ECDICT 的 translation 字段（如 "n. 工业\nn. 行业\nn. 勤劳"）解析成结构化义项。
// 兼容两种换行：真实换行符，以及字面量 "\n"（反斜杠+n）。
function parseSenses(translation) {
  const lines = String(translation || '')
    .replace(/\\n/g, '\n')
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const senses = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z]+\.?)\s*(.*)$/);
    if (m && m[2]) {
      senses.push({ pos: m[1].replace(/\.$/, ''), text: m[2] });
    } else {
      senses.push({ pos: '', text: line });
    }
  }
  return senses;
}

// 标准化为一个统一的结果结构：{ translation, phonetic, explains, senses, definitions,
// source, sourceId, html }。sourceId 用于标识具体命中源（如 custom:<dictId>），
// html 为自定义词典的原始 HTML 释义（用于带样式的渲染，其他源为空）。
function standardize(obj, source) {
  const senses =
    obj.senses && obj.senses.length
      ? obj.senses
      : (obj.explains || []).map((text) => ({ pos: '', text }));
  return {
    translation: obj.translation || (senses.length ? senses[0].text : ''),
    phonetic: obj.phonetic || '',
    explains: obj.explains || senses.map((s) => s.text),
    senses,
    definitions: obj.definitions || [],
    source,
    sourceId: obj.sourceId || source,
    html: obj.html || '',
  };
}

// 按某个词典源 ID 查询一个单词，命中返回标准化结果，未命中返回 null。
async function lookupBySource(sourceId, word) {
  if (sourceId === 'builtin') {
    if (BUILTIN_DICT && BUILTIN_DICT[word]) {
      return standardize(
        {
          translation: BUILTIN_DICT[word].t,
          phonetic: BUILTIN_DICT[word].p,
          senses: parseSenses(String(BUILTIN_DICT[word].t || '').replace(/；/g, '\n')),
        },
        'builtin'
      );
    }
    return null;
  }

  if (sourceId === 'ecdict') {
    const local = await idbGet(STORE_DICT, word);
    if (local) {
      const senses = parseSenses(local.t);
      return standardize(
        {
          translation: senses.length ? senses[0].text : local.t,
          phonetic: local.p,
          senses,
          definitions: String(local.d || '')
            .replace(/\\n/g, '\n')
            .split(/\r?\n+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
        'local'
      );
    }
    return null;
  }

  if (sourceId === 'preset') {
    const preset = await idbGet(STORE_PRESET, word);
    if (preset) {
      const senses = parseSenses(preset.t);
      return standardize(
        {
          translation: senses.length ? senses[0].text : preset.t,
          phonetic: preset.p || '',
          senses,
        },
        'preset'
      );
    }
    return null;
  }

  if (sourceId.indexOf('custom:') === 0) {
    const did = sourceId.slice('custom:'.length);
    const custom = await idbGet(STORE_CUSTOM, did + '\u0000' + word);
    if (custom) {
      const text = String(custom.text || '').trim();
      const firstLine = text.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean)[0] || '';
      return standardize(
        {
          translation: firstLine,
          phonetic: '',
          senses: [{ pos: '', text }],
          // 携带原始 HTML 与具体词典 id，供生词本按当前优先级渲染带样式的释义。
          html: custom.html || '',
          sourceId: 'custom:' + did,
        },
        'custom'
      );
    }
    return null;
  }

  return null;
}

// 仅查本地（按用户设置的优先级顺序 → 查询缓存），不触发翻译 API。
// 命中返回标准化结果；未命中返回 null。
// skipCache 为 true 时跳过查询缓存：缓存可能残留历史错误词形（如把 conditioning 误存为
// conditione），不能作为词形还原候选词“谁才是正确原型”的判断依据。
async function lookupCachedWord(rawWord, skipCache) {
  const word = rawWord.toLowerCase();

  // 按用户排序后的词典源依次查询：内置 / 完整 / 自定义，均可调整优先级。
  const order = await getDictOrder();
  for (const sourceId of order) {
    const hit = await lookupBySource(sourceId, word);
    if (hit) return hit;
  }

  // 预设词表是词书而非词典，不参与上面的排序，但仍作为本地词表源在词典之后兜底查询。
  const presetHit = await lookupBySource('preset', word);
  if (presetHit) return presetHit;

  // 查询缓存（词形还原校验时可跳过，避免历史错误词形污染判断）
  if (!skipCache) {
    const cached = await idbGet(STORE_CACHE, word);
    if (cached) {
      return standardize(cached, 'cache');
    }
  }

  return null;
}

// 四级查询：内置词典 → ECDICT(IndexedDB) → 缓存(IndexedDB) → 有道 API。
async function lookupWord(rawWord) {
  const word = rawWord.toLowerCase();

  const local = await lookupCachedWord(word);
  if (local) return local;

  // 4) 用户选择的翻译接口，并写入缓存
  const result = await translateViaProvider(word);
  await idbPutAll(STORE_CACHE, [{ word, ...result }]);
  return standardize(result, 'api');
}

/* ---------------- ECDICT 词典下载与加载 ---------------- */

// 广播词典加载进度到扩展页面（review.html），无接收者时忽略错误。
function broadcastDictProgress(payload) {
  try {
    const p = chrome.runtime.sendMessage({ type: 'loadDictProgress', ...payload });
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* 忽略 */ }
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function concatUint8(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// 从网络流式下载 ECDICT CSV（带进度/速度），解析并入库。
async function loadDictionary() {
  broadcastDictProgress({ phase: 'download', loaded: 0, total: 0, speed: 0 });

  let res;
  try {
    res = await fetch(ECDICT_URL);
  } catch (e) {
    throw new Error(
      '词典下载失败（网络错误：' + (e && e.message ? e.message : '未知') + '）\n' +
      '下载地址：' + ECDICT_URL + '\n' +
      '若反复失败，可到 ' + ECDICT_DOWNLOAD_PAGE + ' 手动下载 ' + ECDICT_FILENAME + ' 后使用「本地载入」。'
    );
  }
  if (!res.ok) {
    throw new Error(
      '词典下载失败（HTTP ' + res.status + ' ' + (res.statusText || '') + '）\n' +
      '下载地址：' + ECDICT_URL + '\n' +
      '若反复失败，可到 ' + ECDICT_DOWNLOAD_PAGE + ' 手动下载 ' + ECDICT_FILENAME + ' 后使用「本地载入」。'
    );
  }

  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  const start = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const elapsed = Math.max(1, Date.now() - start);
    const speed = loaded / (elapsed / 1000);
    broadcastDictProgress({ phase: 'download', loaded, total, speed });
  }

  broadcastDictProgress({ phase: 'parse', loaded, total, speed: 0 });
  const text = new TextDecoder('utf-8').decode(concatUint8(chunks));
  return loadCSVIntoDB(text, (p) =>
    broadcastDictProgress({
      phase: p.phase,
      loaded,
      total,
      speed: 0,
      rowCount: p.rowCount,
      done: p.done,
      writeTotal: p.total,
    })
  );
}

// 下载并「合并」一份补充词典（ECDICT 兼容 CSV：word,phonetic,definition,translation,pos）。
// 与 loadDictionary 不同：不清空现有词典，按 word 覆盖/新增，用于接入第二套词典或词条补丁。
async function loadSupplementDictionary(url) {
  const target = String(url || '').trim();
  if (!target) throw new Error('未提供补充词典下载地址。');

  broadcastDictProgress({ phase: 'download', loaded: 0, total: 0, speed: 0 });

  let res;
  try {
    res = await fetch(target);
  } catch (e) {
    throw new Error(
      '补充词典下载失败（网络错误：' + (e && e.message ? e.message : '未知') + '）\n地址：' + target
    );
  }
  if (!res.ok) {
    throw new Error(
      '补充词典下载失败（HTTP ' + res.status + ' ' + (res.statusText || '') + '）\n地址：' + target
    );
  }

  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  const start = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const elapsed = Math.max(1, Date.now() - start);
    const speed = loaded / (elapsed / 1000);
    broadcastDictProgress({ phase: 'download', loaded, total, speed });
  }

  broadcastDictProgress({ phase: 'parse', loaded, total, speed: 0 });
  const text = new TextDecoder('utf-8').decode(concatUint8(chunks));
  return mergeCSVIntoDB(text, (p) =>
    broadcastDictProgress({
      phase: p.phase,
      loaded,
      total,
      speed: 0,
      rowCount: p.rowCount,
      done: p.done,
      writeTotal: p.total,
    })
  );
}

/* ---------------- 预设生词表与自定义词典 ---------------- */

// 解析「单词<TAB>释义」格式的开源词表（KyleBing/english-vocabulary）。
function parseTabList(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf('\t');
    if (idx <= 0) continue;
    const word = line.slice(0, idx).trim().replace(/\*+$/, '').toLowerCase();
    const def = line.slice(idx + 1).trim();
    if (!word || !def) continue;
    rows.push({ word, t: def, p: '' });
  }
  return rows;
}

// 解析「word   /音标/ 词性. 释义」格式的词表（leotse28/AGMess/ieltsWords.txt）。
// 注意：该词表除单词外还包含短语（kung fu、pull up stakes、roll film 等）以及连字符词
// （easy-going、up-to-date）。头词由若干「英文单词」组成（单词间以空格分隔，允许连字符、
// 撇号、斜杠，词尾可带 * 标记），定义部分则以音标（/.../、[...] 或 {...}）、词性（n. 等）
// 或中文释义开头。
function parseIeltsList(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  // 头词中的单个 token：以字母开头，可含连字符/撇号，允许形如 around/round 的斜杠变体，
  // 词尾允许 * 标记；不含句点，因此 n.、a.、vt. 等词性不会被误判为头词的一部分。
  const HEAD_TOKEN = /^[A-Za-z][A-Za-z'’\-]*(?:\/[A-Za-z][A-Za-z'’\-]*)?\*?$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    let i = 0;
    const headTokens = [];
    while (i < tokens.length && HEAD_TOKEN.test(tokens[i])) {
      headTokens.push(tokens[i]);
      i++;
    }
    if (!headTokens.length) continue;
    const word = headTokens.join(' ').replace(/\*+$/, '').toLowerCase();
    let rest = tokens.slice(i).join(' ').trim();
    // 提取音标：支持 /.../、[...] 与 {...} 三种写法。
    let phonetic = '';
    const pm = rest.match(/^(\/[^/]+\/|\[[^\]]+\]|\{[^}]+\})/);
    if (pm) {
      phonetic = pm[0];
      rest = rest.slice(pm[0].length).trim();
    }
    if (!word || !rest) continue;
    rows.push({ word, t: rest, p: phonetic });
  }
  return rows;
}

// 把一个预设词表下载、解析并合并进 STORE_PRESET（同一单词可归属多个来源，幂等）。
async function importPreset(presetId) {
  const src = PRESET_SOURCES.find((s) => s.id === presetId);
  if (!src) throw new Error('未知的预设词表：' + presetId);

  let res;
  try {
    res = await fetch(src.url);
  } catch (e) {
    throw new Error('词表下载失败（网络错误）：' + (e && e.message ? e.message : '未知'));
  }
  if (!res.ok) {
    throw new Error('词表下载失败（HTTP ' + res.status + ' ' + (res.statusText || '') + '）');
  }

  const text = await res.text();
  const rows = src.parser === 'ielts' ? parseIeltsList(text) : parseTabList(text);
  if (!rows.length) throw new Error('词表解析结果为空，请稍后重试。');

  // 读取现有预设词条，合并来源（幂等：已含该来源的单词不重复写）。
  const existing = await idbGetAll(STORE_PRESET);
  const map = new Map();
  for (const e of existing) map.set(e.word, e);

  let added = 0;
  const BATCH = 2000;
  let batch = [];
  async function flush() {
    if (!batch.length) return;
    await idbPutAll(STORE_PRESET, batch);
    batch = [];
  }

  for (const r of rows) {
    let cur = map.get(r.word);
    if (cur) {
      if (!cur.sources) cur.sources = [];
      if (cur.sources.includes(presetId)) continue; // 已存在，跳过
      cur.sources.push(presetId);
      if (!cur.t && r.t) cur.t = r.t;
      if (!cur.p && r.p) cur.p = r.p;
    } else {
      cur = { word: r.word, t: r.t, p: r.p, sources: [presetId] };
      map.set(r.word, cur);
    }
    batch.push(cur);
    added++;
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  // 预设词条发生变化后递增版本号，通知各网页 content script 重新拉取高亮词集。
  await bumpPresetRevision();

  // 记录本次导入时间（新增了词时才记），供扩展页面日历「添加词书」高亮。
  if (added > 0) {
    const data = await chrome.storage.local.get('presetImportDates');
    const dates = data.presetImportDates || {};
    dates[presetId] = Date.now();
    await chrome.storage.local.set({ presetImportDates: dates });
  }

  return { added, total: rows.length };
}

// 从 STORE_PRESET 中移除某个预设词表（该单词还属于其他来源时仅剔除该来源，否则删除）。
async function removePreset(presetId) {
  const all = await idbGetAll(STORE_PRESET);
  const toUpdate = [];
  const toDelete = [];
  for (const e of all) {
    if (e.sources && e.sources.includes(presetId)) {
      e.sources = e.sources.filter((s) => s !== presetId);
      if (e.sources.length) toUpdate.push(e);
      else toDelete.push(e.word);
    }
  }
  if (toUpdate.length) await idbPutAll(STORE_PRESET, toUpdate);
  await idbDeleteAll(STORE_PRESET, toDelete);

  // 同步清理该词表的过滤配置与复习进度，避免残留（重新导入时从零开始）。
  const [filtersData, stateData] = await Promise.all([
    chrome.storage.local.get('presetFilters'),
    chrome.storage.local.get('presetState'),
  ]);
  const filters = filtersData.presetFilters || {};
  if (filters[presetId]) {
    delete filters[presetId];
    await chrome.storage.local.set({ presetFilters: filters });
  }
  const state = stateData.presetState || {};
  const prefix = presetId + '\u0000';
  let stateChanged = false;
  for (const key of Object.keys(state)) {
    if (key.indexOf(prefix) === 0) {
      delete state[key];
      stateChanged = true;
    }
  }
  if (stateChanged) await chrome.storage.local.set({ presetState: state });

  // 同步清理该词书的导入时间记录，避免日历继续高亮已移除的词书。
  const importData = await chrome.storage.local.get('presetImportDates');
  if (importData.presetImportDates && importData.presetImportDates[presetId]) {
    delete importData.presetImportDates[presetId];
    await chrome.storage.local.set({ presetImportDates: importData.presetImportDates });
  }

  await bumpPresetRevision();
  return toDelete.length + toUpdate.length;
}

// 词书生成：把解析出的单词（含频次）写入 STORE_PRESET 作为一本新词书，并保存元信息。
async function generateBook({ id, name, words }) {
  if (!id || !name) throw new Error('缺少词书 id 或名称');
  const list = Array.isArray(words) ? words : [];
  if (!list.length) throw new Error('没有可写入的单词');

  const existing = await idbGetAll(STORE_PRESET);
  const map = new Map();
  for (const e of existing) map.set(e.word, e);

  let added = 0;
  const BATCH = 2000;
  let batch = [];
  async function flush() {
    if (!batch.length) return;
    await idbPutAll(STORE_PRESET, batch);
    batch = [];
  }

  for (const w of list) {
    const word = String((w && w.word) || '').toLowerCase();
    if (!word) continue;
    let cur = map.get(word);
    if (cur) {
      if (!cur.sources) cur.sources = [];
      if (!cur.sources.includes(id)) cur.sources.push(id);
    } else {
      cur = { word, t: '', p: '', sources: [id] };
      map.set(word, cur);
    }
    batch.push(cur);
    added++;
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  await bumpPresetRevision();

  // 记录本次导入时间，供扩展页面日历「添加词书」高亮。
  const data = await chrome.storage.local.get('presetImportDates');
  const dates = data.presetImportDates || {};
  dates[id] = Date.now();
  await chrome.storage.local.set({ presetImportDates: dates });

  // 生成阶段已按用户选择完成「剔除常见词」，这里把 removeCommon 置为 false，
  // 避免后续高亮/背单词再次把已收录的常见词过滤掉（用户不剔除时应原样保留）。
  const filterData = await chrome.storage.local.get('presetFilters');
  const filters = filterData.presetFilters || {};
  filters[id] = Object.assign({}, filters[id] || {}, {
    removeCommon: false,
    removeMemorized: true,
    enrichLocal: true,
    supplementExamples: true,
  });
  await chrome.storage.local.set({ presetFilters: filters });

  // 保存生成的词书元信息，供词书生成页展示与删除。
  const gbData = await chrome.storage.local.get('generatedBooks');
  const generatedBooks = gbData.generatedBooks || {};
  generatedBooks[id] = { id, name, count: added, createdAt: Date.now() };
  await chrome.storage.local.set({ generatedBooks });

  return { added, total: list.length };
}

// 删除一本生成的词书：复用 removePreset 移除该来源与复习进度，并清理元信息。
async function deleteGeneratedBook(id) {
  await removePreset(id);
  const gbData = await chrome.storage.local.get('generatedBooks');
  const generatedBooks = gbData.generatedBooks || {};
  if (generatedBooks[id]) {
    delete generatedBooks[id];
    await chrome.storage.local.set({ generatedBooks });
  }
  return true;
}

// 重命名一本生成的词书（仅更新元信息，词条归属 id 不变）。
async function renameGeneratedBook(id, name) {
  const next = String(name || '').trim();
  if (!id || !next) throw new Error('缺少词书 id 或新名称');
  const gbData = await chrome.storage.local.get('generatedBooks');
  const generatedBooks = gbData.generatedBooks || {};
  if (!generatedBooks[id]) throw new Error('词书不存在');
  generatedBooks[id].name = next;
  await chrome.storage.local.set({ generatedBooks });
  return true;
}

// 批量校验单词是否存在于本地词典（内置精简 + 完整 ECDICT），用于词书生成时过滤非词汇。
async function validateWords(words) {
  const uniq = Array.from(new Set((words || []).map((w) => String(w).toLowerCase()).filter(Boolean)));
  const found = new Set();
  // 内置精简词典
  for (const w of uniq) if (BUILTIN_DICT[w]) found.add(w);
  // 完整 ECDICT（分块读取，避免单次事务过大）
  const CHUNK = 5000;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const dict = await idbGetAllByKeys(STORE_DICT, slice);
    for (const w of slice) if (dict[w]) found.add(w);
  }
  return uniq.filter((w) => found.has(w));
}

// 预设词表内容发生变化后递增版本号，通知各网页 content script 重新拉取高亮词集。
async function bumpPresetRevision() {
  const data = await chrome.storage.local.get('presetRevision');
  await chrome.storage.local.set({ presetRevision: (data.presetRevision || 0) + 1 });
}

// 供 content script 拉取预设词表（用于网页高亮），返回精简字段：word / sources / t / p。
// sources 为「剔除高频词和常见词 / 剔除已背单词」过滤后仍可见的来源；来源为空则该词不参与高亮。
async function getPresetWords() {
  await loadCommonOverrides();
  const [all, filtersData, stateData] = await Promise.all([
    idbGetAll(STORE_PRESET),
    chrome.storage.local.get('presetFilters'),
    chrome.storage.local.get('presetState'),
  ]);
  const filters = filtersData.presetFilters || {};
  const presetState = stateData.presetState || {};
  // 返回全部预设词（含已背/被剔除高频词和常见词的词）：sources 为全部来源，visibleSources 为
  // 「剔除高频词和常见词 / 剔除已背单词」后仍可高亮的来源。这样已背的词即使不再高亮，content script
  // 仍能识别它属于预设词书，双击即可「放回词书」而非误加入生词本。
  return all.map((e) => ({
    word: e.word,
    sources: e.sources || [],
    visibleSources: visiblePresetSources(e.word, e.sources, filters, presetState),
    t: e.t,
    p: e.p,
  }));
}

// 双击网页中的预设词时，在「已背 / 待背」之间切换其复习状态。
// 已背的预设词会被「剔除已背单词」过滤，从而不再在网页中高亮；再次双击则恢复高亮。
async function togglePresetMemorized(word, sources) {
  const data = await chrome.storage.local.get('presetState');
  const presetState = data.presetState || {};
  const ids = Array.isArray(sources) ? sources : [];
  const now = Date.now();

  // 只要该词在任意一个所属词书中已背，就整体视为已背 → 本次切换为「放回词书」；否则标记为已背。
  let anyMemorized = false;
  for (const id of ids) {
    const key = id + '\u0000' + word;
    const st = presetState[key] || {};
    if (st.status === 'memorized') anyMemorized = true;
  }
  const targetStatus = anyMemorized ? 'pending' : 'memorized';

  for (const id of ids) {
    const key = id + '\u0000' + word;
    const st = presetState[key] || {};
    presetState[key] = Object.assign({}, st, {
      status: targetStatus,
      memorizedAt: targetStatus === 'memorized' ? now : null,
    });
  }

  await chrome.storage.local.set({ presetState });
  // 刷新各网页的预设词高亮，使状态变化立即生效。
  await bumpPresetRevision();
  return { memorized: targetStatus === 'memorized' };
}

// 返回已导入（词条数 > 0）的预设词书列表，供 content script 悬停菜单展示「屏蔽某本词书高亮」。
async function getPresetBooks() {
  const [presetAll, gbData] = await Promise.all([
    idbGetAll(STORE_PRESET),
    chrome.storage.local.get('generatedBooks'),
  ]);
  const generatedBooks = gbData.generatedBooks || {};
  // 内置预设词书 + 用户生成的自定义词书，一并用于 content script 的「屏蔽词书」菜单。
  const sources = PRESET_SOURCES.concat(
    Object.values(generatedBooks).map((g) => ({ id: g.id, name: g.name || g.id }))
  );
  return sources
    .map((s) => {
      let count = 0;
      for (const e of presetAll) {
        if (e.sources && e.sources.includes(s.id)) count++;
      }
      return { id: s.id, name: s.name, count };
    })
    .filter((b) => b.count > 0);
}

// 用本地 ECDICT 为预设词条补充结构化释义（音标/词性多义/英文释义），标记 _enriched 避免重复处理。
// 可选传入 presetId，仅补充归属该词书的词（新增词书后自动执行时按词书隔离）。
async function enrichPresetFromDict(presetId) {
  const presetAll = await idbGetAll(STORE_PRESET);
  const need = presetAll.filter((e) => {
    if (e._enriched) return false;
    if (presetId) return !!(e.sources && e.sources.includes(presetId));
    return true;
  });
  if (!need.length) return { enriched: 0, total: 0 };
  const dict = await idbGetAllByKeys(STORE_DICT, need.map((e) => e.word));
  const batch = [];
  for (const e of need) {
    const d = dict[e.word];
    if (!d) continue;
    e.p = e.p || d.p || '';
    e.senses = parseSenses(d.t);
    e.definitions = String(d.d || '')
      .replace(/\\n/g, '\n')
      .split(/\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    e._enriched = true;
    batch.push(e);
  }
  if (batch.length) await idbPutAll(STORE_PRESET, batch);
  return { enriched: batch.length, total: need.length };
}

// 从免费在线词典拉取某个单词的例句（最多 3 条），失败或未收录时返回空数组。
async function fetchExampleForWord(word) {
  let res;
  try {
    res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
  } catch (e) {
    return [];
  }
  if (!res.ok) return [];
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return [];
  }
  const examples = [];
  if (Array.isArray(data)) {
    for (const entry of data) {
      for (const m of (entry.meanings || [])) {
        for (const d of (m.definitions || [])) {
          if (d.example) examples.push(d.example);
        }
      }
    }
  }
  return examples.slice(0, 3);
}

// 后台缓慢为预设词条补充例句：每次最多处理 limit 个词，返回剩余待处理数量，
// 由扩展页面分多次调用以平稳推进（避免一次性大量请求触发限流）。
// 可选传入 presetId，仅处理归属该词书的词（新增词书后自动执行时按词书隔离）。
async function supplementPresetExamples(limit, presetId) {
  const cap = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const presetAll = await idbGetAll(STORE_PRESET);
  const scope = presetId
    ? presetAll.filter((e) => e.sources && e.sources.includes(presetId))
    : presetAll;
  // 仅重试「还没有例句」的词；每个词最多重试 3 次，避免接口始终无结果的词陷入死循环。
  const retryable = scope
    .filter((e) => !(e.examples && e.examples.length))
    .filter((e) => (e._examplesRetries || 0) < 3)
    .sort((a, b) => (a._examplesRetries || 0) - (b._examplesRetries || 0))
    .slice(0, cap);
  if (!retryable.length) return { processed: 0, remaining: 0 };
  const batch = [];
  let found = 0;
  for (const e of retryable) {
    const examples = await fetchExampleForWord(e.word);
    e._examplesRetries = (e._examplesRetries || 0) + 1;
    if (examples.length) {
      e.examples = examples;
      e._examplesFetched = true;
      found++;
    }
    batch.push(e);
  }
  if (batch.length) await idbPutAll(STORE_PRESET, batch);
  // remaining = 仍缺例句且仍可重试的词数，用于前端判断是否继续推进。
  const remaining = scope
    .filter((e) => !(e.examples && e.examples.length))
    .filter((e) => (e._examplesRetries || 0) < 3).length;
  return { processed: found, remaining };
}

// 更新某本预设词表的过滤选项（剔除高频词和常见词 / 剔除已背单词 / 补充本地释义 / 后台补充例句），
// 并触发高亮词集刷新。四个选项默认开启；显式传入 false 时才关闭。
async function setPresetFilter(presetId, patch) {
  const data = await chrome.storage.local.get('presetFilters');
  const filters = data.presetFilters || {};
  const cur = filters[presetId] || {
    removeCommon: true,
    removeMemorized: true,
    enrichLocal: true,
    supplementExamples: true,
  };
  const next = Object.assign({}, cur, patch);
  filters[presetId] = next;
  await chrome.storage.local.set({ presetFilters: filters });
  await bumpPresetRevision();
  return filters;
}

// 新增一份自定义词典的元信息（导入完成后调用）。
async function addCustomDict(meta) {
  const list = await getCustomDicts();
  const next = list.filter((d) => d.id !== meta.id);
  next.push({ id: meta.id, title: meta.title || '未命名词典', count: meta.count || 0, addedAt: Date.now() });
  await setCustomDicts(next);
  await setDictOrder(await getDictOrder()); // 将新词典追加进优先级顺序
  return next;
}

// 移除一份自定义词典：删除其全部词条 + 元信息，并从优先级顺序中剔除。
async function removeCustomDict(dictId) {
  await idbDeleteByIndex(STORE_CUSTOM, 'byDict', dictId);
  await idbDeleteByIndex(STORE_RES, 'byDict', dictId);
  const list = await getCustomDicts();
  const next = list.filter((d) => d.id !== dictId);
  await setCustomDicts(next);
  await setDictOrder(await getDictOrder());
  return next;
}

// 调整自定义词典查询优先级（ids 为新的顺序）。
async function reorderCustomDicts(ids) {
  const list = await getCustomDicts();
  const map = new Map(list.map((d) => [d.id, d]));
  const next = [];
  for (const id of ids) {
    if (map.has(id)) next.push(map.get(id));
  }
  for (const d of list) {
    if (!next.some((x) => x.id === d.id)) next.push(d);
  }
  await setCustomDicts(next);
  return next;
}

// ---------------- 词典查询优先级（统一排序） ----------------

// 本地词典源的固定 ID：内置精简词典 / 完整 ECDICT；自定义词典用 custom:<id>。
// 预设词表（preset）是词书而非词典，不参与词典查询优先级排序。
const BASE_DICT_SOURCES = ['builtin', 'ecdict'];

// 读取查询优先级顺序（含内置/完整/自定义，越靠前越先查）。
// 若从未保存过，默认顺序为「内置 → 完整 → 各自定义词典」。
async function getDictOrder() {
  const data = await chrome.storage.local.get('dictOrder');
  const saved = data.dictOrder;
  const customs = await getCustomDicts();
  const customIds = customs.map((d) => 'custom:' + d.id);
  const all = BASE_DICT_SOURCES.concat(customIds);
  let order;
  if (Array.isArray(saved) && saved.length) {
    order = saved.filter((id) => all.includes(id));
    const present = new Set(order);
    for (const id of all) if (!present.has(id)) order.push(id);
  } else {
    order = all.slice();
  }
  return order;
}

async function setDictOrder(order) {
  await chrome.storage.local.set({ dictOrder: order });
}

// 调整查询优先级：ids 为用户提交的新顺序，缺失项自动补到末尾。
async function reorderDictOrder(ids) {
  const order = await getDictOrder();
  const next = ids.filter((id) => order.includes(id));
  for (const id of order) if (!next.includes(id)) next.push(id);
  await setDictOrder(next);
  return next;
}

// 汇总词典状态：完整词典、查询缓存、预设词表（分来源）、自定义词典列表、查询优先级。
async function getDictStatus() {
  const [dictCount, cacheCount, presetAll, customDicts] = await Promise.all([
    idbCount(STORE_DICT),
    idbCount(STORE_CACHE),
    idbGetAll(STORE_PRESET),
    getCustomDicts(),
  ]);
  const presets = PRESET_SOURCES.map((s) => {
    let count = 0;
    for (const e of presetAll) {
      if (e.sources && e.sources.includes(s.id)) count++;
    }
    return { id: s.id, name: s.name, count };
  });
  const dictOrder = await getDictOrder();
  // 例句补充进度：仅统计真正取得例句的词，避免把「已尝试但未找到例句」算作完成。
  const exampleDone = presetAll.filter((e) => e.examples && e.examples.length).length;
  const exampleStats = {
    done: exampleDone,
    total: presetAll.length,
    remaining: Math.max(0, presetAll.length - exampleDone),
  };
  return { dictCount, cacheCount, customDicts, presetCount: presetAll.length, presets, dictOrder, exampleStats };
}

/* ---------------- 消息处理 ---------------- */

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'translate') {
    lookupWord(message.text)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) =>
        sendResponse({ ok: false, code: err.code || 'ERROR', message: err.message || '翻译失败' })
      );
    return true;
  }

  // 仅查本地词典/缓存（不触发 API），用于 content.js 校验词形还原候选原型。
  if (message && message.type === 'dictLookup') {
    lookupCachedWord(message.text, true)
      .then((result) => {
        if (result) sendResponse({ ok: true, found: true, ...result });
        else sendResponse({ ok: true, found: false });
      })
      .catch(() => sendResponse({ ok: true, found: false }));
    return true;
  }

  if (message && message.type === 'translateSentence') {
    translateSentence(message.text)
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((err) =>
        sendResponse({ ok: false, code: err.code || 'ERROR', message: err.message || '翻译失败' })
      );
    return true;
  }

  // 直测当前选择的翻译接口（跳过词典/缓存，用于设置页「测试翻译」）。
  if (message && message.type === 'testProvider') {
    translateViaProvider(message.text || 'hello')
      .then((r) => sendResponse({ ok: true, translation: r.translation || '' }))
      .catch((err) =>
        sendResponse({ ok: false, code: err.code || 'ERROR', message: err.message || '翻译失败' })
      );
    return true;
  }

  if (message && message.type === 'openSettings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html#settings') });
    sendResponse({ ok: true });
    return false;
  }

  if (message && message.type === 'loadDict') {
    loadDictionary()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '加载失败' }));
    return true;
  }

  // 下载并合并第二套词典 / 词条补丁（不清空现有 ECDICT，按 word 覆盖/新增）。
  if (message && message.type === 'loadSupplementDict') {
    loadSupplementDictionary(message.url)
      .then((count) => sendResponse({ ok: true, count }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '合并失败' }));
    return true;
  }

  if (message && message.type === 'dictStatus') {
    getDictStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch(() =>
        sendResponse({ ok: true, dictCount: 0, cacheCount: 0, customDicts: [], presetCount: 0, presets: [] })
      );
    return true;
  }

  // 下载并导入一个预设词表（中考/高考/四级/六级/考研/雅思/托福）。
  if (message && message.type === 'downloadPreset') {
    importPreset(message.presetId)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '导入失败' }));
    return true;
  }

  // 移除一个预设词表。
  if (message && message.type === 'removePreset') {
    removePreset(message.presetId)
      .then((count) => sendResponse({ ok: true, count }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '移除失败' }));
    return true;
  }

  // 词书生成：把解析出的单词写入为一本新词书。
  if (message && message.type === 'generateBook') {
    generateBook({ id: message.id, name: message.name, words: message.words })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '生成失败' }));
    return true;
  }

  // 删除一本生成的词书。
  if (message && message.type === 'deleteGeneratedBook') {
    deleteGeneratedBook(message.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '删除失败' }));
    return true;
  }

  // 重命名一本生成的词书。
  if (message && message.type === 'renameGeneratedBook') {
    renameGeneratedBook(message.id, message.name)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '重命名失败' }));
    return true;
  }

  // 批量校验单词是否存在于本地词典（词书生成时过滤噪声词用）。
  if (message && message.type === 'validateWords') {
    validateWords(message.words)
      .then((found) => sendResponse({ ok: true, found }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '校验失败' }));
    return true;
  }

  // 新增一份自定义词典元信息（.mdx 解析完成后调用）。
  if (message && message.type === 'addCustomDict') {
    addCustomDict(message.meta)
      .then((list) => sendResponse({ ok: true, customDicts: list }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '保存失败' }));
    return true;
  }

  // 移除一份自定义词典（含其全部词条）。
  if (message && message.type === 'removeCustomDict') {
    removeCustomDict(message.dictId)
      .then((list) => sendResponse({ ok: true, customDicts: list }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '移除失败' }));
    return true;
  }

  // 调整自定义词典优先级顺序。
  if (message && message.type === 'reorderCustomDicts') {
    reorderCustomDicts(message.ids)
      .then((list) => sendResponse({ ok: true, customDicts: list }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '排序失败' }));
    return true;
  }

  // 调整统一词典查询优先级顺序（内置 / 完整 / 自定义同列表排序）。
  if (message && message.type === 'reorderDictOrder') {
    reorderDictOrder(message.ids)
      .then((order) => sendResponse({ ok: true, dictOrder: order }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '排序失败' }));
    return true;
  }

  // 按当前词典优先级，重新为生词本中的词查询本地释义（词典优先、缓存兜底，不触发翻译 API）。
  if (message && message.type === 'refreshWordDefinitions') {
    (async () => {
      const words = Array.isArray(message.words) ? message.words : [];
      const updated = {};
      for (const w of words) {
        const hit = await lookupCachedWord(String(w));
        if (hit) {
          updated[w] = {
            translation: hit.translation,
            phonetic: hit.phonetic,
            explains: hit.explains,
            senses: hit.senses,
            definitions: hit.definitions,
            html: hit.html || '',
            sourceId: hit.sourceId || '',
          };
        }
      }
      sendResponse({ ok: true, updated });
    })().catch((err) => sendResponse({ ok: false, message: err.message || '刷新失败' }));
    return true;
  }

  // 拉取预设词表（供 content script 网页高亮）。
  if (message && message.type === 'getPresetWords') {
    getPresetWords()
      .then((words) => sendResponse({ ok: true, words }))
      .catch(() => sendResponse({ ok: true, words: [] }));
    return true;
  }

  // 拉取已导入的预设词书列表（供 content script 悬停菜单）。
  if (message && message.type === 'getPresetBooks') {
    getPresetBooks()
      .then((books) => sendResponse({ ok: true, books }))
      .catch(() => sendResponse({ ok: true, books: [] }));
    return true;
  }

  // 双击网页预设词：切换「已背 / 待背」状态，返回操作后的 memorized 标记。
  if (message && message.type === 'togglePresetMemorized') {
    togglePresetMemorized(message.word, message.sources)
      .then((res) => sendResponse({ ok: true, memorized: res.memorized }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '操作失败' }));
    return true;
  }

  // 用本地 ECDICT 为预设词条补充结构化释义。
  if (message && message.type === 'enrichPresetFromDict') {
    enrichPresetFromDict(message.presetId)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '补充释义失败' }));
    return true;
  }

  // 后台为预设词条补充例句（每次处理 limit 个，返回剩余数量供继续调度）。
  if (message && message.type === 'supplementPresetExamples') {
    supplementPresetExamples(message.limit, message.presetId)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '补充例句失败' }));
    return true;
  }

  // 更新预设词表过滤选项（剔除高频词和常见词 / 剔除已背单词 / 补充本地释义 / 后台补充例句）。
  if (message && message.type === 'setPresetFilter') {
    setPresetFilter(message.presetId, {
      removeCommon: !!message.removeCommon,
      removeMemorized: !!message.removeMemorized,
      enrichLocal: message.enrichLocal !== false,
      supplementExamples: message.supplementExamples !== false,
    })
      .then((filters) => sendResponse({ ok: true, filters }))
      .catch((err) => sendResponse({ ok: false, message: err.message || '更新失败' }));
    return true;
  }

  return false;
});
