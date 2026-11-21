// SOLMARA — a travel poster for a place that isn't there.
// Zero-dependency Node 22 program. Writes one 1024x1024 PNG to
// $OUTPUT_PATH (default /output/entry.png).
//
// Everything is procedural and deterministic: a seeded PRNG, a hand-rolled
// PNG encoder (zlib deflate + CRC32), a stroke-based vector font for the
// place name, and a painted scene (gradient sky, glowing sun, hazy
// headlands, a lighthouse on a basalt arch, a teal sea with a sun road).
// Two runs produce byte-identical output.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + value noise
// ---------------------------------------------------------------------------
let seed = 20261121 >>> 0;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296);
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const u = smooth(fx);
  const v = smooth(fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------------------------------------------------------------------------
// Canvas: supersampled 2x, downsampled to 1024 for anti-aliasing
// ---------------------------------------------------------------------------
const SS = 2;
const W = 1024 * SS;
const H = 1024 * SS;
const OUT_W = 1024;
const OUT_H = 1024;
const buf = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function setPx(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = clamp255(r);
  buf[i + 1] = clamp255(g);
  buf[i + 2] = clamp255(b);
}
function blendPx(x: number, y: number, c: RGB, a: number): void {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  if (a >= 1) {
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    return;
  }
  buf[i] = buf[i] * (1 - a) + c[0] * a;
  buf[i + 1] = buf[i + 1] * (1 - a) + c[1] * a;
  buf[i + 2] = buf[i + 2] * (1 - a) + c[2] * a;
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function grad(stops: [number, RGB][], t: number): RGB {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

// Soft round-pen stamp (used for strokes, sun disc, glow dots).
function stamp(cx: number, cy: number, r: number, c: RGB, alpha: number): void {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d >= r + 0.7) continue;
      const a = alpha * Math.min(1, Math.max(0, (r + 0.7 - d) / 1.4));
      blendPx(x, y, c, a);
    }
  }
}

// Thick line drawn by stamping the round pen along the segment.
function thickLine(x1: number, y1: number, x2: number, y2: number, w: number, c: RGB, alpha: number): void {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(dist / (w / 4)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stamp(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, w / 2, c, alpha);
  }
}

// Scanline polygon fill (supersampling gives the anti-aliasing).
function fillPolygon(pts: [number, number][], c: RGB, alpha = 1): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const yStart = Math.max(0, Math.ceil(minY));
  const yEnd = Math.min(H - 1, Math.floor(maxY));
  for (let y = yStart; y <= yEnd; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
        xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) blendPx(x, y, c, alpha);
    }
  }
}

// ---------------------------------------------------------------------------
// Scene constants
// ---------------------------------------------------------------------------
const HY = Math.round(H * 0.6); // horizon line (y)
const SUN_X = Math.round(W * 0.7);
const SUN_Y = Math.round(H * 0.335);
const SUN_R = 52;

const SKY_STOPS: [number, RGB][] = [
  [0.0, [43, 66, 102]],
  [0.35, [118, 92, 118]],
  [0.65, [212, 118, 82]],
  [0.9, [243, 168, 92]],
  [1.0, [251, 199, 124]],
];
const SEA_STOPS: [number, RGB][] = [
  [0.0, [238, 172, 96]],
  [0.18, [52, 128, 122]],
  [0.55, [26, 96, 102]],
  [1.0, [12, 52, 64]],
];

// ---------------------------------------------------------------------------
// 1. Sky + sun
// ---------------------------------------------------------------------------
for (let y = 0; y < HY; y++) {
  const t = y / HY;
  const base = grad(SKY_STOPS, t);
  for (let x = 0; x < W; x++) {
    let r = base[0];
    let g = base[1];
    let b = base[2];
    // Sun glow (wide soft falloff).
    const dx = x - SUN_X;
    const dy = y - SUN_Y;
    const d2 = dx * dx + dy * dy;
    const glow = Math.exp(-d2 / (2 * 300 * 300));
    r += 130 * glow;
    g += 95 * glow;
    b += 45 * glow;
    // Thin high cloud wisps, warm pink.
    const cn = vnoise(x * 0.003, y * 0.012 + 3.7);
    if (cn > 0.62) {
      const ca = (cn - 0.62) * 0.85;
      r = r * (1 - ca) + 246 * ca;
      g = g * (1 - ca) + 172 * ca;
      b = b * (1 - ca) + 132 * ca;
    }
    setPx(x, y, r, g, b);
  }
}
// Sun disc.
stamp(SUN_X, SUN_Y, SUN_R, [255, 243, 214], 1);
stamp(SUN_X, SUN_Y, SUN_R * 0.82, [255, 248, 228], 1);

// ---------------------------------------------------------------------------
// 2. Far hazy headlands on the horizon
// ---------------------------------------------------------------------------
function headland(x0: number, x1: number, baseY: number, amp: number, c: RGB, alpha: number): void {
  const pts: [number, number][] = [];
  for (let x = x0; x <= x1; x += 32) {
    const y = baseY - amp * vnoise(x * 0.004, 7.3) - amp * 0.35 * Math.sin(x * 0.006 + 1.2);
    pts.push([x, y]);
  }
  pts.push([x1, HY]);
  pts.push([x0, HY]);
  fillPolygon(pts, c, alpha);
}
headland(0, 900, HY - 26, 46, [104, 78, 100], 0.9); // left, hazy mauve
headland(1420, W, HY - 14, 34, [92, 70, 92], 0.85); // right, hazy mauve

// ---------------------------------------------------------------------------
// 3. Sea: gradient + sun road + shimmer + wave streaks
// ---------------------------------------------------------------------------
for (let y = HY; y < H; y++) {
  const dy = y - HY;
  const t = dy / (H - HY);
  const base = grad(SEA_STOPS, t);
  for (let x = 0; x < W; x++) {
    let r = base[0];
    let g = base[1];
    let b = base[2];
    // Sun road: a glittering column of light under the sun.
    const colW = 60 + dy * 0.22;
    const gx = (x - SUN_X) / colW;
    const road = Math.exp(-gx * gx) * Math.exp(-dy / 720);
    if (road > 0.01) {
      const shimmer = 0.55 + 0.45 * vnoise(x * 0.02, y * 0.06);
      const ra = road * shimmer * 0.85;
      r = r * (1 - ra) + 252 * ra;
      g = g * (1 - ra) + 196 * ra;
      b = b * (1 - ra) + 116 * ra;
    }
    // Horizontal wave streaks.
    const wv = vnoise(x * 0.006, y * 0.12);
    if (wv > 0.68) {
      const wa = (wv - 0.68) * 0.55;
      r = r * (1 - wa) + 250 * wa;
      g = g * (1 - wa) + 210 * wa;
      b = b * (1 - wa) + 160 * wa;
    }
    // Sparkle.
    const sp = vnoise(x * 0.03, y * 0.02);
    if (sp > 0.85) {
      const sa = (sp - 0.85) * 0.7;
      r += 60 * sa;
      g += 45 * sa;
      b += 20 * sa;
    }
    setPx(x, y, r, g, b);
  }
}

// ---------------------------------------------------------------------------
// 4. The landmark: a lighthouse on a basalt arch
// ---------------------------------------------------------------------------
const BASALT: RGB = [42, 46, 51];
const BASALT_DARK: RGB = [26, 29, 34];
const CREAM: RGB = [247, 232, 200];
const CORAL: RGB = [217, 108, 79];
const RIM: RGB = [232, 150, 90];

// Left and right pillars + top slab (the gap between the pillars shows the
// sea behind, so no cutting is needed). Wide flared bases, and the slab's
// underside curves up in the middle, so the opening reads as a true arch.
fillPolygon(
  [
    [790, 1830],
    [820, 1560],
    [850, 1380],
    [895, 1295],
    [960, 1275],
    [978, 1420],
    [968, 1620],
    [945, 1830],
  ],
  BASALT,
);
fillPolygon(
  [
    [1258, 1830],
    [1228, 1560],
    [1198, 1380],
    [1153, 1295],
    [1088, 1275],
    [1070, 1420],
    [1080, 1620],
    [1103, 1830],
  ],
  BASALT,
);
fillPolygon(
  [
    [770, 1360],
    [820, 1260],
    [920, 1220],
    [1024, 1205],
    [1128, 1220],
    [1228, 1260],
    [1278, 1360],
    [1260, 1410],
    [1148, 1390],
    [1024, 1340],
    [900, 1390],
    [788, 1410],
  ],
  BASALT,
);
// Rock shading: darker faces + warm rim light along the tops.
fillPolygon(
  [
    [850, 1380],
    [895, 1295],
    [960, 1275],
    [978, 1420],
    [940, 1440],
    [880, 1400],
  ],
  BASALT_DARK,
  0.55,
);
fillPolygon(
  [
    [1198, 1380],
    [1153, 1295],
    [1088, 1275],
    [1070, 1420],
    [1108, 1440],
    [1168, 1400],
  ],
  BASALT_DARK,
  0.55,
);
// Vertical rock streaks on the pillars.
thickLine(860, 1400, 845, 1700, 10, BASALT_DARK, 0.5);
thickLine(1188, 1400, 1203, 1700, 10, BASALT_DARK, 0.5);
thickLine(920, 1260, 1024, 1205, 7, RIM, 0.55);
thickLine(1024, 1205, 1128, 1260, 7, RIM, 0.55);
thickLine(850, 1380, 895, 1295, 6, RIM, 0.4);
thickLine(1198, 1380, 1153, 1295, 6, RIM, 0.4);
// Small islets beside the arch.
fillPolygon(
  [
    [742, 1810],
    [762, 1760],
    [792, 1770],
    [800, 1810],
  ],
  BASALT_DARK,
);
fillPolygon(
  [
    [1268, 1830],
    [1290, 1785],
    [1322, 1795],
    [1328, 1830],
  ],
  BASALT_DARK,
);

// Lighthouse tower (tapered), standing on the slab.
fillPolygon(
  [
    [979, 1210],
    [1069, 1210],
    [1056, 930],
    [992, 930],
  ],
  CREAM,
);
// Coral bands following the taper.
fillPolygon(
  [
    [983, 1095],
    [1065, 1095],
    [1062, 1052],
    [986, 1052],
  ],
  CORAL,
);
fillPolygon(
  [
    [989, 985],
    [1059, 985],
    [1057, 952],
    [991, 952],
  ],
  CORAL,
);
// Tower shading on the right side.
fillPolygon(
  [
    [1030, 1210],
    [1069, 1210],
    [1056, 930],
    [1038, 930],
  ],
  [214, 196, 158],
  0.5,
);
// Two small windows.
stamp(1012, 1140, 7, [46, 52, 58], 1);
stamp(1012, 1018, 7, [46, 52, 58], 1);
// Gallery + lamp room + dome.
fillPolygon(
  [
    [984, 930],
    [1064, 930],
    [1064, 906],
    [984, 906],
  ],
  [46, 52, 58],
);
fillPolygon(
  [
    [996, 906],
    [1052, 906],
    [1052, 862],
    [996, 862],
  ],
  [38, 44, 50],
);
fillPolygon(
  [
    [1004, 902],
    [1044, 902],
    [1044, 868],
    [1004, 868],
  ],
  [255, 214, 130],
);
stamp(1024, 848, 26, [46, 52, 58], 1); // dome
stamp(1024, 822, 5, [46, 52, 58], 1); // finial
// Lamp glow + two light beams.
stamp(1024, 884, 120, [255, 220, 140], 0.28);
stamp(1024, 884, 60, [255, 228, 160], 0.35);
fillPolygon(
  [
    [1000, 884],
    [300, 830],
    [300, 872],
  ],
  [255, 232, 170],
  0.16,
);
fillPolygon(
  [
    [1048, 884],
    [1750, 836],
    [1750, 878],
  ],
  [255, 232, 170],
  0.16,
);

// ---------------------------------------------------------------------------
// 5. Foreground cliffs framing the bottom corners
// ---------------------------------------------------------------------------
fillPolygon(
  [
    [0, H],
    [0, 1700],
    [120, 1660],
    [300, 1720],
    [430, 1800],
    [380, H],
  ],
  [16, 42, 38],
);
fillPolygon(
  [
    [W, H],
    [W, 1720],
    [1930, 1680],
    [1760, 1740],
    [1640, 1820],
    [1700, H],
  ],
  [16, 42, 38],
);
thickLine(0, 1700, 120, 1660, 6, RIM, 0.5);
thickLine(120, 1660, 300, 1720, 6, RIM, 0.5);
thickLine(W, 1720, 1930, 1680, 6, RIM, 0.5);
thickLine(1930, 1680, 1760, 1740, 6, RIM, 0.5);

// ---------------------------------------------------------------------------
// 6. Birds
// ---------------------------------------------------------------------------
const BIRD: RGB = [38, 38, 58];
function bird(cx: number, cy: number, s: number): void {
  thickLine(cx - 15 * s, cy, cx, cy - 9 * s, 5, BIRD, 0.85);
  thickLine(cx, cy - 9 * s, cx + 15 * s, cy, 5, BIRD, 0.85);
}
bird(500, 500, 1);
bird(620, 452, 0.8);
bird(1520, 560, 0.9);
bird(1640, 500, 0.7);
bird(700, 620, 0.75);

// ---------------------------------------------------------------------------
// 7. The place name: SOLMARA — stroke vector font, cream, with soft shadow
// ---------------------------------------------------------------------------
type Seg =
  | { k: "l"; x1: number; y1: number; x2: number; y2: number }
  | { k: "q"; x1: number; y1: number; cx: number; cy: number; x2: number; y2: number }
  | { k: "e"; cx: number; cy: number; rx: number; ry: number };

// Glyphs on a 7 x 10 grid (y down). One continuous stroke style, bold.
const GLYPHS: Record<string, Seg[]> = {
  S: [
    { k: "q", x1: 5.2, y1: 1.4, cx: 3.2, cy: 0.1, x2: 1.6, y2: 1.2 },
    { k: "q", x1: 1.6, y1: 1.2, cx: 0.5, cy: 2.4, x2: 1.5, y2: 3.8 },
    { k: "q", x1: 1.5, y1: 3.8, cx: 2.4, cy: 5.0, x2: 4.6, y2: 5.0 },
    { k: "q", x1: 4.6, y1: 5.0, cx: 5.7, cy: 5.8, x2: 5.2, y2: 7.4 },
    { k: "q", x1: 5.2, y1: 7.4, cx: 4.8, cy: 9.3, x2: 2.6, y2: 9.4 },
    { k: "q", x1: 2.6, y1: 9.4, cx: 1.1, cy: 9.3, x2: 0.9, y2: 8.2 },
  ],
  O: [{ k: "e", cx: 3.0, cy: 5.0, rx: 2.3, ry: 4.2 }],
  L: [
    { k: "l", x1: 1.2, y1: 0.8, x2: 1.2, y2: 9.2 },
    { k: "l", x1: 1.2, y1: 9.2, x2: 5.2, y2: 9.2 },
  ],
  M: [
    { k: "l", x1: 1.0, y1: 9.2, x2: 1.0, y2: 0.8 },
    { k: "l", x1: 1.0, y1: 0.8, x2: 3.0, y2: 5.6 },
    { k: "l", x1: 3.0, y1: 5.6, x2: 5.0, y2: 0.8 },
    { k: "l", x1: 5.0, y1: 0.8, x2: 5.0, y2: 9.2 },
  ],
  A: [
    { k: "l", x1: 1.0, y1: 9.2, x2: 3.0, y2: 0.8 },
    { k: "l", x1: 3.0, y1: 0.8, x2: 5.0, y2: 9.2 },
    { k: "l", x1: 1.9, y1: 6.2, x2: 4.1, y2: 6.2 },
  ],
  R: [
    { k: "l", x1: 1.2, y1: 9.2, x2: 1.2, y2: 0.8 },
    { k: "l", x1: 1.2, y1: 0.8, x2: 3.8, y2: 0.8 },
    { k: "q", x1: 3.8, y1: 0.8, cx: 5.1, cy: 1.1, x2: 5.0, y2: 2.8 },
    { k: "q", x1: 5.0, y1: 2.8, cx: 4.9, cy: 4.6, x2: 3.6, y2: 4.8 },
    { k: "l", x1: 3.6, y1: 4.8, x2: 1.2, y2: 4.8 },
    { k: "l", x1: 3.4, y1: 4.8, x2: 5.2, y2: 9.2 },
  ],
};

function drawGlyph(ch: string, ox: number, oy: number, unit: number, c: RGB, alpha: number): void {
  const segs = GLYPHS[ch];
  if (!segs) return;
  const w = 1.5 * unit; // stroke width
  for (const s of segs) {
    if (s.k === "l") {
      thickLine(ox + s.x1 * unit, oy + s.y1 * unit, ox + s.x2 * unit, oy + s.y2 * unit, w, c, alpha);
    } else if (s.k === "q") {
      // Sample the quadratic Bezier densely.
      let px = ox + s.x1 * unit;
      let py = oy + s.y1 * unit;
      const steps = 28;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const qx = ox + (mt * mt * s.x1 + 2 * mt * t * s.cx + t * t * s.x2) * unit;
        const qy = oy + (mt * mt * s.y1 + 2 * mt * t * s.cy + t * t * s.y2) * unit;
        thickLine(px, py, qx, qy, w, c, alpha);
        px = qx;
        py = qy;
      }
    } else {
      // Ellipse outline.
      let px = ox + (s.cx + s.rx) * unit;
      let py = oy + s.cy * unit;
      const steps = 72;
      for (let i = 1; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const qx = ox + (s.cx + s.rx * Math.cos(a)) * unit;
        const qy = oy + (s.cy + s.ry * Math.sin(a)) * unit;
        thickLine(px, py, qx, qy, w, c, alpha);
        px = qx;
        py = qy;
      }
    }
  }
}

const NAME = "SOLMARA";
const UNIT = 30; // grid unit in hi-res px (cap height 300 hi-res = 150 final)
const ADVANCE = 7 * UNIT;
const TRACKING = 0.9 * UNIT;
const nameW = NAME.length * ADVANCE + (NAME.length - 1) * TRACKING;
const nameX = Math.round((W - nameW) / 2);
const nameY = 150;
const NAME_CREAM: RGB = [255, 246, 224];

// Soft shadow, then the cream face.
for (let i = 0; i < NAME.length; i++) {
  drawGlyph(NAME[i], nameX + i * (ADVANCE + TRACKING) + 8, nameY + 10, UNIT, [28, 20, 30], 0.35);
}
for (let i = 0; i < NAME.length; i++) {
  drawGlyph(NAME[i], nameX + i * (ADVANCE + TRACKING), nameY, UNIT, NAME_CREAM, 1);
}
// Thin rule under the name.
fillPolygon(
  [
    [nameX - 20, 502],
    [nameX + nameW + 20, 502],
    [nameX + nameW + 20, 508],
    [nameX - 20, 508],
  ],
  NAME_CREAM,
  0.85,
);

// ---------------------------------------------------------------------------
// 8. Grain + vignette, then downsample 2x -> 1024
// ---------------------------------------------------------------------------
for (let y = 0; y < H; y++) {
  const dy = y / H - 0.5;
  for (let x = 0; x < W; x++) {
    const dx = x / W - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy) / 0.7071;
    const vig = 1 - 0.16 * Math.pow(d, 2.4);
    const g = (rnd() - 0.5) * 4;
    const i = (y * W + x) * 3;
    buf[i] = clamp255((buf[i] + g) * vig);
    buf[i + 1] = clamp255((buf[i + 1] + g) * vig);
    buf[i + 2] = clamp255((buf[i + 2] + g) * vig);
  }
}

const out = new Uint8Array(OUT_W * OUT_H * 3);
for (let y = 0; y < OUT_H; y++) {
  for (let x = 0; x < OUT_W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 3;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
      }
    }
    const o = (y * OUT_W + x) * 3;
    // Quantize to even values: halves per-channel entropy, invisible at
    // poster scale, and keeps the file under the 1 MiB gate. Clamp to 254:
    // rounding 255 up to 256 would wrap to 0 in the Uint8Array.
    out[o] = Math.min(254, Math.round(r / (SS * SS) / 2) * 2);
    out[o + 1] = Math.min(254, Math.round(g / (SS * SS) / 2) * 2);
    out[o + 2] = Math.min(254, Math.round(b / (SS * SS) / 2) * 2);
  }
}

// ---------------------------------------------------------------------------
// 9. PNG encoder: IHDR + IDAT (zlib deflate) + IEND, CRC32
// ---------------------------------------------------------------------------
const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc(OUT_H * (1 + OUT_W * 3));
const rowBytes = OUT_W * 3;
// Per-row filter choice (None / Sub / Up) by the standard
// minimum-sum-of-absolute-residuals heuristic.
for (let y = 0; y < OUT_H; y++) {
  const row = Buffer.from(out.buffer, y * rowBytes, rowBytes);
  const prev = y > 0 ? Buffer.from(out.buffer, (y - 1) * rowBytes, rowBytes) : null;
  let bestFilter = 0;
  let bestScore = Infinity;
  for (let f = 0; f <= 2; f++) {
    let score = 0;
    for (let i = 0; i < rowBytes; i++) {
      let v: number;
      if (f === 0) v = row[i];
      else if (f === 1) v = row[i] - (i >= 3 ? row[i - 3] : 0);
      else v = row[i] - (prev ? prev[i] : 0);
      const s = ((v + 128) & 0xff) - 128; // signed byte
      score += s < 0 ? -s : s;
    }
    if (score < bestScore) {
      bestScore = score;
      bestFilter = f;
    }
  }
  const dst = y * (1 + rowBytes);
  raw[dst] = bestFilter;
  for (let i = 0; i < rowBytes; i++) {
    let v: number;
    if (bestFilter === 0) v = row[i];
    else if (bestFilter === 1) v = row[i] - (i >= 3 ? row[i - 3] : 0);
    else v = row[i] - (prev ? prev[i] : 0);
    raw[dst + 1 + i] = v & 0xff;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT_W, 0);
ihdr.writeUInt32BE(OUT_H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", ihdr),
  pngChunk("IDAT", deflateSync(raw, { level: 9 })),
  pngChunk("IEND", Buffer.alloc(0)),
]);

const outPath = process.env.OUTPUT_PATH || "/output/entry.png";
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`wrote ${outPath} ${OUT_W}x${OUT_H} ${png.length} bytes`);
