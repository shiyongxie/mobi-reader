/**
 * epubParser.js —— EPUB 解析（零依赖）
 * -------------------------------------------------------------
 * EPUB 就是一个 ZIP 包：META-INF/container.xml 指出 OPF，OPF 的 spine 给出
 * 正文文档顺序，每篇文档是一份 XHTML。解压用浏览器内置的
 * DecompressionStream('deflate-raw')（Baseline 2023-05，Worker 内亦可用），
 * 因此不需要引入任何压缩库。
 *
 * 产出必须严格匹配 parseWorker.js 的 book 契约（见 README 与 mobiParser.js）：
 *   - sections[i].id 必须等于 'sec-' + i（annotations.js 靠它反查数组下标）
 *   - 每节 html 自带 <section class="mobi-section" id="sec-N"> 包裹
 *   - toc[].anchor 必须能在某节 html 里找到同名 id（否则目录跳转静默失败）
 *   - 图片走 <img data-recindex="N">（1 基）+ images[N-1].buffer，复用
 *     reader.js 既有的 Blob URL 惰性管线
 *
 * 关于作用域：本文件会被 parseWorker.js（Worker 内 importScripts）
 * 和 mobiParser.js（主线程动态 <script>）两条路径加载，与 parseWorker.js
 * 共享同一个全局作用域。parseWorker.js 顶层声明了 u16/u32/post 等通用名，
 * 若此处再用同名顶层函数会**静默覆盖**它们、直接搞坏 MOBI 解析，
 * 所以整份实现包在 IIFE 里，只对外暴露一个 parseEPUB。
 */
'use strict';

(function (scope) {

  /* ============================ 二进制读取 ============================ */

  /** ZIP 中央目录与本地头都是小端 */
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  function decodeUtf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) { return ''; }
  }

  /** deflate-raw 解压（ZIP 的 method 8 就是裸 DEFLATE，无 zlib 头与校验和） */
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** 取出独立的 ArrayBuffer 副本（结构化克隆与 IndexedDB 落库都要求不共享底层缓冲） */
  function toArrayBuffer(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  /* ============================== ZIP 读取 ============================== */

  /**
   * 解析中央目录。**只认中央目录里的尺寸**——本地头在启用 data descriptor
   * （通用标志位 bit 3）时尺寸字段为 0，照它读会解压出错。
   */
  function openZip(u8) {
    if (u8.length < 22) throw new Error('EPUB 文件过小，不是有效的 EPUB');

    // EOCD 在文件尾部，后面可能跟着最长 65535 字节的注释，故回扫 64KB+22
    let eocd = -1;
    const floor = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= floor; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        eocd = i; break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB：未找到 ZIP 结束记录');

    const count = u16(u8, eocd + 10);
    const cdSize = u32(u8, eocd + 12);
    const cdOff = u32(u8, eocd + 16);
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
      throw new Error('暂不支持 ZIP64 格式的 EPUB（通常超过 4GB）');
    }
    if (cdOff + cdSize > u8.length) throw new Error('EPUB 中央目录越界，文件可能已损坏');

    const entries = new Map();
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length || u32(u8, p) !== 0x02014b50) break;
      const method = u16(u8, p + 10);
      const csize = u32(u8, p + 20);
      const nlen = u16(u8, p + 28);
      const elen = u16(u8, p + 30);
      const clen = u16(u8, p + 32);
      const lho = u32(u8, p + 42);
      const name = decodeUtf8(u8.subarray(p + 46, p + 46 + nlen));
      // 目录条目（以 / 结尾）没有内容，留着只会干扰路径查找
      if (name && !name.endsWith('/')) {
        entries.set(name, { method, csize, name, lho });
      }
      p += 46 + nlen + elen + clen;
    }
    if (!entries.size) throw new Error('EPUB 里没有任何文件，压缩包可能已损坏');

    /* 部分 epub 的 OPF 里写的路径大小写与包内实际条目不一致（转换工具留下的坑），
       严格匹配会整本书读不出来，故备一张小写索引做兜底查找。 */
    const lower = new Map();
    for (const [name, e] of entries) {
      const k = name.toLowerCase();
      if (!lower.has(k)) lower.set(k, e);
    }

    async function read(name) {
      const e = entries.get(name) || lower.get(String(name).toLowerCase());
      if (!e) return null;
      const start = localDataStart(u8, e);
      if (start < 0 || start + e.csize > u8.length) return null;
      const raw = u8.subarray(start, start + e.csize);
      if (e.method === 0) return raw.slice();
      if (e.method !== 8) {
        throw new Error('EPUB 使用了不支持的压缩方式（method=' + e.method + '）');
      }
      return inflateRaw(raw);
    }

    return {
      names: [...entries.keys()],
      read,
      async text(name) {
        const b = await read(name);
        return b ? decodeUtf8(b) : null;
      },
    };
  }

  /** 定位条目数据段：本地头之后跳过它自己的文件名与扩展区 */
  function localDataStart(u8, e) {
    const p = e.lho;
    if (p + 30 > u8.length || u32(u8, p) !== 0x04034b50) {
      // 本地头坏了就退而求其次：多数工具写的扩展区长度为 0
      return p + 30 + e.name.length;
    }
    return p + 30 + u16(u8, p + 26) + u16(u8, p + 28);
  }

  /* ============================== 路径工具 ============================== */

  function dirOf(path) {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }

  function normalize(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }

  /** 把相对 href 解析成包内绝对路径（EPUB 里 href 是相对当前文档的） */
  function resolvePath(baseDir, rel) {
    let r = String(rel || '').split('#')[0];
    try { r = decodeURIComponent(r); } catch (e) { /* 非法转义就按原样用 */ }
    if (r.startsWith('/')) return normalize(r.slice(1));
    return normalize(baseDir ? baseDir + '/' + r : r);
  }

  /* ============================== 通用小工具 ============================== */

  function attr(tagText, name) {
    const m = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tagText);
    if (!m) return '';
    return m[2] !== undefined ? m[2] : m[3];
  }

  /** 原样保留某个属性的书写形式（含引号），用于透传 alt */
  function rawAttr(tagText, name) {
    const m = new RegExp('\\s' + name + '\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i').exec(tagText);
    return m ? ' ' + name + '=' + m[1] : '';
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (w, d) => String.fromCharCode(Number(d)))
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
  }

  function stripTags(html) {
    return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ').trim();
  }

  function sniffImage(b) {
    if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E) return 'image/png';
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42) return 'image/webp';
    return null;
  }

  function toBase64(bytes) {
    let bin = '';
    const CH = 0x8000;                      // 分块防 String.fromCharCode 爆栈
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function progress(stage, pct) {
    if (typeof scope.post === 'function') scope.post({ type: 'progress', stage, pct });
  }

  /* ================================ 清洗 ================================ */

  /* EPUB 是不可信输入：正文最终会被 createContextualFragment 注入文档。
     注意 createContextualFragment 本身**不执行** <script>，真正的风险是
     ① on* 事件属性（注入即生效）② javascript: 链接（点击即执行）
     ③ 会自行加载内容的嵌入元素。三者都在下面处理掉。

     反复替换到稳定为止，是为了对付 <scr<script>ipt> 这类嵌套绕过。 */
  const DROP_TAGS = 'script|iframe|object|embed|applet|frame|frameset|form|input|' +
    'button|select|textarea|link|meta|base|style|noscript';

  function sanitize(html) {
    let prev = null;
    let out = html;
    for (let i = 0; i < 5 && out !== prev; i++) {
      prev = out;
      out = out
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<![^>]*>/g, '')
        .replace(new RegExp('<(' + DROP_TAGS + ')\\b[\\s\\S]*?<\\/\\1\\s*>', 'gi'), '')
        .replace(new RegExp('</?(' + DROP_TAGS + ')\\b[^>]*>', 'gi'), '')
        // on* 事件属性（值可能带引号，也可能不带）
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // 作者样式一律丢弃：排版交给阅读器的主题与字号设置（已与用户确认）
        .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // javascript:/vbscript: 一律拦；data: 只拦 href（src 上的 data:image 是
        // 合法的内嵌图片，且 <img> 加载的 SVG 不执行脚本）
        .replace(/\s(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (w, name, val) => {
          const v = val.replace(/^["']|["']$/g, '').trim();
          if (/^\s*(javascript|vbscript)\s*:/i.test(v)) return ' ' + name + '="#"';
          if (name.toLowerCase() === 'href' && /^\s*data\s*:/i.test(v)) return ' ' + name + '="#"';
          return w;
        });
    }
    return out;
  }

  /* ============================== 正文抽取 ============================== */

  function extractBody(html) {
    const m = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
    return m ? m[1] : html;
  }

  /**
   * 把 <svg><image xlink:href="cover.jpg"/></svg> 这种封面写法压平成普通 <img>。
   * 不少 epub 用整页 SVG 包裹封面，不处理的话封面页在阅读区里是一片空白。
   * 只在 SVG 里确实引用了栅格图时才压平，避免动到真正的矢量插图。
   */
  function flattenSvgImages(html) {
    return html.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, block => {
      const m = /xlink:href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(block) ||
        /<image\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(block);
      if (!m) return block;
      // 单引号写法里可能含双引号，塞进我们的双引号属性会截断标签，故一律剔掉
      const src = (m[2] !== undefined ? m[2] : m[3]).replace(/["'<>]/g, '');
      if (!src || !/\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(src)) return block;
      return `<img src="${src}"/>`;
    });
  }

  /** 把内嵌图片抽成 data-recindex 索引，复用 reader.js 的 Blob URL 管线 */
  async function inlineImages(body, docPath, zip, imgIndex, images) {
    const dir = dirOf(docPath);
    let out = '';
    let last = 0;
    const re = /<img\b[^>]*>/gi;
    let m;
    while ((m = re.exec(body))) {
      const tag = m[0];
      out += body.slice(last, m.index);
      last = m.index + tag.length;

      const src = attr(tag, 'src');
      // 已经是内嵌 data: URI 的图（上面清洗时放行了 src 上的 data:）直接用
      if (!src) continue;
      if (/^\s*data:/i.test(src)) { out += tag; continue; }

      const target = resolvePath(dir, src);
      let idx = imgIndex.get(target);
      if (idx === undefined) {
        const bytes = await zip.read(target);
        if (!bytes || !bytes.length) continue;      // 读不到就整张丢掉，不留死链
        const mime = sniffImage(bytes);
        if (!mime) continue;
        images.push({ mime, buffer: toArrayBuffer(bytes) });
        idx = images.length;                        // 契约要求 1 基
        imgIndex.set(target, idx);                  // 同一张图只存一份
      }
      out += `<img data-recindex="${idx}"${rawAttr(tag, 'alt')}/>`;
    }
    return out + body.slice(last);
  }

  /**
   * 给正文里原有的 id 定名，并建立「文档#片段 → 最终 id」映射。
   * 跨文档重名（两章都叫 note1）会给后出现的一篇加 sec-N-- 前缀；
   * 改名只取决于文档顺序，因此对同一文件是确定性的 —— 标注偏移依赖这一点。
   */
  function assignIds(body, docPath, secId, usedIds, idMap) {
    return body.replace(
      /(<[a-zA-Z][^>]*?\sid\s*=\s*)("([^"]*)"|'([^']*)')/g,
      (whole, pre, q, dq, sq) => {
        const orig = dq !== undefined ? dq : sq;
        if (!orig) return whole;
        let final = orig;
        if (usedIds.has(final)) final = secId + '--' + orig;
        let n = 2;
        while (usedIds.has(final)) final = secId + '--' + orig + '-' + (n++);
        usedIds.add(final);
        // 片段映射以**首次出现**为准，与浏览器 getElementById 的行为一致
        if (!idMap.has(docPath + '#' + orig)) idMap.set(docPath + '#' + orig, final);
        idMap.set(docPath + '#' + final, final);
        return pre + '"' + final + '"';
      });
  }

  /** 把跨文档/跨片段的内部链接改写到我们已经定好的锚点上 */
  function rewriteLinks(body, docPath, idMap) {
    const dir = dirOf(docPath);
    return body.replace(
      /(<a\b[^>]*?\shref\s*=\s*)("([^"]*)"|'([^']*)')/gi,
      (whole, pre, q, dq, sq) => {
        const href = (dq !== undefined ? dq : sq) || '';
        if (!href) return whole;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
          // http(s) 保留可点，但带上 rel/target —— 否则点一下就再也回不到阅读器了
          if (!/^https?:/i.test(href)) return whole;
          let extra = '';
          if (!/\srel\s*=/i.test(pre)) extra += ' rel="noopener noreferrer"';
          if (!/\starget\s*=/i.test(pre)) extra += ' target="_blank"';
          return pre + '"' + href + '"' + extra;
        }
        if (href.startsWith('#')) {
          const a = idMap.get(docPath + '#' + href.slice(1));
          return pre + '"' + (a ? '#' + a : '#') + '"';
        }
        const at = href.indexOf('#');
        const pathPart = at < 0 ? href : href.slice(0, at);
        const frag = at < 0 ? '' : href.slice(at + 1);
        const target = resolvePath(dir, pathPart);
        // 指向另一篇文档的某个片段优先；找不到片段就退到该篇文档的节锚点
        const a = (frag && idMap.get(target + '#' + frag)) || idMap.get(target);
        return pre + '"#' + (a || '') + '"';
      });
  }

  /* ================================ 目录 ================================ */

  /** EPUB3：manifest 里 properties 含 nav 的 XHTML，取其中 epub:type="toc" 的 nav */
  function parseNavToc(html) {
    const nav = /<nav\b[^>]*epub:type\s*=\s*["']toc["'][^>]*>([\s\S]*?)<\/nav\s*>/i.exec(html)
      || /<nav\b[^>]*>([\s\S]*?)<\/nav\s*>/i.exec(html);
    if (!nav) return [];
    const out = [];
    // 线性扫描：用 <ol> 的开关维护层级，比递归匹配稳
    const re = /<ol\b[^>]*>|<\/ol\s*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    let depth = 0;
    let m;
    while ((m = re.exec(nav[1]))) {
      const tok = m[0];
      if (/^<ol/i.test(tok)) { depth++; continue; }
      if (/^<\/ol/i.test(tok)) { depth = Math.max(0, depth - 1); continue; }
      const href = attr(m[1], 'href');
      const title = stripTags(m[2]);
      if (href && title) out.push({ href, title, level: Math.max(1, depth) });
    }
    return out;
  }

  /** EPUB2：toc.ncx 的 navMap/navPoint，层级靠 navPoint 嵌套深度 */
  function parseNcxToc(html) {
    const map = /<navMap\b[^>]*>([\s\S]*?)<\/navMap\s*>/i.exec(html);
    if (!map) return [];
    const out = [];
    const re = /<navPoint\b[^>]*>|<\/navPoint\s*>|<text\b[^>]*>([\s\S]*?)<\/text\s*>|<content\b([^>]*)\/?>/gi;
    let depth = 0;
    let pending = '';
    let m;
    while ((m = re.exec(map[1]))) {
      const tok = m[0];
      if (/^<navPoint/i.test(tok)) { depth++; continue; }
      if (/^<\/navPoint/i.test(tok)) { depth = Math.max(0, depth - 1); continue; }
      if (/^<text/i.test(tok)) { pending = stripTags(m[1]); continue; }
      // <content> 紧跟在 navLabel 之后，此刻的 pending 就是它的标题
      const src = attr(m[2] || '', 'src');
      if (src && pending) {
        out.push({ href: src, title: pending, level: Math.max(1, depth) });
        pending = '';
      }
    }
    return out;
  }

  /** 目录条目 → 我们生成的锚点；解析不到的一律丢弃（留着只会跳转失败） */
  function mapToc(entries, tocDocPath, idMap) {
    const dir = dirOf(tocDocPath);
    const out = [];
    for (const e of entries) {
      const at = e.href.indexOf('#');
      const pathPart = at < 0 ? e.href : e.href.slice(0, at);
      const frag = at < 0 ? '' : e.href.slice(at + 1);
      const target = resolvePath(dir, pathPart || tocDocPath);
      // 无片段 → 指向整节；有片段 → 优先精确锚点，退而求其次指向所在节
      const anchor = (frag && idMap.get(target + '#' + frag)) || idMap.get(target);
      if (anchor) out.push({ anchor, title: e.title, level: e.level });
    }
    return out;
  }

  /* =============================== 主流程 =============================== */

  async function parseEPUB(buffer, fileName) {
    const u8 = new Uint8Array(buffer);
    const zip = openZip(u8);
    progress('读取 EPUB 结构', 8);

    /* ---- container.xml → OPF 路径 ---- */
    const container = await zip.text('META-INF/container.xml');
    let opfPath = '';
    if (container) {
      const m = /<rootfile\b[^>]*full-path\s*=\s*("([^"]*)"|'([^']*)')/i.exec(container);
      if (m) opfPath = m[2] !== undefined ? m[2] : m[3];
    }
    if (!opfPath) {
      // container.xml 缺失或坏掉：退而求其次在包里找一个 .opf
      opfPath = zip.names.find(n => /\.opf$/i.test(n)) || '';
    }
    if (!opfPath) throw new Error('不是有效的 EPUB：找不到 OPF 清单文件');
    // 少数文件的 full-path 带前导斜杠
    opfPath = normalize(opfPath.replace(/^\//, ''));
    const opfDir = dirOf(opfPath);

    const opf = await zip.text(opfPath);
    if (!opf) throw new Error('EPUB 的 OPF 清单读取失败');

    /* ---- metadata ---- */
    const titleFromOpf = firstTagText(opf, 'dc:title') || firstTagText(opf, 'title');
    const author = firstTagText(opf, 'dc:creator');
    const title = titleFromOpf || (fileName || '').replace(/\.[^.]+$/, '') || '未命名';

    /* ---- manifest ---- */
    const items = new Map();
    const reItem = /<item\b([^>]*?)\/?>/gi;
    let m;
    while ((m = reItem.exec(opf))) {
      const a = m[1];
      const id = attr(a, 'id');
      if (!id) continue;
      items.set(id, {
        href: attr(a, 'href'),
        type: attr(a, 'media-type'),
        props: attr(a, 'properties'),
      });
    }

    /* ---- spine ---- */
    const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine\s*>/i.exec(opf);
    const spineHrefs = [];
    if (spineBlock) {
      const reRef = /<itemref\b([^>]*?)\/?>/gi;
      while ((m = reRef.exec(spineBlock[1]))) {
        const it = items.get(attr(m[1], 'idref'));
        // linear="no" 多为封面/广告页，但直接丢掉会漏内容，故一律保留
        if (it && it.href) spineHrefs.push(it.href);
      }
    }
    if (!spineHrefs.length) {
      // 没有 spine（或 spine 全坏）：按 manifest 里所有 XHTML 文档顺序兜底
      for (const it of items.values()) {
        if (/xhtml|html/i.test(it.type) || /\.x?html?$/i.test(it.href)) spineHrefs.push(it.href);
      }
    }
    if (!spineHrefs.length) throw new Error('EPUB 里没有可读的正文文档');

    /* ---- 第一遍：读文档、定 name、建立 id 映射 ---- */
    progress('解析章节', 20);
    const usedIds = new Set();
    const idMap = new Map();
    const imgIndex = new Map();
    const images = [];
    const docs = [];

    for (const href of spineHrefs) {
      const docPath = resolvePath(opfDir, href);
      const raw = await zip.text(docPath);
      if (raw === null) continue;                   // 清单里列了但包里没有，跳过
      const secId = 'sec-' + docs.length;
      usedIds.add(secId);                           // 防止正文里的 id 与节 id 撞车
      docs.push({ docPath, secId, raw });
    }
    if (!docs.length) throw new Error('EPUB 的正文文档全部读取失败');

    /* 逐章上报进度：调度层的看门狗靠「有没有新消息」判断 Worker 是否还活着，
       大书的重活全在这一段（每章都要解压 + 清洗 + 提图），若这里长时间
       一声不吭，看门狗会误判成 Worker 卡死而整个重跑一遍主线程。 */
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      let body = flattenSvgImages(sanitize(extractBody(d.raw)));
      body = await inlineImages(body, d.docPath, zip, imgIndex, images);
      d.body = assignIds(body, d.docPath, d.secId, usedIds, idMap);
      idMap.set(d.docPath, d.secId);                // 指向整篇文档的链接
      progress('解析章节', 20 + Math.round((i + 1) / docs.length * 50));
    }

    /* ---- 第二遍：此时 idMap 已完整，改写链接才能解析到前向引用 ---- */
    const sections = [];
    for (const d of docs) {
      const body = rewriteLinks(d.body, d.docPath, idMap);
      sections.push({
        id: d.secId,
        html: `<section class="mobi-section" id="${d.secId}">${body}</section>`,
        plain: stripTags(body),
      });
    }

    /* ---- 目录 ---- */
    progress('解析目录', 75);
    let rawToc = [];
    let tocDocPath = '';
    let format = 'EPUB2';

    const navItem = [...items.values()].find(it => it.props && /\bnav\b/.test(it.props));
    if (navItem && navItem.href) {
      tocDocPath = resolvePath(opfDir, navItem.href);
      const navHtml = await zip.text(tocDocPath);
      if (navHtml) { rawToc = parseNavToc(navHtml); format = 'EPUB3'; }
    }
    if (!rawToc.length) {
      const ncx = spineBlock ? attr(spineBlock[0], 'toc') : '';
      const ncxItem = (ncx && items.get(ncx)) ||
        [...items.values()].find(it => /dtbncx/i.test(it.type || ''));
      if (ncxItem && ncxItem.href) {
        const p = resolvePath(opfDir, ncxItem.href);
        const ncxHtml = await zip.text(p);
        if (ncxHtml) {
          rawToc = parseNcxToc(ncxHtml);
          if (rawToc.length) { tocDocPath = p; format = format === 'EPUB3' ? 'EPUB3' : 'EPUB2'; }
        }
      }
    }

    let toc = rawToc.length ? mapToc(rawToc, tocDocPath, idMap) : [];
    // 目录为空或几乎没解析出来时，退化成「一节一条」——节元素自带 sec-N 这个 id，
    // 因此这种兜底锚点**必然**可解析，不会出现点了没反应的目录项
    if (toc.length < 2) {
      toc = sections.map((s, i) => ({
        anchor: s.id,
        title: sectionTitle(s.plain) || `第 ${i + 1} 节`,
        level: 1,
      }));
    }

    /* ---- 封面 ---- */
    progress('提取封面', 90);
    const cover = await pickCover(zip, items, opfDir, coverMetaId(opf));

    progress('完成', 100);
    return {
      title,
      author,
      meta: {
        format: format,
        spineCount: sections.length,
        imageCount: images.length,
      },
      sections,
      toc,
      images,
      cover,
    };
  }

  /** 取某节正文的开头一小段当标题（兜底目录用） */
  function sectionTitle(plain) {
    const t = String(plain || '').trim();
    if (!t) return '';
    return t.length > 30 ? t.slice(0, 30) + '…' : t;
  }

  function firstTagText(xml, tag) {
    // 标签名里的冒号要转义（dc:title）
    const name = tag.replace(/:/g, '\\:');
    const m = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '\\s*>', 'i').exec(xml);
    return m ? stripTags(m[1]) : '';
  }

  /** EPUB2 用 <meta name="cover" content="某张图的 manifest id"/> 指封面 */
  function coverMetaId(opf) {
    const m = /<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/i.exec(opf);
    return m ? attr(m[0], 'content') : '';
  }

  async function pickCover(zip, items, opfDir, coverId) {
    let item = null;
    // EPUB3：properties="cover-image"
    for (const it of items.values()) {
      if (it.props && /\bcover-image\b/.test(it.props)) { item = it; break; }
    }
    // EPUB2：<meta name="cover" content="…"/> 指向的 manifest 项
    if (!item && coverId) item = items.get(coverId) || null;
    // 再兜底：id 或文件名里带 cover 的图（转换工具常见命名）
    if (!item) {
      for (const [id, it] of items) {
        if (/cover/i.test(id) || /cover/i.test(it.href || '')) {
          if (/^image\//.test(it.type || '') || /\.(jpe?g|png|gif|webp)$/i.test(it.href || '')) {
            item = it; break;
          }
        }
      }
    }
    // 最后兜底：manifest 里第一张栅格图
    if (!item) {
      for (const it of items.values()) {
        if (/^image\//.test(it.type || '') && !/svg/i.test(it.type)) { item = it; break; }
      }
    }
    if (!item || !item.href) return null;
    const bytes = await zip.read(resolvePath(opfDir, item.href));
    if (!bytes || !bytes.length) return null;
    const mime = sniffImage(bytes) || item.type || 'image/jpeg';
    return { mime, base64: toBase64(bytes) };
  }

  scope.parseEPUB = parseEPUB;

})(typeof self !== 'undefined' ? self : globalThis);
