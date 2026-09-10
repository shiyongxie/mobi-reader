/**
 * parseWorker.js —— MOBI 解析 Web Worker
 * -------------------------------------------------------------
 * 在独立线程中完成 .mobi 文件的二进制解析，避免阻塞 UI。
 *
 * 仅支持无 DRM 的旧版 MOBI（MOBI6 / PalmDOC 压缩）文件，
 * 这也是个人书籍（Calibre 转换出的"旧版 MOBI"）最常见的格式。
 * 不支持：
 *   - HUFF/CDIC 压缩（compression === 2，多为官方商店购书）
 *   - DRM 加密（encryption !== 0）
 *   - AZW3 / KF8（会尽量回退解析其中的 MOBI6 部分）
 *
 * 解析结果统一 postMessage 回主线程，结构见 parseMOBI() 末尾。
 */
'use strict';

/* EPUB 解析模块与本文件共用同一个全局作用域（两者都是经典脚本，靠顶层函数
   声明挂到 self 上）。只有 Worker 里能 importScripts；主线程降级路径由
   mobiParser.js 用 <script> 依次加载两个文件。
   用 try/catch 包住：加载失败不该让整个 Worker 起不来（那样连 MOBI 都读不了），
   而是在真正要解析 EPUB 时才报错（见 parseBook）。 */
if (typeof importScripts === 'function' && typeof parseEPUB === 'undefined') {
  try { importScripts('epubParser.js'); } catch (e) { /* 由 parseBook 兜底报错 */ }
}

/* ============================ 二进制读取工具 ============================ */

/** 读大端 u16 */
function u16(view, off) {
  return view.getUint16(off, false);
}
/** 读大端 u32 */
function u32(view, off) {
  return view.getUint32(off, false);
}
/** 按给定编码把字节片段解码为字符串 */
function decode(bytes, encoding) {
  try {
    return new TextDecoder(encodingToLabel(encoding)).decode(bytes).replace(/\0/g, '');
  } catch (e) {
    return new TextDecoder('latin1').decode(bytes);
  }
}
/** PalmDOC 文本编码：65001=UTF-8，1252(默认)=Windows Latin1 */
function encodingToLabel(enc) {
  if (enc === 65001) return 'utf-8';
  if (enc === 1252) return 'windows-1252';
  // 其它少见编码一律退回 utf-8 尝试
  return String(enc) === '1252' ? 'windows-1252' : 'utf-8';
}
/** 判断指定偏移处是否等于某 ASCII 魔数 */
function magic(bytes, off, str) {
  for (let i = 0; i < str.length; i++) {
    if (bytes[off + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

/* ============================ PalmDOC (LZ77) 解压 ============================ */

/**
 * PalmDOC 压缩算法（LZ77 变体）解压，逐字节解码规则：
 *   0x00            -> 字面量 0
 *   0x01 ~ 0x08     -> 后跟 b 个字面量
 *   0x09 ~ 0x7f     -> 该字符本身
 *   0x80 ~ 0xbf     -> 与下一字节组成 pair：距离=(pair>>3)&0x7ff，长度=(pair&7)+3，回溯复制
 *   0xc0 ~ 0xff     -> 空格 + (b ^ 0x80)
 */
function decompressPalmDoc(src) {
  const CHUNK = 64 * 1024;
  let out = new Uint8Array(Math.max(CHUNK, src.length * 2));
  let o = 0;
  let s = 0;
  const ensure = n => {
    if (o + n > out.length) {
      let cap = out.length * 2;
      while (cap < o + n) cap *= 2;
      const bigger = new Uint8Array(cap);
      bigger.set(out.subarray(0, o));
      out = bigger;
    }
  };
  while (s < src.length) {
    const b = src[s++];
    if (b === 0) {
      ensure(1); out[o++] = 0;
    } else if (b < 9) {
      ensure(b);
      for (let j = 0; j < b && s < src.length; j++) out[o++] = src[s++];
    } else if (b < 0x80) {
      ensure(1); out[o++] = b;
    } else if (b < 0xc0) {
      ensure(2);
      const pair = (b << 8) | src[s++];
      const dist = (pair >> 3) & 0x7ff;
      const len = (pair & 7) + 3;
      ensure(len);
      for (let j = 0; j < len; j++) { out[o] = out[o - dist]; o++; }
    } else {
      ensure(2);
      out[o++] = 32;
      out[o++] = b ^ 0x80;
    }
  }
  return out.subarray(0, o);
}

/* ==================== 记录尾部附加数据（trailing entries）剔除 ==================== */

/**
 * 从字节数组末尾反向读取变长整数（varint）。
 * MOBI 约定：每字节低 7 位参与数值；最高位为 1 表示"前一个字节仍属于本 varint"。
 * 从后往前读，最多读 4 字节（协议上限）。
 */
function getVarLenFromEnd(arr) {
  let val = 0;
  let shift = 0;
  const start = Math.max(-1, arr.length - 5);
  for (let i = arr.length - 1; i > start; i--) {
    const b = arr[i];
    val |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return val;
}

/**
 * 根据额外数据标志位剔除文本记录尾部的附加数据：
 *  - bit15 ~ bit1 中每个置位比特对应一条记录在末尾的附加数据项，
 *    其长度以 varint 形式写在记录末尾；
 *  - bit0 为 multibyte-overlap 标志：最后 1 字节低 2 位表示还需多丢弃的字节数
 *    （跨记录被截断的多字节字符重叠部分）。
 */
function trimTrailingData(arr, extraFlags) {
  if (!arr || !extraFlags) return arr;
  let a = arr;
  for (let bit = 15; bit > 0; bit--) {
    if (!(extraFlags & (1 << bit))) continue;
    const size = getVarLenFromEnd(a);
    if (size <= 0 || size >= a.length) break;
    a = a.subarray(0, a.length - size);
  }
  if (extraFlags & 1 && a.length > 2) {
    a = a.subarray(0, a.length - (1 + (a[a.length - 1] & 3)));
  }
  return a;
}

/* ============================ 图片识别与提取 ============================ */

const IMG_MAGICS = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], name: 'jpg' },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47], name: 'png' },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38], name: 'gif' },
];

/** 探测一段字节属于哪种图片格式；若被 CRES/CIMG 包装则跳过包装头后再探测 */
function sniffImage(bytes) {
  for (const m of IMG_MAGICS) {
    let ok = true;
    for (let i = 0; i < m.bytes.length; i++) {
      if (bytes[i] !== m.bytes[i]) { ok = false; break; }
    }
    if (ok) return { mime: m.mime, name: m.name, offset: 0 };
  }
  // KDX 类包装：'CRES'/'CIMG' + 4 字节 filler + 真实图片
  if (magic(bytes, 0, 'CRES') || magic(bytes, 0, 'CIMG')) {
    for (const m of IMG_MAGICS) {
      let ok = true;
      for (let i = 0; i < m.bytes.length; i++) {
        if (bytes[12 + i] !== m.bytes[i]) { ok = false; break; }
      }
      if (ok) return { mime: m.mime, name: m.name, offset: 12 };
    }
  }
  return null;
}

/* ============================ HTML 后处理 ============================ */

/** 轻量清理：去除脚本/样式与危险属性，MOBI 内嵌 HTML 常不规整 */
function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '') // 移除 onclick 等
    .replace(/javascript:/gi, '');
}

/**
 * 把整书 HTML 按 <mbp:pagebreak/> 切分为章节，并做三件事：
 *  1) 每章包一层 <section id="sec-N">（ReadMe 要求的稳定章节容器）
 *  2) 扫描每章内的 h1~h4 标题生成目录（TOC），给标题元素挂锚点 id
 *  3) 书籍没有标题级结构时，用内联目录的 filepos 链接反推章节目录
 * @param {string} html 已经过 sanitize 清理的整书 HTML
 * 返回 { sections: [{id, html}], toc: [{anchor, title, level}] }
 */

/** 计算 JS 字符串按 UTF-8 编码后的字节数 */
function utf8ByteLen(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i);
    if (c > 0xffff) i++;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * 从正文里的内联目录链接 <a filepos="N">标题</a> 反推章节目录。
 * MOBI 规范中 filepos 是相对"解码后 rawML 文本"的字节偏移；
 * 我们记录每个章节起点在原始 HTML 字符串中的 UTF-8 字节偏移，
 * 即可把任意 filepos 归属到正确的章节。
 */
function buildFilePosToc(html, secStartBytes) {
  const out = [];
  const seen = new Set();
  const linkRe = /<a\s[^>]*?filepos=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const target = Number(m[1]);
    const label = stripTags(m[2]).replace(/^[\s\d.、()（）-]+/, '').trim();
    if (!target || !label || label.length > 60 || /^目录$/.test(label)) continue;

    // 找到 filepos 所属章节（最后一个起点 <= target 的节）
    let k = -1;
    for (let j = secStartBytes.length - 1; j >= 0; j--) {
      if (secStartBytes[j] <= target) { k = j; break; }
    }
    if (k < 0) continue;
    const key = `${k}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ anchor: `sec-${k}`, title: label, level: 1 });
    if (out.length > 500) break;
  }
  return out;
}

function buildSections(html) {
  /* ---- 按 pagebreak 标签的位置切分（不替换字符串，避免误伤正文） ---- */
  const pbRe = /<\/?mbp:pagebreak[^>]*>/gi;
  const chunks = [];       // [{start, end}] 每个候选章节的字符区间
  let cursor = 0;
  let m;
  while ((m = pbRe.exec(html))) {
    chunks.push({ start: cursor, end: m.index });
    cursor = m.index + m[0].length;
  }
  chunks.push({ start: cursor, end: html.length });

  /* ---- 过滤掉无实际内容的片段 ---- */
  const hasContent = s =>
    s.includes('<img') ||
    s.replace(/&nbsp;/gi, '').replace(/<[^>]+>/g, '').trim().length > 0;
  const kept = chunks.filter(c => hasContent(html.slice(c.start, c.end)));

  /* ---- 章节起点的字节偏移（UTF-8 口径，用于 filepos 归属） ---- */
  const secStartBytes = [];
  let bytesSoFar = 0;
  let prevCharIdx = 0;
  for (const c of kept) {
    bytesSoFar += utf8ByteLen(html.slice(prevCharIdx, c.start));
    prevCharIdx = c.start;
    secStartBytes.push(bytesSoFar);
  }

  const sections = [];
  const headToc = [];
  kept.forEach((c, idx) => {
    const part = html.slice(c.start, c.end).trim();
    const secId = `sec-${idx}`;
    // 收集标题：h1/h2/h3/h4
    const headingRe = /<(h[1-4])([^>]*)>([\s\S]*?)<\/\1>/gi;
    const found = [];
    let hIdx = 0;
    const partAnchored = part.replace(headingRe, (whole, tag, attrs, inner) => {
      const text = stripTags(inner).trim();
      if (text) {
        const anchor = `${secId}-h${hIdx++}`;
        found.push({ anchor, title: text.slice(0, 60), level: Number(tag[1]) });
        // 给该标题追加 id 属性用于锚点跳转
        return /id\s*=/i.test(attrs)
          ? whole
          : `<${tag} id="${anchor}"${attrs}>${inner}</${tag}>`;
      }
      return whole;
    });
    found.forEach(f => headToc.push(f));
    sections.push({
      id: secId,
      html: `<section class="mobi-section" id="${secId}">${partAnchored}</section>`,
      plain: stripTags(partAnchored), // 整节纯文本，供 TTS 使用
    });
  });

  /* ---- 目录优先级：真实标题(h1-h4) > 内联目录(filepos) > 兜底"第 N 节" ---- */
  let toc = headToc;
  if (toc.length < 3) {
    const fpToc = buildFilePosToc(html, secStartBytes);
    if (fpToc.length > toc.length) toc = fpToc;
  }

  return { sections, toc };
}

/** 去掉标签取纯文本 */
function stripTags(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ============================ 主流程 ============================ */

/**
 * 进度上报钩子。
 *  - 在 Worker 环境中：通过 postMessage 发给主线程；
 *  - 在主线程降级环境（无法创建 Worker，如直接双击打开页面）：
 *    由 mobiParser.js 设置 __progressHook 收集进度。
 */
var __progressHook = null;
function post(msg) {
  if (__progressHook) { __progressHook(msg); return; }
  if (typeof document === 'undefined') self.postMessage(msg); // 仅在 Worker 中才走这条路
}

/* ========================== 格式分发（EPUB / MOBI） ========================== */

/**
 * 按魔数判格式，扩展名只作兜底 —— 真实书库里改名文件很常见。
 * ZIP 的本地文件头固定是 "PK\x03\x04"，而 EPUB 就是个 ZIP。
 * 先判 ZIP 是因为 PDB 头前两字节是大端的记录数，理论上可能撞上 "PK"，
 * 而 ZIP 不可能通过 MOBI 的 BOOKMOBI 校验。
 */
function detectFormat(u8, fileName) {
  if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b &&
    (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07)) return 'epub';
  if (/\.(epub|zip)$/i.test(fileName || '')) return 'epub';
  return 'mobi';
}

/**
 * 统一解析入口。MOBI 是同步的，EPUB 要走 DecompressionStream 因而必然异步，
 * 所以返回值可能是 Promise —— 调用方一律 await。
 * @returns {Promise<object>|object} 结构见 parseMOBI() 末尾
 */
function parseBook(buffer, fileName) {
  if (detectFormat(new Uint8Array(buffer), fileName) === 'epub') {
    if (typeof parseEPUB !== 'function') {
      throw new Error('EPUB 解析模块未加载成功，请刷新页面后重试');
    }
    return parseEPUB(buffer, fileName);
  }
  return parseMOBI(buffer, fileName);
}

// 作为经典脚本被 <script> 引入时，此赋值落在 window 上（无害）；
// 作为 Worker 时这是消息入口。
self.onmessage = async e => {
  const { buffer, fileName } = e.data;
  try {
    post({ type: 'progress', stage: '读取结构', pct: 5 });
    // 必须 await：EPUB 路径返回 Promise，漏掉会让 payload 变成 Promise 对象，
    // 经 postMessage 结构化克隆后主线程拿到一个空对象
    const result = await parseBook(buffer, fileName);
    post({ type: 'done', payload: result });
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

function parseMOBI(buffer, fileName) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  /* ---- PDB/Palm 数据库头 ---- */
  if (u8.length < 78) throw new Error('文件太小，不是有效的 MOBI 文件');
  const numRecords = u16(dv, 76);
  if (numRecords < 1 || 78 + numRecords * 8 > u8.length) {
    throw new Error('记录表损坏，无法解析');
  }
  const offs = [];
  for (let i = 0; i < numRecords; i++) offs.push(u32(dv, 78 + i * 8));

  /* ---- 记录 0：PalmDOC 头 + MOBI 头 ---- */
  const r0 = offs[0];
  const compression = u16(dv, r0);
  const textRecordCount = u16(dv, r0 + 8);
  // PalmDOC 头布局：compression@0 / unused@2 / 文本长度@4 / 记录数@8 /
  // 记录大小@10 / 加密类型@12 / 未知@14 —— 共 16 字节，随后才是 MOBI 头
  const encryption = u16(dv, r0 + 12);

  if (encryption !== 0) throw new Error('该文件含 DRM 加密，无法解析。请使用无 DRM 的个人书籍。');

  /* 压缩类型兼容处理：
     - 1 = 标准 PalmDOC，直接支持；
     - 2 = 声称 HUFF/CDIC 高级压缩。部分转换工具（如某些 epub→mobi）
       会错误地标记为 2 但实际正文仍是 PalmDOC 且没有压缩表
       （huffOffset 为 0 或指向的记录不是 'HUFF'）——此时按 PalmDOC 解；
     - 只有存在有效 HUFF 表时才算真正不支持，给出明确提示。 */
  let forcePalmDoc = false;
  if (compression !== 1) {
    const huffOff = u32(dv, r0 + 0x70);
    const huffCount = u32(dv, r0 + 0x74);
    const validHuff =
      huffOff > 0 && huffOff < numRecords && huffCount > 0 &&
      huffOff + 1 <= offs.length && magic(u8, offs[huffOff], 'HUFF');
    if (validHuff) {
      throw new Error(
        '该文件使用 HUFF/CDIC 高级压缩，本阅读器暂不支持。\n可用 Calibre 将其转换为"旧版 MOBI (MOBI 6)"后再导入。');
    }
    forcePalmDoc = true; // 头部声明与实际内容不符 → 降级按 PalmDOC 处理
  }

  let title = fileName.replace(/\.[^.]+$/, '') || '未命名';
  let author = '';
  let encoding = 1252;
  let firstImageIndex = -1;
  let exthCoverIndex = -1;
  let extraFlags = 0;

  const hasMobiHeader = magic(u8, r0 + 16, 'MOBI');
  if (hasMobiHeader) {
    // 注意：以下字段偏移均相对"记录 0"开头（遵循 MOBI 规范约定）
    const headerLen = u32(dv, r0 + 20);          // MOBI 头自身长度
    encoding = u32(dv, r0 + 28) || 1252;         // 0x1C 文本编码

    // 全名（书名）：0x54 存偏移、0x58 存长度，值相对记录 0 开头
    const fnOff = u32(dv, r0 + 0x54);
    const fnLen = u32(dv, r0 + 0x58);
    if (fnLen > 0 && r0 + fnOff + fnLen <= u8.length) {
      title = decode(u8.subarray(r0 + fnOff, r0 + fnOff + fnLen), encoding);
    }

    // 0x6C 首个图片记录索引
    firstImageIndex = u32(dv, r0 + 0x6c);

    // 额外数据标志（仅当 MOBI 头足够长时存在），位于记录 0 的 0xF2
    if (headerLen >= 0xe4 && r0 + 0xf4 <= u8.length) {
      extraFlags = u16(dv, r0 + 0xf2);
    }

    /* ---- EXTH 扩展元数据（作者、封面等） ---- */
    const exthFlag = u32(dv, r0 + 0x80);
    const exthStart = r0 + 16 + headerLen;
    if ((exthFlag & 0x40) && magic(u8, exthStart, 'EXTH')) {
      const recCount = u32(dv, exthStart + 8);
      let p = exthStart + 12;
      for (let i = 0; i < recCount && p + 8 <= u8.length; i++) {
        const type = u32(dv, p);
        const len = u32(dv, p + 4);
        if (len < 8 || p + len > u8.length) break;
        if (type === 100) author = decode(u8.subarray(p + 8, p + len), encoding); // 作者
        if (type === 201) exthCoverIndex = u32(dv, p + 8) - 1;                    // 封面（相对首图记录）
        p += len;
      }
    }

    /* ---- 双模式文件（同包同时含 MOBI6 与 KF8/AZW3）----
       EXTH 记录 118 指向 KF8 边界记录，其后的记录属于 KF8 部分，
       本阅读器只解析前半段（MOBI6）。 */
    let kf8Boundary = -1;
    if (magic(u8, exthStart, 'EXTH')) {
      const recCount = u32(dv, exthStart + 8);
      let p = exthStart + 12;
      for (let i = 0; i < recCount && p + 8 <= u8.length; i++) {
        const type = u32(dv, p);
        const len = u32(dv, p + 4);
        if (len < 8 || p + len > u8.length) break;
        if (type === 118) kf8Boundary = u32(dv, p + 8);
        p += len;
      }
    }
    if (kf8Boundary > 0 && kf8Boundary < numRecords) {
      // 截断到 KF8 部分；若文本记录数超出边界也要收缩
      var textRecordsAvailable = kf8Boundary - 1; // 记录 1..boundary-1 属于 MOBI6
    }
  }

  const textCount = Math.min(textRecordCount,
    typeof textRecordsAvailable !== 'undefined' && textRecordsAvailable > 0
      ? textRecordsAvailable : textRecordCount);
  if (textCount < 1) throw new Error('未找到正文文本记录');

  /* ---- 逐条解压文本记录并拼接 ----
     注意：文本记录是 PDB 记录表中的第 1 ~ textCount 条（记录 0 是头） */
  const chunks = [];
  let totalRaw = 0;
  for (let i = 0; i < textCount; i++) {
    if ((i & 31) === 0) post({ type: 'progress', stage: '解压文本', pct: 10 + Math.round(i / textCount * 60) });
    const recIdx = i + 1;
    const end = recIdx + 1 < numRecords ? offs[recIdx + 1] : u8.length;
    let raw = u8.subarray(offs[recIdx], end);
    raw = trimTrailingData(raw, extraFlags);
    chunks.push(decompressPalmDoc(raw));
    totalRaw += chunks[chunks.length - 1].length;
  }

  // 合并所有解压结果后一次性解码
  const merged = new Uint8Array(totalRaw);
  let mo = 0;
  for (const c of chunks) { merged.set(c, mo); mo += c.length; }

  post({ type: 'progress', stage: '生成章节', pct: 78 });
  let html = decode(merged, encoding);

  /* ---- 图片资源提取（供 img[recindex] 引用）---- */
  const images = [];
  if (firstImageIndex > 0 && firstImageIndex < numRecords) {
    for (let i = firstImageIndex; i < numRecords; i++) {
      const start = offs[i];
      const stop = (i + 1 < numRecords ? offs[i + 1] : u8.length);
      const slice = u8.subarray(start, stop);
      const kind = sniffImage(slice);
      if (!kind) continue;
      images.push({
        mime: kind.mime,
        buffer: slice.slice(kind.offset).buffer, // 复制独立 ArrayBuffer 以便结构化克隆
      });
      if ((i - firstImageIndex) % 50 === 0) {
        post({ type: 'progress', stage: '提取图片', pct: Math.min(97, 80 + Math.round((i - firstImageIndex) / (numRecords - firstImageIndex) * 15)) });
      }
    }
  }

  /* ---- 正文处理：清理 → recindex 改造 → 分章 ---- */
  html = sanitizeHtml(html);
  // 把 recindex="000NN" 转成 data-recindex="N"（1 基序号，渲染时映射到提取的图片）
  html = html.replace(/<img([^>]*?)recindex\s*=\s*["']?(\d+)["']?/gi,
    (w, pre, num) => `<img${pre}data-recindex="${parseInt(num, 10)}"`);

  const { sections, toc } = buildSections(html);
  if (!sections.length) throw new Error('解析成功但未发现正文内容');

  /* ---- 封面 ---- */
  let cover = null;
  const coverIdx = exthCoverIndex >= 0 ? exthCoverIndex : 0;
  if (images[coverIdx]) {
    cover = {
      mime: images[coverIdx].mime,
      base64: arrayBufferToBase64(images[coverIdx].buffer),
    };
  } else if (exthCoverIndex >= 0 && images[Math.max(0, exthCoverIndex)]) {
    cover = { mime: images[Math.max(0, exthCoverIndex)].mime, base64: '' };
  }

  post({ type: 'progress', stage: '完成', pct: 100 });
  return {
    title,
    author,
    meta: {
      format: forcePalmDoc ? 'MOBI6(PalmDOC·声明异常已自动纠正)' : 'MOBI6(PalmDOC)',
      textRecords: textCount, imageCount: images.length,
    },
    sections,          // [{id, html}] —— html 已含 <section id=...> 包裹
    toc,               // [{anchor, title, level}]
    images,            // [{mime, buffer}]
    cover,             // {mime, base64} 或 null
  };
}

/** 大数组安全转 base64（Worker 里也有 btoa，但要分块防栈溢出） */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
