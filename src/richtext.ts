// draw.io labels (plain or HTML) -> styled text runs.
import type { Style } from './model.js';

export interface RunFmt {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;   // #RRGGBB
  size: number;    // px
  font: string;
}
export interface Run extends RunFmt { text: string }

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", rarr: '→', larr: '←',
  laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…',
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** draw.io font families → fonts that exist in Visio (metric-compatible where possible). */
export function mapFont(family: string | undefined): string {
  const f = (family ?? 'Helvetica').split(',')[0].trim().replace(/['"]/g, '');
  const map: Record<string, string> = {
    helvetica: 'Arial', 'helvetica neue': 'Arial', arial: 'Arial', verdana: 'Verdana',
    'courier new': 'Courier New', courier: 'Courier New', 'times new roman': 'Times New Roman',
    times: 'Times New Roman', georgia: 'Georgia', tahoma: 'Tahoma', 'segoe ui': 'Segoe UI', calibri: 'Calibri',
  };
  return map[f.toLowerCase()] ?? f;
}

export function normColor(c: string | undefined, fallback: string): string {
  if (!c || c === 'default') return fallback;
  if (c === 'none') return 'none';
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return '#' + m[1].split('').map(x => x + x).join('').toUpperCase();
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return '#' + m[1].toUpperCase();
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const named: Record<string, string> = { white: '#FFFFFF', black: '#000000', red: '#FF0000', blue: '#0000FF', gray: '#808080', grey: '#808080' };
  return named[c.toLowerCase()] ?? fallback;
}

export function baseFormat(st: Style): RunFmt {
  const fs = Number(st.fontStyle ?? 0);
  return {
    bold: (fs & 1) !== 0, italic: (fs & 2) !== 0, underline: (fs & 4) !== 0,
    color: normColor(st.fontColor, '#000000'),
    size: Number(st.fontSize ?? 11),
    font: mapFont(st.fontFamily),
  };
}

function applyCss(fmt: RunFmt, css: string): RunFmt {
  const f = { ...fmt };
  for (const decl of css.split(';')) {
    const [k, ...rest] = decl.split(':');
    if (!k || !rest.length) continue;
    const key = k.trim().toLowerCase(), v = rest.join(':').trim();
    if (key === 'color') f.color = normColor(v, f.color);
    else if (key === 'font-size') { const n = parseFloat(v); if (n) f.size = v.endsWith('pt') ? n * 96 / 72 : n; }
    else if (key === 'font-weight') f.bold = v === 'bold' || Number(v) >= 600;
    else if (key === 'font-style') f.italic = v === 'italic' || v === 'oblique';
    else if (key === 'font-family') f.font = mapFont(v);
    else if (key === 'text-decoration') f.underline = v.includes('underline');
  }
  return f;
}

/** Parse a label into runs. Newlines are represented by '\n' inside run text. */
export function parseLabel(label: string, st: Style): Run[] {
  const base = baseFormat(st);
  if (!label) return [];
  const isHtml = st.html === '1';
  if (!isHtml) return [{ ...base, text: label }];

  const runs: Run[] = [];
  const stack: { tag: string; fmt: RunFmt }[] = [{ tag: '#root', fmt: base }];
  const cur = () => stack[stack.length - 1].fmt;
  const push = (text: string) => {
    if (!text) return;
    const f = cur();
    const last = runs[runs.length - 1];
    if (last && sameFmt(last, f)) last.text += text;
    else runs.push({ ...f, text });
  };
  const newline = () => push('\n');

  const re = /<\s*(\/)?\s*([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(label))) {
    if (m[4] !== undefined) {
      // HTML collapses whitespace; draw.io html labels do too.
      push(decodeEntities(m[4].replace(/[ \t\r\n]+/g, ' ')));
      continue;
    }
    const closing = !!m[1], tag = m[2].toLowerCase(), attrs = m[3] ?? '';
    if (tag === 'br') { newline(); continue; }
    const block = tag === 'div' || tag === 'p' || tag === 'li';
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    if (block) {
      const lastText = runs.length ? runs[runs.length - 1].text : '';
      if (lastText && !lastText.endsWith('\n')) newline();
    }
    let f = { ...cur() };
    if (tag === 'b' || tag === 'strong') f.bold = true;
    else if (tag === 'i' || tag === 'em') f.italic = true;
    else if (tag === 'u') f.underline = true;
    const style = /style\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (style) f = applyCss(f, style[1]);
    if (tag === 'font') {
      const color = /color\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
      if (color) f.color = normColor(color[1], f.color);
      const face = /face\s*=\s*["']([^"']+)/i.exec(attrs);
      if (face) f.font = mapFont(face[1]);
    }
    if (!/\/\s*$/.test(attrs)) stack.push({ tag, fmt: f });
  }
  // trim leading/trailing whitespace-only content around lines
  return cleanup(runs);
}

function sameFmt(a: RunFmt, b: RunFmt) {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline &&
    a.color === b.color && a.size === b.size && a.font === b.font;
}

function cleanup(runs: Run[]): Run[] {
  if (!runs.length) return runs;
  // Trim spaces adjacent to newlines and at the ends
  for (let i = 0; i < runs.length; i++) {
    runs[i].text = runs[i].text.replace(/ *\n */g, '\n');
  }
  runs[0].text = runs[0].text.replace(/^\s+/, '');
  const last = runs[runs.length - 1];
  last.text = last.text.replace(/\s+$/, '');
  return runs.filter(r => r.text.length);
}

export function plainText(runs: Run[]) { return runs.map(r => r.text).join(''); }
