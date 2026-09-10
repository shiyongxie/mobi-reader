/**
 * scripts/lib/epub-fixture.mjs —— 在内存里造 EPUB（供各测试脚本共用）
 * -------------------------------------------------------------
 * 用 zlib.deflateRawSync 手搓合法 ZIP，不依赖任何第三方库，也不需要
 * 仓库里放二进制测试文件（.gitignore 本来就忽略 *.epub）。
 *
 * 两个用途：
 *   - fixtureEpub3()/fixtureEpub2()：刻意埋进脏内容与跨文档重名 id，
 *     供 test-epub.mjs 断言解析器的边界行为
 *   - makeRealisticEpub()：干净的多章书，供浏览器 e2e 走完整导入链路
 */
import zlib from 'node:zlib';

/* ============================== ZIP 封装 ============================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 拼一个 ZIP。字段偏移按 PKWARE 规范逐一摆放 —— 本地头(LFH)与中央目录(CD)
 * 的位置**不一样**，把一份抄成另一份是最经典的写错方式：
 * 两者 method 分别在 8 / 10，crc 在 14 / 16，压缩与原始尺寸在 18,22 / 20,24。
 * @param {{name:string, data:Buffer, store?:boolean}[]} entries
 */
export function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const store = !!e.store;
    const body = store ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);                    // version needed
    lfh.writeUInt16LE(0, 6);                     // flags：不设 bit3，尺寸直接写在本地头
    lfh.writeUInt16LE(store ? 0 : 8, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);                    // extraLen

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                     // version made by
    cd.writeUInt16LE(20, 6);                     // version needed
    cd.writeUInt16LE(0, 8);                      // flags
    cd.writeUInt16LE(store ? 0 : 8, 10);         // method（注意与 LFH 的 8 不同）
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);                // localHeaderOffset

    parts.push(lfh, nameBuf, body);
    central.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);         // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10);        // 总条目数
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);                // 中央目录起始偏移
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/* --------------------------------- PNG --------------------------------- */
/* 必须是**真能解码**的 PNG，不能只凑一个正确的魔数：浏览器侧要断言的正是
   「图片经 Blob URL 交给 <img> 后真的解码出来了」（naturalWidth > 0），
   假 PNG 会让这条断言永远失败，或者更糟 —— 悄悄统计到别处的图片上去。 */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 纯色 RGBA PNG（每行首字节是滤波器类型，这里一律用 0 = None） */
export function makePng(w, h, [r, g, b, a] = [79, 70, 229, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // 位深
  ihdr[9] = 6;      // 颜色类型 6 = RGBA
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) {
    row[1 + x * 4] = r; row[2 + x * 4] = g; row[3 + x * 4] = b; row[4 + x * 4] = a;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const PNG = makePng(8, 8);

/* ============================ fixture A ============================ */
/* EPUB3 + nav。每段脏内容都对应 test-epub.mjs 里的一条断言 */

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF3 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试用书</dc:title>
    <dc:creator>某作者</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;

/** 两级嵌套目录，用来验证 level 能反映深度 */
const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">第一章</a>
    <ol><li><a href="ch1.xhtml#note3">第一章的脚注</a></li></ol>
  </li>
  <li><a href="ch2.xhtml#note3">第二章</a></li>
</ol></nav></body></html>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title>
<style>body{width:800px}</style></head>
<body>
<h1 id="note3">第一章标题</h1>
<p onclick="alert(1)">正文第一段。<script>alert('xss')</script></p>
<p><a href="javascript:alert(1)">危险链接</a>
   <a href="#note3">同文档锚点</a>
   <a href="ch2.xhtml#note3">跨文档锚点</a>
   <a href="missing.xhtml">指向不存在的文档</a>
   <a href="https://example.com/x">外部链接</a></p>
<img src="images/pic.png" onerror="alert(1)" alt="插图"/>
<svg viewBox="0 0 600 800"><image xlink:href="images/pic.png"/></svg>
<div style="background:url(http://tracker.example/x.gif)">追踪像素</div>
<div style="text-align:center">居中</div>
<iframe src="http://evil.example/"></iframe>
<base href="http://evil.example/"/>
<!-- 嵌套绕过之一：删掉内层 <script> 后残余会重新拼成一个可用的标签 -->
<p>嵌套绕过之一：<scr<script>ipt>alert(1)</scr</script>ipt></p>
<!-- 这一条必须是最后一个含 script 的片段：它没有配对的 </script>，若后面还有
     </script>，删配对标签的那条规则会一口把它连同后面内容一起吃掉，就测不出
     「单轮清洗会残留一个可用的 <script src>」了。后面这些不含 script 的
     段落放这里不受影响。 -->
<p>嵌套绕过之二：<scr<script>ipt src="evil.js"></p>
<p id="dup">同文档内重复 id 的第一个</p>
<p id="dup">同文档内重复 id 的第二个</p>
</body></html>`;

/** ch2 也用了 id="note3" —— 跨文档重名（脚注编号每章从 1 重来）的典型场景 */
const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head>
<body>
<h1 id="note3">第二章标题</h1>
<p>第二章的正文，内容明显不同。</p>
</body></html>`;

const OPF2 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>旧格式书</dc:title>
    <dc:creator>老作者</dc:creator>
    <meta name="cover" content="coverimg"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="coverimg" href="images/cover.png" media-type="image/png"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>第一章</text></navLabel>
      <content src="ch1.xhtml"/>
      <navPoint id="n1a" playOrder="2">
        <navLabel><text>小节一</text></navLabel>
        <content src="ch1.xhtml#sub"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`;

const CH1_2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>一</title></head>
<body><h1>旧书第一章</h1><p id="sub">小节内容。</p></body></html>`;

export function fixtureEpub3() {
  return buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(CONTAINER, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(OPF3, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(NAV, 'utf8') },
    { name: 'OEBPS/ch1.xhtml', data: Buffer.from(CH1, 'utf8') },
    { name: 'OEBPS/ch2.xhtml', data: Buffer.from(CH2, 'utf8') },
    { name: 'OEBPS/images/pic.png', data: PNG },
  ]);
}

export function fixtureEpub2() {
  return buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(CONTAINER, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(OPF2, 'utf8') },
    { name: 'OEBPS/toc.ncx', data: Buffer.from(NCX, 'utf8') },
    { name: 'OEBPS/ch1.xhtml', data: Buffer.from(CH1_2, 'utf8') },
    { name: 'OEBPS/images/cover.png', data: PNG },
  ]);
}

/* ========================= 干净的多章书（e2e 用） ========================= */

/**
 * 造一本结构正常的多章 EPUB：两级目录、每章带小标题与足量正文、
 * 每隔几章插一张图。用来在真实浏览器里走完整导入链路。
 *
 * 每章的小标题**故意都叫 `id="note"`** —— 这正是真实电子书的常见写法
 * （脚注/小标题编号每章从头来）。于是第 2 章起必然触发解析器的确定性改名，
 * 目录里「第 N 章的小节」指向的锚点被改写。若这条链路错了，浏览器里表现为
 * 「点第 5 章的小节，跳回第 1 章」—— 不报错、只是跳错地方，
 * 所以必须由真实浏览器断言来守。
 */
export function makeRealisticEpub({ chapters = 12, title = '端到端测试书' } = {}) {
  const entries = [];
  const items = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
  const refs = [];
  const navL1 = [];
  const navSub = [];

  for (let i = 1; i <= chapters; i++) {
    const id = 'ch' + i;
    items.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    refs.push(`<itemref idref="${id}"/>`);
    navL1.push(`<li><a href="${id}.xhtml">第 ${i} 章</a>`);
    navSub.push(`<ol><li><a href="${id}.xhtml#note">第 ${i} 章的小节</a></li></ol></li>`);

    const paras = [];
    for (let p = 1; p <= 6; p++) {
      paras.push(`<p>这是第 ${i} 章的第 ${p} 段正文，用来撑出足够的篇幅，` +
        `好让阅读器滚动与朗读缓冲都有东西可处理。</p>`);
    }
    // 每隔三章插一张图，顺带验证 data-recindex 与 Blob URL 管线
    const img = i % 3 === 0 ? '<img src="images/pic.png" alt="插图"/>' : '';
    entries.push({
      name: `OEBPS/${id}.xhtml`,
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第 ${i} 章</title></head>
<body><h1>第 ${i} 章</h1>${img}
<h2 id="note">第 ${i} 章的小节</h2>
${paras.join('\n')}</body></html>`, 'utf8'),
    });
  }

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>端到端作者</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    ${items.join('\n    ')}
    <item id="pic" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine>${refs.join('')}</spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
${navL1.map((l, i) => l + '\n' + navSub[i]).join('\n')}
</ol></nav></body></html>`;

  entries.unshift(
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(CONTAINER, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav, 'utf8') },
    { name: 'OEBPS/images/pic.png', data: PNG },
  );
  return buildZip(entries);
}
