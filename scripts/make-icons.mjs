/**
 * scripts/make-icons.mjs —— 由 assets/icon.svg 的几何生成 PNG 图标
 * -------------------------------------------------------------
 * 运行：node scripts/make-icons.mjs
 *
 * 为什么需要 PNG：PWA 的安装性判定（进而 share_target 能否注册）要求
 * 192/512 的位图图标。只给 SVG 时部分 Chrome 版本会判定不达标，而失败
 * 是**静默的** —— 应用不出现在系统分享面板里，页面侧没有任何报错可查。
 *
 * 这里不引第三方光栅化库（项目要求零依赖），而是照着 icon.svg 里的坐标
 * 把同样几个形状重画一遍：圆角矩形 + 左右两页 + 中缝 + 四条文字线。
 * 形状变了的话，改下面的 SHAPES 即可。生成结果已入库，本脚本平时不用跑。
 */
import { writeFileSync } from 'fs';
import zlib from 'node:zlib';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------- 形状判定 ------------------------------- */

/** 点是否落在圆角矩形内（圆角部分按到圆心的距离判） */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (x >= x0 + r && x <= x1 - r) return true;
  if (y >= y0 + r && y <= y1 - r) return true;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 点到线段的距离（<线宽/2 即算命中，线帽是圆的） */
function distToSeg(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/* 按 icon.svg 的绘制顺序叠放（后面的盖在前面上），坐标系同 viewBox 0 0 128 128 */
const INDIGO = [0x4f, 0x46, 0xe5];
const LIGHT = [0xa5, 0xb4, 0xfc];
const WHITE = [0xff, 0xff, 0xff];

const SHAPES = [
  { color: INDIGO, hit: (x, y) => inRoundRect(x, y, 8, 8, 120, 120, 24) },
  // 书：左右两页（原图是一整条带贝塞尔曲线的路径，这里用圆角矩形近似）
  { color: WHITE, hit: (x, y) => inRoundRect(x, y, 36, 34, 64, 93, 3) },
  { color: WHITE, hit: (x, y) => inRoundRect(x, y, 64, 34, 92, 93, 3) },
  { color: INDIGO, hit: (x, y) => distToSeg(x, y, 64, 37, 64, 93) <= 1.5 },
  { color: INDIGO, hit: (x, y) => distToSeg(x, y, 44, 50, 56, 50) <= 2 },
  { color: INDIGO, hit: (x, y) => distToSeg(x, y, 44, 62, 56, 62) <= 2 },
  { color: LIGHT, hit: (x, y) => distToSeg(x, y, 72, 50, 84, 50) <= 2 },
  { color: LIGHT, hit: (x, y) => distToSeg(x, y, 72, 62, 84, 62) <= 2 },
];

/* ------------------------------- 光栅化 ------------------------------- */

const SS = 4;   // 每个像素取 SS×SS 个子样本求覆盖率，得到抗锯齿边缘

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 128 / size;

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0;          // 从一开始就是全透明
      for (const shape of SHAPES) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = (pxi + (sx + 0.5) / SS) * scale;
            const y = (py + (sy + 0.5) / SS) * scale;
            if (shape.hit(x, y)) hits++;
          }
        }
        if (!hits) continue;
        const a = hits / (SS * SS);      // 覆盖率 → 与已有颜色做 alpha 混合
        r = shape.color[0] * a + r * (1 - a);
        g = shape.color[1] * a + g * (1 - a);
        b = shape.color[2] * a + b * (1 - a);
      }
      const i = (py * size + pxi) * 4;
      px[i] = Math.round(r); px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b); px[i + 3] = 255;
    }
  }
  return px;
}

/* ------------------------------ PNG 封装 ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // 位深
  ihdr[9] = 6;      // 颜色类型 6 = RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 压缩/滤波/隔行

  // 每行前面加一个滤波类型字节（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const out = join(root, 'assets', `icon-${size}.png`);
  writeFileSync(out, encodePng(size, render(size)));
  console.log(`已生成 assets/icon-${size}.png`);
}
