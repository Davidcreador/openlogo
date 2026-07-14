import type { FontPairing, FoundryPalette, Motif } from "./types";

export const FONT_PAIRINGS: readonly FontPairing[] = [
  { id: "inter-space-mono", display: { family: "Inter", weight: 800 }, supporting: { family: "Space Mono", weight: 400 }, vibes: ["minimal", "streetwear"] },
  { id: "montserrat-lora", display: { family: "Montserrat", weight: 700 }, supporting: { family: "Lora", weight: 400 }, vibes: ["classic", "elegant"] },
  { id: "poppins-inter", display: { family: "Poppins", weight: 700 }, supporting: { family: "Inter", weight: 500 }, vibes: ["minimal", "playful"] },
  { id: "work-sans-playfair", display: { family: "Work Sans", weight: 700 }, supporting: { family: "Playfair Display", weight: 500, style: "italic" }, vibes: ["minimal", "elegant"] },
  { id: "raleway-lora", display: { family: "Raleway", weight: 800 }, supporting: { family: "Lora", weight: 500 }, vibes: ["classic", "elegant"] },
  { id: "archivo-space-mono", display: { family: "Archivo", weight: 800 }, supporting: { family: "Space Mono", weight: 400 }, vibes: ["streetwear", "retro"] },
  { id: "space-grotesk-inter", display: { family: "Space Grotesk", weight: 700 }, supporting: { family: "Inter", weight: 500 }, vibes: ["minimal", "streetwear"] },
  { id: "oswald-montserrat", display: { family: "Oswald", weight: 700 }, supporting: { family: "Montserrat", weight: 500 }, vibes: ["retro", "streetwear"] },
  { id: "bebas-work-sans", display: { family: "Bebas Neue", weight: 400 }, supporting: { family: "Work Sans", weight: 600 }, vibes: ["retro", "streetwear"] },
  { id: "playfair-montserrat", display: { family: "Playfair Display", weight: 700 }, supporting: { family: "Montserrat", weight: 500 }, vibes: ["classic", "elegant"] },
  { id: "lora-work-sans", display: { family: "Lora", weight: 700 }, supporting: { family: "Work Sans", weight: 500 }, vibes: ["classic", "playful"] },
  { id: "dm-serif-poppins", display: { family: "DM Serif Display", weight: 400 }, supporting: { family: "Poppins", weight: 500 }, vibes: ["retro", "elegant", "playful"] },
] as const;

export const PALETTES: readonly FoundryPalette[] = [
  { id: "ivory-carbon", name: "Ivory Carbon", paper: "#F6F1E7", ink: "#181715", accent: "#80664D", vibes: ["minimal", "classic", "elegant"] },
  { id: "porcelain-navy", name: "Porcelain Navy", paper: "#F7F5EF", ink: "#17243A", accent: "#936B42", vibes: ["minimal", "classic", "elegant"] },
  { id: "cream-oxblood", name: "Cream Oxblood", paper: "#F8EDD4", ink: "#5A2029", accent: "#A8753E", vibes: ["classic", "retro", "elegant"] },
  { id: "parchment-forest", name: "Parchment Forest", paper: "#F1E8D7", ink: "#1D392D", accent: "#936447", vibes: ["classic", "retro", "elegant"] },
  { id: "blush-plum", name: "Blush Plum", paper: "#F4E9EB", ink: "#49213C", accent: "#A45769", vibes: ["elegant", "playful"] },
  { id: "mist-denim", name: "Mist Denim", paper: "#E8EFF0", ink: "#19384C", accent: "#A94F40", vibes: ["minimal", "retro", "playful"] },
  { id: "sand-espresso", name: "Sand Espresso", paper: "#EFE2CF", ink: "#33231C", accent: "#9B5036", vibes: ["classic", "retro", "streetwear"] },
  { id: "ice-slate", name: "Ice Slate", paper: "#EEF1F0", ink: "#222B31", accent: "#4E6B73", vibes: ["minimal", "streetwear"] },
  { id: "butter-brick", name: "Butter Brick", paper: "#F4E4B9", ink: "#2D2822", accent: "#A94335", vibes: ["retro", "streetwear", "playful"] },
  { id: "lilac-aubergine", name: "Lilac Aubergine", paper: "#EEE8F0", ink: "#3F2943", accent: "#825B66", vibes: ["elegant", "playful"] },
  { id: "chalk-cobalt", name: "Chalk Cobalt", paper: "#F1F3F8", ink: "#17233F", accent: "#3D5C9C", vibes: ["minimal", "streetwear", "playful"] },
  { id: "fog-black-red", name: "Fog Black Red", paper: "#ECEBE8", ink: "#191919", accent: "#9D3E34", vibes: ["retro", "streetwear"] },
] as const;

/** Original path data, all authored on a 100 × 100 intrinsic grid. */
export const MOTIFS: readonly Motif[] = [
  { id: "star", name: "Five-point star", d: "M50 4 61 36 95 36 67 56 78 90 50 70 22 90 33 56 5 36 39 36Z", viewBox: { width: 100, height: 100 }, vibes: ["classic", "retro", "streetwear", "playful"] },
  { id: "diamond", name: "Diamond", d: "M50 4 96 50 50 96 4 50Z", viewBox: { width: 100, height: 100 }, vibes: ["minimal", "classic", "elegant"] },
  { id: "shield", name: "Shield", d: "M12 8H88V48C88 72 72 88 50 96 28 88 12 72 12 48Z", viewBox: { width: 100, height: 100 }, vibes: ["classic", "retro", "streetwear"] },
  { id: "spark", name: "Four-point spark", d: "M50 2C54 34 66 46 98 50 66 54 54 66 50 98 46 66 34 54 2 50 34 46 46 34Z", viewBox: { width: 100, height: 100 }, vibes: ["minimal", "elegant", "playful"] },
  { id: "crown", name: "Crown", d: "M10 28 30 48 50 12 70 48 90 28 82 82H18ZM22 88H78V96H22Z", viewBox: { width: 100, height: 100 }, vibes: ["classic", "retro", "elegant"] },
  { id: "burst", name: "Eight-point burst", d: "M50 2 60 30 84 16 70 40 98 50 70 60 84 84 60 70 50 98 40 70 16 84 30 60 2 50 30 40 16 16 40 30Z", viewBox: { width: 100, height: 100 }, vibes: ["retro", "streetwear", "playful"] },
  { id: "leaf", name: "Leaf", d: "M10 86C16 38 45 8 91 10 88 57 58 84 10 86ZM18 78C40 62 58 44 79 20", viewBox: { width: 100, height: 100 }, vibes: ["classic", "elegant", "playful"] },
  { id: "chevrons", name: "Double chevron", d: "M6 20 50 56 94 20V42L50 78 6 42ZM6 58 50 94 94 58V78L50 100 6 78Z", viewBox: { width: 100, height: 100 }, vibes: ["minimal", "streetwear"] },
  { id: "banner", name: "Folded banner", d: "M4 20H24V12H76V20H96L84 42 96 64H76V76H24V64H4L16 42ZM24 24V62H76V24Z", viewBox: { width: 100, height: 100 }, vibes: ["classic", "retro", "playful"] },
  { id: "laurel", name: "Laurel branch", d: "M48 92C34 76 24 58 20 34L26 32C31 55 40 73 54 87ZM20 66C7 62 4 50 7 40 18 44 23 53 20 66ZM27 49C14 43 14 30 19 20 30 26 34 38 27 49ZM36 72C23 70 17 59 19 49 31 52 38 61 36 72ZM22 32C13 24 17 12 25 5 33 14 33 25 22 32Z", viewBox: { width: 100, height: 100 }, vibes: ["classic", "retro", "elegant"] },
] as const;

export function motifById(id: Motif["id"]): Motif {
  const motif = MOTIFS.find((candidate) => candidate.id === id);
  if (!motif) {
    throw new RangeError(`Unknown motif: ${id}`);
  }
  return motif;
}
