#!/usr/bin/env node
// Usage: drawio2vsdx <input.drawio> [-o output.vsdx] [--split]
//   --split  write one .vsdx per draw.io page instead of one multi-page file
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseMxfile } from './model.js';
import { toVsdx } from './vsdx.js';

async function main() {
  const args = process.argv.slice(2);
  const input = args.find(a => !a.startsWith('-') && args[args.indexOf(a) - 1] !== '-o');
  if (!input) { console.error('usage: drawio2vsdx <input.drawio> [-o out.vsdx] [--split]'); process.exit(1); }
  const oi = args.indexOf('-o');
  const out = oi >= 0 ? args[oi + 1] : join(dirname(input), basename(input, extname(input)) + '.vsdx');
  const pages = parseMxfile(readFileSync(input, 'utf8'));

  const jobs = args.includes('--split')
    ? pages.map((p, i) => ({ pages: [p], file: out.replace(/\.vsdx$/i, `-${String(i + 1).padStart(2, '0')}.vsdx`) }))
    : [{ pages, file: out }];
  for (const j of jobs) {
    const { data, warnings } = await toVsdx(j.pages);
    writeFileSync(j.file, data);
    console.log(`${j.file}  (${j.pages.length} page${j.pages.length > 1 ? 's' : ''})`);
    for (const w of warnings) console.warn('  warn:', w);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
