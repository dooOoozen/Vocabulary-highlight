/**
 * mdx.js —— MDict (.mdx / .mdd) 词典文件解析器（仅运行于扩展页面 review.html）
 *
 * 作用：
 *  - .mdx：把用户自行提供的词典（如 LDOCE5++ / OALD / COBUILD 等）解析为
 *    「单词 -> 纯文本释义 + 原始 HTML」，写入 IndexedDB 的 STORE_CUSTOM，供本地查询链使用。
 *  - .mdd：把同一词典的资源包（CSS / 图片 / 音频 / 字体等）解析为二进制资源，
 *    写入 IndexedDB 的 STORE_RES，供释义渲染时内联引用，从而保留排版样式。
 *
 * 格式参考（MIT License，来自 fengdh/mdict-js 与 terasum/mdict，仅作算法参考）：
 *   https://github.com/zhansliu/writemdict/blob/master/fileformat.md
 *
 * 支持的子集（足够覆盖大多数免费词典）：
 *   - MDict 2.0 及以上版本
 *   - 未加密（Encrypted = 0）
 *   - 数据块无压缩（0x00）或 zlib 压缩（0x02）
 *   - 关键字编码 UTF-8 / UTF-16 / GBK / Big5
 *
 * 不支持（会给出明确错误提示）：
 *   - LZO 压缩（0x01）
 *   - 加密词典（Encrypted = 1/2/3）
 *   - MDict 1.x 老格式
 *
 * 版权说明：本文件仅实现「解析与导入」能力，不内置、不分发任何词典数据。
 */
(function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */

  // 把 HTML 正文转换为可读的纯文本（去标签、解码实体、按块级标签换行）。
  function htmlToText(html) {
    if (!html) return '';
    let s = String(html);
    s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<\s*\/\s*(div|p|li|tr|h[1-6]|dt|dd|blockquote|table)\s*>/gi, '\n');
    s = s.replace(/<\s*(div|p|li|tr|h[1-6]|dt|dd|blockquote|table)\b[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.replace(/[ \t]+\n/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return safeCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return safeCode(parseInt(d, 10)); })
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'");
  }

  function safeCode(c) {
    try { return String.fromCodePoint(c); } catch (e) { return ''; }
  }

  // 基于 Uint8Array 的游标读取器，所有多字节整数均为大端（MDict 规范）。
  function createReader(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pos = 0;
    return {
      get pos() { return pos; },
      get size() { return u8.byteLength; },
      skip(n) { pos += n; },
      u8() { const v = dv.getUint8(pos); pos += 1; return v; },
      u16() { const v = dv.getUint16(pos, false); pos += 2; return v; },
      u32() { const v = dv.getUint32(pos, false); pos += 4; return v; },
      // 64 位大端整数：高位 * 2^32 + 低位（< 2^53 时精确，覆盖 4G 以内的词典）。
      u64() {
        const hi = dv.getUint32(pos, false);
        const lo = dv.getUint32(pos + 4, false);
        pos += 8;
        return hi * 4294967296 + lo;
      },
      bytes(n) {
        const v = u8.subarray(pos, pos + n);
        pos += n;
        return v;
      },
      // 读取 NUL 结尾的文本（关键字、词典正文）。
      nulText(decoder, bpu) {
        const start = pos;
        if (bpu === 2) {
          while (pos + 2 <= u8.byteLength && dv.getUint16(pos, false) !== 0) pos += 2;
          const text = decoder.decode(u8.subarray(start, pos));
          pos += 2;
          return text;
        }
        while (pos < u8.byteLength && dv.getUint8(pos) !== 0) pos += 1;
        const text = decoder.decode(u8.subarray(start, pos));
        pos += 1;
        return text;
      },
      // 读取定长文本（size 为“单元数”，乘以 bpu 得到字节数），并跳过尾部 NUL。
      sizedText(size, decoder, bpu) {
        const len = size * bpu;
        const text = decoder.decode(u8.subarray(pos, pos + len));
        pos += len + bpu;
        return text;
      },
    };
  }

  // zlib 解压（MDX 的 0x02 压缩即 RFC 1950 zlib）。
  async function zlibInflate(data) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // 解压一个数据块。block 为原始字节，前 8 字节是「4 字节压缩类型 + 4 字节校验和」。
  async function decompressBlock(block) {
    if (block.length < 8) return block;
    const compType = block[0];
    const data = block.subarray(8);
    if (compType === 0) return data;
    if (compType === 2) return await zlibInflate(data);
    if (compType === 1) {
      throw new Error('该词典使用 LZO 压缩，暂不支持。请换用 zlib 或无压缩版本的词典。');
    }
    throw new Error('无法识别的压缩类型：' + compType);
  }

  /* ---------------- 主解析流程 ---------------- */

  // 通用 MDict（.mdx / .mdd）解析：读取文件头、关键字索引、记录块，并逐个词条回调。
  // onEntry(entry {name, offset}, bytes {Uint8Array}, decoder, bpu)：bytes 为该词条
  // 去掉结尾 NUL 的原始内容（文本需用 decoder 解码，资源为二进制）。可返回 Promise。
  // 返回 { attrs, count }；attrs 为文件头属性（Title / Description 等）。
  async function parseMdictRecords(file, onProgress, onEntry) {
    onProgress && onProgress({ phase: 'read', text: '正在解析文件头…' });

    // 1) 头部：前 4 字节为头部长度，随后是 UTF-16LE 的 XML，再 4 字节校验和。
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const headLen = new DataView(head.buffer).getUint32(0, false);
    if (headLen <= 0 || headLen > 1024 * 1024) throw new Error('不是有效的 MDict 文件（文件头异常）。');

    const headerBytes = new Uint8Array(await file.slice(4, 4 + headLen).arrayBuffer());
    const headerStr = new TextDecoder('utf-16le').decode(headerBytes).replace(/\0+$/, '');

    const doc = new DOMParser().parseFromString(headerStr, 'text/xml');
    const elem = doc.getElementsByTagName('Dictionary')[0] || doc.getElementsByTagName('Library_Data')[0];
    if (!elem) throw new Error('无法解析词典文件头（不是有效的 MDict 文件）。');
    const attrs = {};
    for (let i = 0; i < elem.attributes.length; i++) {
      attrs[elem.attributes[i].name] = elem.attributes[i].value;
    }

    const version = parseFloat(attrs.GeneratedByEngineVersion || attrs.RequiredEngineVersion || '2.0');
    if (!(version >= 2)) throw new Error('仅支持 MDict 2.0 及以上格式。');
    const encrypted = parseInt(attrs.Encrypted, 10) || 0;
    if (encrypted !== 0) throw new Error('该文件已加密，暂不支持导入。');

    const encoding = String(attrs.Encoding || 'UTF-16').toLowerCase();
    const decoderLabel = encoding === 'utf-16' ? 'utf-16le' : encoding;
    let decoder;
    try {
      decoder = new TextDecoder(decoderLabel);
    } catch (e) {
      throw new Error('不支持的文件编码：' + attrs.Encoding);
    }
    const bpu = (encoding === 'utf-16' || encoding === 'utf-16le') ? 2 : 1;

    let pos = 4 + headLen + 4; // 头部长度(4) + 头部字符串(headLen) + 校验和(4)

    // 2) 关键字区摘要：5 个 8 字节大端整数 + 4 字节校验和 = 44 字节。
    const summaryRaw = new Uint8Array(await file.slice(pos, pos + 44).arrayBuffer());
    const sr = createReader(summaryRaw);
    const numBlocks = sr.u64();
    const numEntries = sr.u64();
    sr.u64(); // keyIndexDecompLen（本次未使用）
    const keyIndexCompLen = sr.u64();
    const keyBlocksLen = sr.u64();
    pos += 44;

    // 3) 关键字索引块（可能压缩）。
    const keyIndexRaw = new Uint8Array(await file.slice(pos, pos + keyIndexCompLen).arrayBuffer());
    pos += keyIndexCompLen;
    const keyIndexDecomp = await decompressBlock(keyIndexRaw);
    const kr = createReader(keyIndexDecomp);
    const keyIndex = []; // { numEntries, compSize, decompSize, offset }
    let cumOffset = 0;
    for (let i = 0; i < numBlocks; i++) {
      const ne = kr.u64();
      const firstSize = kr.u16();
      kr.sizedText(firstSize, decoder, bpu); // firstWord（本次未使用）
      const lastSize = kr.u16();
      kr.sizedText(lastSize, decoder, bpu);  // lastWord（本次未使用）
      const compSize = kr.u64();
      const decompSize = kr.u64();
      keyIndex.push({ numEntries: ne, compSize, decompSize, offset: cumOffset });
      cumOffset += compSize;
    }

    // 4) 读取整个关键字块区。
    const keyBlocksRaw = new Uint8Array(await file.slice(pos, pos + keyBlocksLen).arrayBuffer());
    pos += keyBlocksLen;

    // 5) 记录区摘要：4 个 8 字节整数 = 32 字节（无校验和）。
    const recSummaryRaw = new Uint8Array(await file.slice(pos, pos + 32).arrayBuffer());
    const rr = createReader(recSummaryRaw);
    const recNumBlocks = rr.u64();
    rr.u64(); // recNumEntries（本次未使用）
    const recIndexLen = rr.u64();
    rr.u64(); // recBlocksLen（本次未使用）
    pos += 32;

    // 6) 记录块索引（未压缩）：num_blocks 组 (comp_size, decomp_size)。
    const recIndexRaw = new Uint8Array(await file.slice(pos, pos + recIndexLen).arrayBuffer());
    pos += recIndexLen;
    const ri = createReader(recIndexRaw);
    const recordBlocks = []; // { compOffset, compSize, decompOffset, decompSize }
    let compOff = pos;
    let decompOff = 0;
    for (let i = 0; i < recNumBlocks; i++) {
      const cs = ri.u64();
      const ds = ri.u64();
      recordBlocks.push({ compOffset: compOff, compSize: cs, decompOffset: decompOff, decompSize: ds });
      compOff += cs;
      decompOff += ds;
    }

    onProgress && onProgress({ phase: 'parse', text: '正在解析索引…', done: 0, total: numEntries });

    // 7) 遍历所有关键字块，收集 (名称, 记录偏移)。
    const entries = [];
    for (let b = 0; b < keyIndex.length; b++) {
      const kb = keyIndex[b];
      const dec = await decompressBlock(keyBlocksRaw.subarray(kb.offset, kb.offset + kb.compSize));
      const krd = createReader(dec);
      for (let i = 0; i < kb.numEntries; i++) {
        const off = krd.u64();
        const name = krd.nulText(decoder, bpu);
        if (name) entries.push({ name: name.trim(), offset: off });
      }
    }
    entries.sort(function (a, b) { return a.offset - b.offset; });

    onProgress && onProgress({ phase: 'parse', text: '共 ' + entries.length + ' 条，正在写入…', done: entries.length, total: numEntries });

    // 8) 按记录块解压并逐条读取内容。用「下一条偏移」确定长度，兼容含 NUL 的二进制资源。
    let ei = 0;
    for (let b = 0; b < recordBlocks.length; b++) {
      const rb = recordBlocks[b];
      const endDecomp = rb.decompOffset + rb.decompSize;
      const blockEntries = [];
      while (ei < entries.length && entries[ei].offset < endDecomp) {
        if (entries[ei].offset >= rb.decompOffset) blockEntries.push(entries[ei]);
        ei++;
      }
      if (!blockEntries.length) continue;

      const raw = new Uint8Array(await file.slice(rb.compOffset, rb.compOffset + rb.compSize).arrayBuffer());
      const dec = await decompressBlock(raw);

      for (let i = 0; i < blockEntries.length; i++) {
        const en = blockEntries[i];
        const start = en.offset - rb.decompOffset;
        const next = (i + 1 < blockEntries.length)
          ? blockEntries[i + 1].offset - rb.decompOffset
          : rb.decompSize;
        let end = Math.max(start, Math.min(next, dec.length));
        // 去掉结尾 NUL 终止符（UTF-16 为 2 字节，其余为 1 字节）。
        if (bpu === 2) {
          while (end - start >= 2 && dec[end - 2] === 0 && dec[end - 1] === 0) end -= 2;
        } else {
          while (end > start && dec[end - 1] === 0) end -= 1;
        }
        await onEntry(en, dec.subarray(start, end), decoder, bpu);
      }
    }

    return { attrs, count: entries.length };
  }

  // 根据资源文件扩展名推断 MIME 类型（用于生成 data: URL 内联到释义）。
  function mimeForPath(path) {
    const ext = String(path).toLowerCase().split('.').pop();
    const map = {
      css: 'text/css',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      bmp: 'image/bmp',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
      eot: 'application/vnd.ms-fontobject',
      js: 'text/javascript',
      html: 'text/html',
      htm: 'text/html',
      txt: 'text/plain',
      xml: 'text/xml',
      json: 'application/json',
    };
    return map[ext] || 'application/octet-stream';
  }

  // 规范化资源路径：去掉前导 /、\、file:///、./，统一为相对路径以便与 HTML 引用匹配。
  function normalizeResPath(path) {
    let p = String(path || '').trim();
    p = p.replace(/^file:\/\/+/i, '');
    p = p.replace(/^[\\/]+/, '');
    p = p.replace(/\\/g, '/');
    p = p.replace(/^(\.\/)+/, '');
    return p;
  }

  /**
   * 解析一个 .mdx 文件并把词条写入 STORE_CUSTOM（同时保存纯文本与原始 HTML）。
   * @param {File} file 用户选择的 .mdx 文件
   * @param {function} onProgress 进度回调 { phase, text, done, total }
   * @param {string} dictId 词典唯一标识（多份词典并存，按此区分）
   * @returns {Promise<{title:string, description:string, count:number, dictId:string}>}
   */
  async function parseMdxFile(file, onProgress, dictId) {
    const did = dictId || ('c_' + Date.now().toString(36));
    const BATCH = 2000;
    let batch = [];
    let written = 0;

    async function flush() {
      if (!batch.length) return;
      await idbPutAll(STORE_CUSTOM, batch);
      written += batch.length;
      batch = [];
    }

    const { attrs } = await parseMdictRecords(file, onProgress, async (entry, bytes, decoder) => {
      const text = decoder.decode(bytes);
      const plain = htmlToText(text);
      const key = entry.name.toLowerCase();
      if (!key || !plain) return;
      // 同时保存纯文本（普通查询展示）与原始 HTML（带样式释义渲染）。
      batch.push({ key: did + '\u0000' + key, word: key, text: plain, html: text, dictId: did });
      if (batch.length >= BATCH) await flush();
    });
    await flush();

    onProgress && onProgress({ phase: 'done', text: '导入完成，共 ' + written + ' 条。' });

    return { title: attrs.Title || '', description: attrs.Description || '', count: written, dictId: did };
  }

  /**
   * 解析一个 .mdd 文件并把资源（CSS/图片/音频/字体）写入 STORE_RES。
   * @param {File} file 用户选择的 .mdd 文件
   * @param {function} onProgress 进度回调 { phase, text, done, total }
   * @param {string} dictId 关联的词典唯一标识
   * @returns {Promise<{title:string, count:number, dictId:string}>}
   */
  async function parseMddFile(file, onProgress, dictId) {
    const did = dictId || ('c_' + Date.now().toString(36));
    const BATCH = 500;
    let batch = [];
    let written = 0;

    async function flush() {
      if (!batch.length) return;
      await idbPutAll(STORE_RES, batch);
      written += batch.length;
      batch = [];
    }

    const { attrs } = await parseMdictRecords(file, onProgress, async (entry, bytes) => {
      const path = normalizeResPath(entry.name);
      if (!path) return;
      // 复制一份独立缓冲区，避免存储时共享子数组视图。
      const data = bytes.slice().buffer;
      batch.push({ key: did + '\u0000' + path, dictId: did, path, type: mimeForPath(path), data });
      if (batch.length >= BATCH) await flush();
    });
    await flush();

    onProgress && onProgress({ phase: 'done', text: '资源导入完成，共 ' + written + ' 个文件。' });

    return { title: attrs.Title || '', count: written, dictId: did };
  }

  window.LV_MDX = {
    parseMdxFile: parseMdxFile,
    parseMddFile: parseMddFile,
    htmlToText: htmlToText,
    normalizeResPath: normalizeResPath,
  };
})();
