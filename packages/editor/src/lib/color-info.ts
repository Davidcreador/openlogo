/**
 * Read-only print-awareness helpers for the swatch/fill popover: CMYK
 * conversion, nearest spot-colour reference, and an out-of-print-gamut
 * hint. Display only — nothing here touches the colour pipeline, which
 * stays sRGB hex end to end.
 *
 * The spot references are a small bundled LUT of community-published
 * sRGB approximations under generic "PMS-approx" naming (no licensed
 * Pantone data ships with the app). Matching is ΔE76 in CIELAB.
 */

export type Rgb = { r: number; g: number; b: number };
export type Cmyk = { c: number; m: number; y: number; k: number };

const HEX = /^#([0-9a-f]{6})$/i;

function hexToRgb(hex: string): Rgb | null {
  const match = HEX.exec(hex.trim());
  if (!match) {
    return null;
  }
  const value = parseInt(match[1]!, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** Naive device conversion (no ICC profile) — the standard formula. */
function rgbToCmyk(rgb: Rgb): Cmyk {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) {
    return { c: 0, m: 0, y: 0, k: 1 };
  }
  return {
    c: (1 - r - k) / (1 - k),
    m: (1 - g - k) / (1 - k),
    y: (1 - b - k) / (1 - k),
    k,
  };
}

function cmykLabel(cmyk: Cmyk): string {
  const pct = (v: number) => Math.round(v * 100);
  return `C${pct(cmyk.c)} M${pct(cmyk.m)} Y${pct(cmyk.y)} K${pct(cmyk.k)}`;
}

/* ---------------- Lab distance ---------------- */

type Lab = { l: number; a: number; b: number };

function rgbToLab({ r, g, b }: Rgb): Lab {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  // sRGB D65 → XYZ, normalized to the white point.
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;
  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : t * 7.787 + 16 / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}

/* ---------------- PMS-approx reference LUT ---------------- */

/**
 * Generic spot-colour references: [code, sRGB approximation]. These hex
 * values are the widely published screen approximations that circulate
 * in brand guidelines — bundled as plain constants, no licensed library.
 */
const PMS_APPROX: Array<[string, string]> = [
  ["Yellow", "#fedd00"],
  ["100", "#f6eb61"],
  ["106", "#f9e547"],
  ["109", "#ffd100"],
  ["116", "#ffcd00"],
  ["123", "#ffc72c"],
  ["1235", "#ffb81c"],
  ["130", "#f2a900"],
  ["137", "#ffa300"],
  ["1375", "#ff9e1b"],
  ["144", "#ed8b00"],
  ["1505", "#ff6900"],
  ["Orange 021", "#fe5000"],
  ["152", "#e57200"],
  ["158", "#e87722"],
  ["165", "#ff671f"],
  ["1655", "#fc4c02"],
  ["172", "#fa4616"],
  ["Warm Red", "#f9423a"],
  ["179", "#e03c31"],
  ["1788", "#ee2737"],
  ["Red 032", "#ef3340"],
  ["485", "#da291c"],
  ["1795", "#d22630"],
  ["185", "#e4002b"],
  ["186", "#c8102e"],
  ["187", "#a6192e"],
  ["1807", "#a4343a"],
  ["202", "#862633"],
  ["199", "#d50032"],
  ["208", "#861f41"],
  ["Rubine Red", "#ce0058"],
  ["219", "#da1884"],
  ["226", "#d0006f"],
  ["Rhodamine Red", "#e10098"],
  ["241", "#af1685"],
  ["Purple", "#bb29bb"],
  ["258", "#8c4799"],
  ["266", "#753bbd"],
  ["Violet", "#440099"],
  ["2685", "#330072"],
  ["273", "#24135f"],
  ["Blue 072", "#10069f"],
  ["Reflex Blue", "#001489"],
  ["280", "#012169"],
  ["286", "#0032a0"],
  ["293", "#003da5"],
  ["285", "#0072ce"],
  ["300", "#005eb8"],
  ["Process Blue", "#0085ca"],
  ["299", "#00a3e0"],
  ["306", "#00b5e2"],
  ["3125", "#00aec7"],
  ["320", "#009ca6"],
  ["3272", "#00a499"],
  ["326", "#00b2a9"],
  ["Green", "#00ab84"],
  ["339", "#00b274"],
  ["347", "#009a44"],
  ["348", "#00843d"],
  ["355", "#009639"],
  ["356", "#007a33"],
  ["361", "#43b02a"],
  ["368", "#78be20"],
  ["375", "#97d700"],
  ["376", "#84bd00"],
  ["382", "#c4d600"],
  ["390", "#b5bd00"],
  ["476", "#4e3629"],
  ["4695", "#63513d"],
  ["871 (gold)", "#84754e"],
  ["877 (silver)", "#8a8d8f"],
  ["Cool Gray 1", "#d9d9d6"],
  ["Cool Gray 4", "#bbbcbc"],
  ["Cool Gray 7", "#97999b"],
  ["Cool Gray 9", "#75787b"],
  ["Cool Gray 11", "#53565a"],
  ["419", "#212322"],
  ["Black", "#2d2926"],
  ["Black 6", "#101820"],
];

export type SpotReference = {
  /** Generic reference name, e.g. "PMS-approx 186". */
  name: string;
  hex: string;
  /** ΔE76 distance; ≲2 indistinguishable, ≳10 clearly different. */
  deltaE: number;
};

const lut: Array<{ name: string; hex: string; lab: Lab }> = PMS_APPROX.map(
  ([code, hex]) => ({
    name: `PMS-approx ${code}`,
    hex,
    lab: rgbToLab(hexToRgb(hex)!),
  }),
);

function nearestSpotReference(hex: string): SpotReference | null {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return null;
  }
  const lab = rgbToLab(rgb);
  let best: SpotReference | null = null;
  for (const entry of lut) {
    const deltaE = deltaE76(lab, entry.lab);
    if (!best || deltaE < best.deltaE) {
      best = { name: entry.name, hex: entry.hex, deltaE };
    }
  }
  return best;
}

/**
 * Print-gamut hint, heuristic on purpose (a real check needs ICC
 * profiles): vivid saturated colours — especially bright blues/violets
 * and neon-bright anything — sit outside typical coated-CMYK gamuts and
 * print duller than they preview. Returns a short warning or null.
 */
function printGamutHint(hex: string): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return null;
  }
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const s = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    if (max === r) {
      h = (60 * (g - b)) / (max - min) + (g < b ? 360 : 0);
    } else if (max === g) {
      h = (60 * (b - r)) / (max - min) + 120;
    } else {
      h = (60 * (r - g)) / (max - min) + 240;
    }
  }
  const vividBlueViolet = h >= 210 && h <= 300 && s >= 0.7 && max >= 0.6;
  const neonBright = s >= 0.85 && max >= 0.85;
  return vividBlueViolet || neonBright
    ? "Outside typical CMYK gamut — expect a duller print match"
    : null;
}

export type ColorInfo = {
  cmyk: Cmyk;
  cmykLabel: string;
  spot: SpotReference | null;
  gamutHint: string | null;
};

export function colorInfo(hex: string): ColorInfo | null {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return null;
  }
  const cmyk = rgbToCmyk(rgb);
  return {
    cmyk,
    cmykLabel: cmykLabel(cmyk),
    spot: nearestSpotReference(hex),
    gamutHint: printGamutHint(hex),
  };
}
