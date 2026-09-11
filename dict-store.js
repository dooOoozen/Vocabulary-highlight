/**
 * dict-store.js —— 词典存储与 CSV 解析（Service Worker 与扩展页面共用）
 *
 * 说明：
 * 1. 通过 importScripts（background）或 <script>（review.html）加载。
 * 2. IndexedDB 以扩展自身 origin 共享，因此 review 页面「本地载入」和
 *    background「网络下载」写入的是同一个词典库，查询无需区分来源。
 * 3. 顶层使用 var / function，保证在两种加载方式下都能被后续脚本访问。
 */

var DB_NAME = 'lv-dict';
var DB_VERSION = 4;
var STORE_DICT = 'dict';     // ECDICT 词条：word -> { p, d, t, pos }
var STORE_CACHE = 'cache';   // 查询缓存：word -> { translation, phonetic, explains }
var STORE_PRESET = 'preset'; // 预设生词表：word -> { word, t, p, sources:[presetId] }
var STORE_CUSTOM = 'custom'; // 自定义 MDX 词典：key(dictId\u0000word) -> { key, word, text, html, dictId }
var STORE_RES = 'res';       // 自定义词典 .mdd 资源：key(dictId\u0000path) -> { key, dictId, path, type, data }

// 预设生词表来源（中考/高考/四级/六级/考研/雅思/托福，开源词表）。
// 说明：词表数据均来自网络开源仓库，本扩展仅提供下载与导入能力，不内置、不分发任何词表数据。
var PRESET_SOURCES = [
  { id: 'zhongkao', name: '中考', parser: 'tab', url: 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/1%20%E5%88%9D%E4%B8%AD-%E4%B9%B1%E5%BA%8F.txt' },
  { id: 'gaokao', name: '高考', parser: 'tab', url: 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/2%20%E9%AB%98%E4%B8%AD-%E4%B9%B1%E5%BA%8F.txt' },
  { id: 'cet4', name: '四级', parser: 'tab', url: 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/3%20%E5%9B%9B%E7%BA%A7-%E4%B9%B1%E5%BA%8F.txt' },
  { id: 'cet6', name: '六级', parser: 'tab', url: 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/4%20%E5%85%AD%E7%BA%A7-%E4%B9%B1%E5%BA%8F.txt' },
  { id: 'kaoyan', name: '考研', parser: 'tab', url: 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/5%20%E8%80%83%E7%A0%94-%E4%B9%B1%E5%BA%8F.txt' },
  { id: 'ielts', name: '雅思', parser: 'ielts', url: 'https://raw.githubusercontent.com/leotse28/AGMess/main/ieltsWords.txt' },
  { id: 'toefl', name: '托福', parser: 'tab', url: 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/6%20%E6%89%98%E7%A6%8F-%E4%B9%B1%E5%BA%8F.txt' },
];

// 常用词/高频词集合（小学基础词汇、代词、冠词、介词、连词、助动词、常见动词/名词/形容词/副词、
// 数字、颜色、星期、月份等）。用于「设置 - 预设词表」中剔除这些过于简单、无需再背的单词。
// 以对象形式存储，保证 O(1) 查表。
var COMMON_WORDS = {
  a: 1, an: 1, the: 1, and: 1, or: 1, but: 1, so: 1, for: 1, nor: 1, yet: 1,
  i: 1, me: 1, my: 1, mine: 1, myself: 1, you: 1, your: 1, yours: 1, yourself: 1, yourselves: 1,
  he: 1, him: 1, his: 1, himself: 1, she: 1, her: 1, hers: 1, herself: 1, it: 1, its: 1, itself: 1,
  we: 1, us: 1, our: 1, ours: 1, ourselves: 1, they: 1, them: 1, their: 1, theirs: 1, themselves: 1,
  this: 1, that: 1, these: 1, those: 1, here: 1, there: 1, where: 1, when: 1, why: 1, how: 1,
  what: 1, which: 1, who: 1, whom: 1, whose: 1, is: 1, am: 1, are: 1, was: 1, were: 1,
  be: 1, been: 1, being: 1, do: 1, does: 1, did: 1, done: 1, have: 1, has: 1, had: 1, having: 1,
  will: 1, would: 1, shall: 1, should: 1, can: 1, could: 1, may: 1, might: 1, must: 1, ought: 1,
  not: 1, no: 1, yes: 1, to: 1, of: 1, in: 1, on: 1, at: 1, by: 1, with: 1, without: 1, from: 1,
  up: 1, down: 1, off: 1, out: 1, over: 1, under: 1, above: 1, below: 1, into: 1, onto: 1, upon: 1,
  about: 1, after: 1, before: 1, between: 1, among: 1, through: 1, during: 1, until: 1, till: 1, since: 1,
  if: 1, then: 1, than: 1, as: 1, because: 1, while: 1, although: 1, though: 1, unless: 1, whether: 1,
  also: 1, too: 1, very: 1, just: 1, only: 1, even: 1, still: 1, already: 1, always: 1, never: 1, ever: 1,
  often: 1, sometimes: 1, usually: 1, again: 1, once: 1, now: 1, soon: 1, later: 1, early: 1, late: 1,
  today: 1, tomorrow: 1, yesterday: 1, now: 1, here: 1, there: 1, always: 1,
  say: 1, said: 1, go: 1, went: 1, gone: 1, come: 1, came: 1, get: 1, got: 1, make: 1, made: 1,
  see: 1, saw: 1, seen: 1, know: 1, knew: 1, known: 1, think: 1, thought: 1, take: 1, took: 1, taken: 1,
  find: 1, found: 1, give: 1, gave: 1, given: 1, tell: 1, told: 1, become: 1, became: 1, show: 1, showed: 1,
  leave: 1, left: 1, feel: 1, felt: 1, put: 1, bring: 1, brought: 1, begin: 1, began: 1, begun: 1,
  keep: 1, kept: 1, hold: 1, held: 1, write: 1, wrote: 1, written: 1, stand: 1, stood: 1, hear: 1, heard: 1,
  let: 1, mean: 1, meant: 1, set: 1, meet: 1, met: 1, run: 1, ran: 1, pay: 1, paid: 1, sit: 1, sat: 1,
  speak: 1, spoke: 1, spoken: 1, read: 1, grow: 1, grew: 1, grown: 1, fall: 1, fell: 1, fallen: 1,
  lead: 1, led: 1, eat: 1, ate: 1, eaten: 1, drink: 1, drank: 1, drunk: 1, sleep: 1, slept: 1,
  live: 1, die: 1, dead: 1, walk: 1, talk: 1, call: 1, try: 1, ask: 1, need: 1, want: 1, use: 1, used: 1,
  like: 1, love: 1, hate: 1, help: 1, work: 1, play: 1, turn: 1, start: 1, stop: 1, open: 1, close: 1,
  look: 1, watch: 1, listen: 1, move: 1, stay: 1, wait: 1, change: 1, remember: 1, forget: 1, forget: 1,
  person: 1, man: 1, woman: 1, child: 1, children: 1, people: 1, family: 1, friend: 1, mother: 1, father: 1,
  mom: 1, dad: 1, son: 1, daughter: 1, brother: 1, sister: 1, baby: 1, boy: 1, girl: 1, kid: 1,
  thing: 1, things: 1, stuff: 1, way: 1, ways: 1, time: 1, times: 1, day: 1, days: 1, week: 1, month: 1, year: 1,
  life: 1, lives: 1, world: 1, home: 1, house: 1, room: 1, door: 1, window: 1, table: 1, chair: 1,
  bed: 1, desk: 1, book: 1, books: 1, pen: 1, paper: 1, letter: 1, word: 1, words: 1, name: 1, names: 1,
  school: 1, class: 1, teacher: 1, student: 1, lesson: 1, question: 1, answer: 1, test: 1, exam: 1,
  work: 1, job: 1, money: 1, price: 1, market: 1, company: 1, business: 1, office: 1, shop: 1, store: 1,
  city: 1, country: 1, street: 1, road: 1, place: 1, area: 1, water: 1, food: 1, drink: 1, meal: 1,
  breakfast: 1, lunch: 1, dinner: 1, bread: 1, milk: 1, tea: 1, coffee: 1, rice: 1, fruit: 1, vegetable: 1,
  meat: 1, fish: 1, egg: 1, apple: 1, orange: 1, banana: 1, chicken: 1, beef: 1, pork: 1,
  car: 1, bus: 1, train: 1, plane: 1, bike: 1, bicycle: 1, ship: 1, boat: 1, road: 1, way: 1,
  head: 1, face: 1, eye: 1, eyes: 1, ear: 1, ears: 1, nose: 1, mouth: 1, hand: 1, hands: 1, foot: 1, feet: 1,
  arm: 1, leg: 1, hair: 1, heart: 1, body: 1, health: 1, sick: 1, ill: 1, doctor: 1, hospital: 1, medicine: 1,
  big: 1, small: 1, large: 1, little: 1, long: 1, short: 1, tall: 1, high: 1, low: 1, wide: 1, narrow: 1,
  new: 1, old: 1, young: 1, good: 1, bad: 1, nice: 1, fine: 1, great: 1, wonderful: 1, terrible: 1,
  happy: 1, sad: 1, angry: 1, tired: 1, hungry: 1, thirsty: 1, hot: 1, cold: 1, warm: 1, cool: 1,
  fast: 1, slow: 1, quick: 1, easy: 1, hard: 1, difficult: 1, important: 1, different: 1, same: 1, right: 1, wrong: 1,
  red: 1, blue: 1, green: 1, yellow: 1, black: 1, white: 1, brown: 1, gray: 1, grey: 1, orange: 1, pink: 1, purple: 1,
  one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1, ten: 1, hundred: 1, thousand: 1,
  monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
  january: 1, february: 1, march: 1, april: 1, may: 1, june: 1, july: 1, august: 1, september: 1, october: 1, november: 1, december: 1,
  mr: 1, mrs: 1, ms: 1, hello: 1, hi: 1, bye: 1, goodbye: 1, please: 1, thanks: 1, thank: 1, sorry: 1, ok: 1, okay: 1,
  english: 1, chinese: 1, china: 1, america: 1, american: 1,
};

// 用户对「高频词和常见词」的自定义覆盖：add = 手动添加的词，remove = 从内置集合中手动剔除的词。
// 由 review 页面写入 chrome.storage.local['commonWordOverrides']，background 与 review 启动时读取。
var COMMON_OVERRIDES = { add: {}, remove: {} };

// 判断某词是否属于「高频词和常见词」：用户手动添加 > 用户手动剔除 > 内置集合。
// word 约定为小写词形（词形还原后或预设词条中均为小写）。
function isCommonWord(word) {
  if (COMMON_OVERRIDES.add[word]) return true;
  if (COMMON_OVERRIDES.remove[word]) return false;
  return !!COMMON_WORDS[word];
}

// 从 chrome.storage.local 读取用户自定义覆盖并更新内存副本，返回 Promise。
function loadCommonOverrides() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get('commonWordOverrides', function (r) {
        var ov = (r && r.commonWordOverrides) || {};
        COMMON_OVERRIDES.add = ov.add || {};
        COMMON_OVERRIDES.remove = ov.remove || {};
        resolve();
      });
    } catch (e) {
      COMMON_OVERRIDES.add = {};
      COMMON_OVERRIDES.remove = {};
      resolve();
    }
  });
}

// 计算某条预设词条在「剔除高频词和常见词 / 剔除已背单词」过滤后，仍保留在哪些词书来源中。
// word: 单词；sources: 该词归属的预设词表 id 数组；filters: presetFilters；presetState: 复习进度。
// ignoreMemorizedFilter 为 true 时忽略「剔除已背单词」过滤（用于已背页面展示已背的词）。
// 返回过滤后仍可见的来源数组（空数组表示该词应被完全隐藏）。
function visiblePresetSources(word, sources, filters, presetState, ignoreMemorizedFilter) {
  if (!sources || !sources.length) return [];
  const out = [];
  for (const id of sources) {
    const f = (filters && filters[id]) || {};
    // 「剔除高频词和常见词 / 剔除已背单词」默认开启；仅在显式为 false 时才不过滤。
    if (f.removeCommon !== false && isCommonWord(word)) continue;
    if (f.removeMemorized !== false && !ignoreMemorizedFilter) {
      const st = (presetState && presetState[id + '\u0000' + word]) || {};
      if (st.status === 'memorized') continue;
    }
    out.push(id);
  }
  return out;
}

var dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_DICT)) {
        db.createObjectStore(STORE_DICT, { keyPath: 'word' });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'word' });
      }
      if (!db.objectStoreNames.contains(STORE_PRESET)) {
        db.createObjectStore(STORE_PRESET, { keyPath: 'word' });
      }
      // 自定义词典改用复合主键「dictId\u0000word」并建立 dictId 索引，
      // 以便支持多份词典并存、按词典删除与按优先级顺序查询。旧版（word 主键）需重建。
      if (db.objectStoreNames.contains(STORE_CUSTOM)) {
        db.deleteObjectStore(STORE_CUSTOM);
      }
      var customStore = db.createObjectStore(STORE_CUSTOM, { keyPath: 'key' });
      customStore.createIndex('byDict', 'dictId', { unique: false });

      // .mdd 资源存储：key 为「dictId\u0000path」，建立 dictId 索引以便按词典清理。
      if (db.objectStoreNames.contains(STORE_RES)) {
        db.deleteObjectStore(STORE_RES);
      }
      var resStore = db.createObjectStore(STORE_RES, { keyPath: 'key' });
      resStore.createIndex('byDict', 'dictId', { unique: false });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return dbPromise;
}

function idbGet(storeName, key) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

// 单事务写入一批（用于批量入库）。
function idbPutAll(storeName, rows) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      for (var i = 0; i < rows.length; i++) store.put(rows[i]);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function idbCount(storeName) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).count();
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function idbClear(storeName) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

// 读取某 store 的全部记录（用于预设词表的合并/移除，词表规模较小）。
function idbGetAll(storeName) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

// 单事务按 key 批量读取，返回 { key: value } 映射（用于预设词表批量补充释义）。
function idbGetAllByKeys(storeName, keys) {
  if (!keys || !keys.length) return Promise.resolve({});
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readonly');
      var store = tx.objectStore(storeName);
      var map = {};
      for (var i = 0; i < keys.length; i++) {
        (function (key) {
          var req = store.get(key);
          req.onsuccess = function () { if (req.result) map[key] = req.result; };
        })(keys[i]);
      }
      tx.oncomplete = function () { resolve(map); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

// 单事务删除一批 key。
function idbDeleteAll(storeName, keys) {
  if (!keys || !keys.length) return Promise.resolve();
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      for (var i = 0; i < keys.length; i++) store.delete(keys[i]);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

// 按索引值删除一批记录（用于按 dictId 移除某份自定义词典的全部词条）。
function idbDeleteByIndex(storeName, indexName, value) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      var idx = store.index(indexName);
      var req = idx.getAllKeys(value);
      req.onsuccess = function () {
        var keys = req.result || [];
        for (var i = 0; i < keys.length; i++) store.delete(keys[i]);
      };
      req.onerror = function () { reject(req.error); };
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

// 按索引值读取全部记录（用于读取某份词典的 .mdd 资源集）。
function idbGetAllByIndex(storeName, indexName, value) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

// 状态机解析 CSV，逐行回调（支持带引号字段内的逗号与换行）。
function forEachCSVRow(text, onRow) {
  var field = '';
  var row = [];
  var inQuotes = false;

  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        if (row.length > 1 || row[0] !== '') onRow(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') onRow(row);
  }
}

/**
 * 解析 ECDICT 兼容 CSV，返回待写入的分批队列与总行数。
 * 字段：word,phonetic,definition,translation,pos（与 ECDICT 一致）。
 */
function parseDictCSV(text, onProgress) {
  var queue = [];
  var batch = [];
  var header = true;
  var rowCount = 0;
  var BATCH = 2000;

  forEachCSVRow(text, function (row) {
    if (header) {
      header = false;
      return;
    }
    var word = (row[0] || '').trim().toLowerCase();
    var phonetic = (row[1] || '').trim();
    var definition = (row[2] || '').trim();
    var translation = (row[3] || '').trim();
    var pos = (row[4] || '').trim();
    if (!word || !translation) return;
    batch.push({ word: word, p: phonetic, d: definition, t: translation, pos: pos });
    rowCount++;
    if (batch.length >= BATCH) {
      queue.push(batch);
      batch = [];
      if (onProgress && rowCount % 10000 === 0) {
        onProgress({ phase: 'parse', rowCount: rowCount });
      }
    }
  });

  if (batch.length) queue.push(batch);
  return { queue: queue, rowCount: rowCount };
}

// 串行写入队列，避免过多并发事务；返回写入后的 store 条数。
function writeDictBatches(queue, rowCount, onProgress) {
  function writeAll(i) {
    if (i >= queue.length) return Promise.resolve();
    return idbPutAll(STORE_DICT, queue[i]).then(function () {
      if (onProgress) {
        onProgress({ phase: 'write', done: i + 1, total: queue.length, rowCount: rowCount });
      }
      return writeAll(i + 1);
    });
  }
  return writeAll(0).then(function () {
    return idbCount(STORE_DICT);
  });
}

/**
 * 解析 ECDICT CSV 文本并写入词典库（先清空再写入，用于「加载完整词典」）。
 * @param {string} text CSV 文本
 * @param {function} onProgress 进度回调：{ phase: 'parse'|'write', rowCount, done, total }
 * @returns {Promise<number>} 实际写入的词典条数
 */
function loadCSVIntoDB(text, onProgress) {
  return idbClear(STORE_DICT).then(function () {
    var parsed = parseDictCSV(text, onProgress);
    return writeDictBatches(parsed.queue, parsed.rowCount, onProgress);
  });
}

/**
 * 合并一份补充词典 CSV（不清空，按 word 覆盖/新增），用于接入第二套词典或词条补丁。
 * @param {string} text CSV 文本
 * @param {function} onProgress 进度回调：{ phase: 'parse'|'write', rowCount, done, total }
 * @returns {Promise<number>} 合并后的词典总条数
 */
function mergeCSVIntoDB(text, onProgress) {
  var parsed = parseDictCSV(text, onProgress);
  return writeDictBatches(parsed.queue, parsed.rowCount, onProgress);
}

// 供显式引用的命名空间。
var LV_DICT_STORE = {
  DB_NAME: DB_NAME,
  STORE_DICT: STORE_DICT,
  STORE_CACHE: STORE_CACHE,
  STORE_PRESET: STORE_PRESET,
  STORE_CUSTOM: STORE_CUSTOM,
  STORE_RES: STORE_RES,
  PRESET_SOURCES: PRESET_SOURCES,
  COMMON_WORDS: COMMON_WORDS,
  COMMON_OVERRIDES: COMMON_OVERRIDES,
  isCommonWord: isCommonWord,
  loadCommonOverrides: loadCommonOverrides,
  visiblePresetSources: visiblePresetSources,
  openDB: openDB,
  idbGet: idbGet,
  idbPutAll: idbPutAll,
  idbCount: idbCount,
  idbClear: idbClear,
  idbGetAll: idbGetAll,
  idbGetAllByKeys: idbGetAllByKeys,
  idbDeleteAll: idbDeleteAll,
  idbDeleteByIndex: idbDeleteByIndex,
  idbGetAllByIndex: idbGetAllByIndex,
  loadCSVIntoDB: loadCSVIntoDB,
  mergeCSVIntoDB: mergeCSVIntoDB,
};
