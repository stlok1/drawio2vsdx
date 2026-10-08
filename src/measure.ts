// Text measurement with metric-compatible fonts (Liberation Sans ≈ Arial ≈ Helvetica).
import opentype from 'opentype.js';
import { existsSync, readFileSync } from 'node:fs';
import type { Run } from './richtext.js';

const DIRS = ['/usr/share/fonts/truetype/liberation', '/usr/share/fonts/liberation', 'C:/Windows/Fonts', '/Library/Fonts', '/System/Library/Fonts/Supplemental'];
const FILES: Record<string, string[]> = {
  regular: ['LiberationSans-Regular.ttf', 'arial.ttf', 'Arial.ttf'],
  bold: ['LiberationSans-Bold.ttf', 'arialbd.ttf', 'Arial Bold.ttf'],
  italic: ['LiberationSans-Italic.ttf', 'ariali.ttf', 'Arial Italic.ttf'],
  bolditalic: ['LiberationSans-BoldItalic.ttf', 'arialbi.ttf', 'Arial Bold Italic.ttf'],
};
const cache = new Map<string, opentype.Font | null>();
function load(variant: string): opentype.Font | null {
  if (cache.has(variant)) return cache.get(variant)!;
  let font: opentype.Font | null = null;
  outer: for (const d of DIRS) for (const f of FILES[variant]) {
    const p = `${d}/${f}`;
    if (existsSync(p)) { font = opentype.parse(readFileSync(p).buffer as ArrayBuffer); break outer; }
  }
  cache.set(variant, font);
  return font;
}

/** Width in px of one run of text. Falls back to an average-width estimate if no font file is found. */
export function runWidth(r: Run, text = r.text): number {
  const v = r.bold && r.italic ? 'bolditalic' : r.bold ? 'bold' : r.italic ? 'italic' : 'regular';
  const f = load(v);
  if (!f) return text.length * r.size * (r.bold ? 0.58 : 0.52);
  return f.getAdvanceWidth(text, r.size);
}

/** Size of a block of runs (no wrapping): max line width and total height. */
export function measureRuns(runs: Run[], lineHeight = 1.2): { w: number; h: number; lines: number } {
  const lines: { w: number; size: number }[] = [{ w: 0, size: 0 }];
  for (const r of runs) {
    const parts = r.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push({ w: 0, size: 0 });
      const l = lines[lines.length - 1];
      l.w += runWidth(r, part);
      l.size = Math.max(l.size, r.size);
    });
  }
  for (const l of lines) if (!l.size) l.size = runs[0]?.size ?? 11;
  return { w: Math.max(...lines.map(l => l.w)), h: lines.reduce((s, l) => s + l.size * lineHeight, 0), lines: lines.length };
}
