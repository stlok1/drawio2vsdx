// Model -> .vsdx (Visio 2013+ OPC package) with native shapes.
import JSZip from 'jszip';
import type { Edge, Page, Pt, Vertex } from './model.js';
import { shapeOf } from './model.js';
import { baseFormat, normColor, parseLabel, plainText, type Run } from './richtext.js';
import { measureRuns } from './measure.js';
import { pointAlong, routeEdge } from './route.js';

const DPI = 96; // 1 draw.io px = 1/96 in, so fonts (px) keep their size relative to shapes
const IN = (px: number) => px / DPI;
const r6 = (n: number) => Number(n.toFixed(6));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');

const NS = `xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'`;

function cell(n: string, v: string | number, f?: string, u?: string) {
  const val = typeof v === 'number' ? r6(v) : esc(v);
  return `<Cell N='${n}' V='${val}'${u ? ` U='${u}'` : ''}${f ? ` F='${esc(f)}'` : ''}/>`;
}

// ---------- line / fill helpers ----------
function linePattern(st: Record<string, string>): number {
  if (st.dashed !== '1') return 1;
  const dp = (st.dashPattern ?? '').split(/\s+/).map(Number).filter(Boolean);
  if (dp.length >= 2 && dp[0] <= 3) return 3; // short dash / dotted look
  return 2;                                    // dash
}
function arrow(name: string | undefined, fill: string | undefined): number {
  if (!name || name === 'none') return 0;
  const filled = fill !== '0';
  switch (name) {
    case 'open': case 'openThin': return 1;
    case 'block': case 'classic': case 'classicThin': case 'blockThin': return filled ? 4 : 2;
    case 'diamond': case 'diamondThin': return filled ? 11 : 22;
    case 'oval': return filled ? 10 : 20;
    default: return 4;
  }
}
function arrowSize(px: number | undefined): number {
  const s = px ?? 6;
  return s <= 7 ? 0 : s <= 10 ? 1 : s <= 14 ? 2 : 3;
}

// ---------- text ----------
interface CharRowKey { key: string; run: Run }
function textXml(runs: Run[], horzAlign: number): { sections: string; text: string } {
  const rows: CharRowKey[] = [];
  const idx = (r: Run) => {
    // One Character row per run, in text order. Visio binds each row to a single character range,
    // so reusing a row for two separate runs shifts formatting onto the wrong text.
    rows.push({ key: String(rows.length), run: r });
    return rows.length - 1;
  };
  let body = `<pp IX='0'/>`;
  for (const r of runs) body += `<cp IX='${idx(r)}'/>${esc(r.text.replace(/\n/g, LINE_BREAK))}`;
  const charRows = rows.map(({ run: r }, i) => {
    const style = (r.bold ? 1 : 0) | (r.italic ? 2 : 0) | (r.underline ? 4 : 0);
    // Every row is written complete: rows with IX>0 have no stylesheet row to inherit from, and Visio
    // treats missing cells as 0 (FontScale=0 => zero-width glyphs => runs overlap / lines shift).
    return `<Row IX='${i}'>${cell('Font', r.font)}${cell('Color', r.color)}${cell('Style', style)}${cell('Case', 0)}${cell('Pos', 0)}` +
      `${cell('FontScale', 1)}${cell('Size', IN(r.size), undefined, 'PT')}${cell('DblUnderline', 0)}${cell('Overline', 0)}${cell('Strikethru', 0)}` +
      `${cell('DoubleStrikethrough', 0)}${cell('Letterspace', 0)}${cell('ColorTrans', 0)}${cell('AsianFont', 0)}${cell('ComplexScriptFont', 0)}` +
      `${cell('ComplexScriptSize', -1)}${cell('LangID', 'pl-PL')}</Row>`;
  }).join('');
  const sections =
    `<Section N='Character'>${charRows}</Section>` +
    `<Section N='Paragraph'><Row IX='0'>${cell('HorzAlign', horzAlign)}${cell('SpLine', -1.2)}${cell('SpBefore', 0)}${cell('SpAfter', 0)}${cell('IndFirst', 0)}${cell('IndLeft', 0)}${cell('IndRight', 0)}</Row></Section>`;
  return { sections, text: `<Text>${body}</Text>` };
}

export let LINE_BREAK = '\n';
const HALIGN: Record<string, number> = { left: 0, center: 1, right: 2 };
const VALIGN: Record<string, number> = { top: 0, middle: 1, bottom: 2 };

// ---------- vertices ----------
interface Ctx { pageH: number; nextId: number; warnings: string[] }

function geomRect(): string {
  return `<Section N='Geometry' IX='0'>${cell('NoFill', 0)}${cell('NoLine', 0)}${cell('NoShow', 0)}${cell('NoSnap', 0)}` +
    `<Row T='RelMoveTo' IX='1'>${cell('X', 0)}${cell('Y', 0)}</Row>` +
    `<Row T='RelLineTo' IX='2'>${cell('X', 1)}${cell('Y', 0)}</Row>` +
    `<Row T='RelLineTo' IX='3'>${cell('X', 1)}${cell('Y', 1)}</Row>` +
    `<Row T='RelLineTo' IX='4'>${cell('X', 0)}${cell('Y', 1)}</Row>` +
    `<Row T='RelLineTo' IX='5'>${cell('X', 0)}${cell('Y', 0)}</Row></Section>`;
}
function geomPoly(ix: number, pts: [number, number][], closed: boolean, noFill = false): string {
  // pts are relative (0..1) in Visio orientation (y up)
  let s = `<Section N='Geometry' IX='${ix}'>${cell('NoFill', noFill ? 1 : 0)}${cell('NoLine', 0)}${cell('NoShow', 0)}${cell('NoSnap', 0)}`;
  const all = closed ? [...pts, pts[0]] : pts;
  all.forEach(([x, y], i) => { s += `<Row T='${i ? 'RelLineTo' : 'RelMoveTo'}' IX='${i + 1}'>${cell('X', x)}${cell('Y', y)}</Row>`; });
  return s + `</Section>`;
}
function geomEllipse(W: number, H: number): string {
  return `<Section N='Geometry' IX='0'>${cell('NoFill', 0)}${cell('NoLine', 0)}${cell('NoShow', 0)}${cell('NoSnap', 0)}` +
    `<Row T='Ellipse' IX='1'>${cell('X', W / 2, 'Width*0.5')}${cell('Y', H / 2, 'Height*0.5')}${cell('A', W, 'Width*1')}${cell('B', H / 2, 'Height*0.5')}${cell('C', W / 2, 'Width*0.5')}${cell('D', H, 'Height*1')}</Row></Section>`;
}

/** Rounded rectangle drawn explicitly with arcs (renders the same in every viewer, unlike the Rounding cell). */
function geomRoundRect(W: number, H: number, r: number): string {
  r = Math.min(r, W / 2, H / 2);
  const bow = r * (1 - Math.SQRT1_2);
  const R = r6(r);
  const pts: [string, number, string, number, 'L' | 'A'][] = [
    [`${R}`, r, '0', 0, 'L'],                       // start (bottom edge, left)
    [`Width-${R}`, W - r, '0', 0, 'L'],
    [`Width`, W, `${R}`, r, 'A'],
    [`Width`, W, `Height-${R}`, H - r, 'L'],
    [`Width-${R}`, W - r, `Height`, H, 'A'],
    [`${R}`, r, `Height`, H, 'L'],
    [`0`, 0, `Height-${R}`, H - r, 'A'],
    [`0`, 0, `${R}`, r, 'L'],
    [`${R}`, r, '0', 0, 'A'],
  ];
  let s = `<Section N='Geometry' IX='0'>${cell('NoFill', 0)}${cell('NoLine', 0)}${cell('NoShow', 0)}${cell('NoSnap', 0)}`;
  pts.forEach(([fx, x, fy, y, k], i) => {
    if (i === 0) s += `<Row T='MoveTo' IX='1'>${cell('X', x, fx)}${cell('Y', y, fy)}</Row>`;
    else if (k === 'L') s += `<Row T='LineTo' IX='${i + 1}'>${cell('X', x, fx)}${cell('Y', y, fy)}</Row>`;
    else s += `<Row T='ArcTo' IX='${i + 1}'>${cell('X', x, fx)}${cell('Y', y, fy)}${cell('A', bow)}</Row>`;
  });
  return s + `</Section>`;
}

function vertexXml(v: Vertex, ctx: Ctx): string | null {
  const st = v.style;
  const shape = shapeOf(st);
  const { x, y, w, h } = v.abs;
  if (w <= 0 || h <= 0) return null;
  const W = IN(w), H = IN(h);
  const id = ctx.nextId++;

  const isText = shape === 'text' || st.__shape === 'text';
  const fill = normColor(st.fillColor, isText ? 'none' : '#FFFFFF');
  const stroke = normColor(st.strokeColor, isText ? 'none' : '#000000');
  const swimlane = shape === 'swimlane';
  let fillForSwim = swimlane ? normColor(st.swimlaneFillColor, 'none') : fill;
  if (swimlane && fill !== 'none') fillForSwim = fill;

  let cells = cell('PinX', IN(x + w / 2)) + cell('PinY', IN(ctx.pageH - (y + h / 2))) +
    cell('Width', W) + cell('Height', H) + cell('LocPinX', W / 2, 'Width*0.5') + cell('LocPinY', H / 2, 'Height*0.5') +
    cell('Angle', 0) + cell('FlipX', 0) + cell('FlipY', 0) + cell('ResizeMode', 0);

  const effFill = swimlane ? fillForSwim : fill;
  cells += effFill === 'none'
    ? cell('FillPattern', 0)
    : cell('FillForegnd', effFill) + cell('FillPattern', 1) + cell('FillForegndTrans', 0);
  cells += stroke === 'none'
    ? cell('LinePattern', 0)
    : cell('LineColor', stroke) + cell('LinePattern', linePattern(st)) + cell('LineWeight', IN(Number(st.strokeWidth ?? 1)), undefined, 'PT');
  cells += cell('ShdwPattern', 0);

  let roundR = 0;
  if (st.rounded === '1' && shape === 'rect') {
    const arc = Number(st.arcSize ?? 15);
    const r = st.absoluteArcSize === '1' ? arc / 2 : Math.min(w, h) * arc / 100;
    roundR = IN(r);
  }
  if (st.locked === '1' || st.selectable === '0') cells += cell('LockSelect', 1) + cell('LockMoveX', 1) + cell('LockMoveY', 1) + cell('LockWidth', 1) + cell('LockHeight', 1) + cell('LockDelete', 1);

  // ----- geometry -----
  let geom = '';
  if (shape === 'ellipse') geom = geomEllipse(W, H);
  else if (shape === 'rhombus') geom = geomPoly(0, [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], true);
  else if (shape === 'note') {
    const s = Number(st.size ?? 30);
    const fx = 1 - s / w, fy = 1 - s / h;
    geom = geomPoly(0, [[0, 0], [1, 0], [1, fy], [fx, 1], [0, 1]], true) +
      geomPoly(1, [[fx, 1], [fx, fy], [1, fy]], false, true);
  } else if (swimlane) {
    const ss = Number(st.startSize ?? 23);
    geom = geomRect() + geomPoly(1, [[0, 1 - ss / h], [1, 1 - ss / h]], false, true);
  } else geom = roundR > 0 ? geomRoundRect(W, H, roundR) : geomRect();

  // ----- text -----
  let text = '', textSections = '';
  const runs = parseLabel(v.label, st);
  if (runs.length) {
    const spacing = Number(st.spacing ?? 2);
    const ml = IN(spacing + Number(st.spacingLeft ?? 0));
    const mr = IN(spacing + Number(st.spacingRight ?? 0));
    const mt = IN(spacing + Number(st.spacingTop ?? 0));
    const mb = IN(spacing + Number(st.spacingBottom ?? 0));
    const align = st.align ?? 'center';
    let valign = st.verticalAlign ?? 'middle';
    let txtW = W, txtH = H, txtPinX = W / 2, txtPinY = H / 2;
    let txtWf = 'Width*1', txtHf = 'Height*1', txtPinXf = 'Width*0.5', txtPinYf = 'Height*0.5';

    if (swimlane) {
      const ss = Number(st.startSize ?? 23);
      txtH = IN(ss); txtPinY = H - txtH / 2; valign = 'middle';
      txtHf = `${r6(txtH)}`; txtPinYf = `Height-${r6(txtH / 2)}`;
    }
    const wrap = st.whiteSpace === 'wrap';
    const m = measureRuns(runs);
    if (!wrap) {
      // draw.io doesn't wrap these: give Visio a block wide enough so it doesn't either
      const need = IN(m.w + 2) + ml + mr;
      if (need > txtW) {
        const extra = need - txtW;
        txtW = need; txtWf = `Width+${r6(extra)}`;
        if (align === 'left') { txtPinX += extra / 2; txtPinXf = `Width*0.5+${r6(extra / 2)}`; }
        else if (align === 'right') { txtPinX -= extra / 2; txtPinXf = `Width*0.5-${r6(extra / 2)}`; }
      }
    } else if (IN(m.h) > txtH - mt - mb + 0.01 && m.lines > 1) {
      ctx.warnings.push(`"${plainText(runs).slice(0, 40)}" may overflow its box`);
    }
    cells += cell('TxtPinX', txtPinX, txtPinXf) + cell('TxtPinY', txtPinY, txtPinYf) +
      cell('TxtWidth', txtW, txtWf) + cell('TxtHeight', txtH, txtHf) +
      cell('TxtLocPinX', txtW / 2, 'TxtWidth*0.5') + cell('TxtLocPinY', txtH / 2, 'TxtHeight*0.5') + cell('TxtAngle', 0);
    cells += cell('LeftMargin', ml, undefined, 'PT') + cell('RightMargin', mr, undefined, 'PT') +
      cell('TopMargin', mt, undefined, 'PT') + cell('BottomMargin', mb, undefined, 'PT') +
      cell('VerticalAlign', VALIGN[valign] ?? 1);
    const bg = normColor(st.labelBackgroundColor, 'none');
    if (bg !== 'none') cells += cell('TextBkgnd', bg) + cell('TextBkgndTrans', 0);
    const t = textXml(runs, HALIGN[align] ?? 1);
    textSections = t.sections; text = t.text;
  }

  return `<Shape ID='${id}' NameU='${esc(v.id)}' Name='${esc(v.id)}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>${cells}${textSections}${geom}${text}</Shape>`;
}

// ---------- edges (1-D shapes) ----------
function edgeXml(e: Edge, verts: Map<string, Vertex>, ctx: Ctx): string | null {
  const ptsPx = routeEdge(e, verts);
  if (ptsPx.length < 2) return null;
  const st = e.style;
  const P = ptsPx.map(p => ({ x: IN(p.x), y: IN(ctx.pageH - p.y) })); // inches, y up
  const B = P[0], E = P[P.length - 1];
  const L = Math.hypot(E.x - B.x, E.y - B.y);
  if (L < 1e-6) return null;
  const ang = Math.atan2(E.y - B.y, E.x - B.x);
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  const local = (p: Pt) => { const dx = p.x - B.x, dy = p.y - B.y; return { x: dx * cos - dy * sin, y: dx * sin + dy * cos }; };
  const id = ctx.nextId++;

  const stroke = normColor(st.strokeColor, '#000000');
  let cells = cell('PinX', (B.x + E.x) / 2) + cell('PinY', (B.y + E.y) / 2) + cell('Width', L) + cell('Height', 0) +
    cell('LocPinX', L / 2, 'Width*0.5') + cell('LocPinY', 0, 'Height*0.5') + cell('Angle', ang) +
    cell('FlipX', 0) + cell('FlipY', 0) + cell('ResizeMode', 0) +
    cell('BeginX', B.x) + cell('BeginY', B.y) + cell('EndX', E.x) + cell('EndY', E.y);
  cells += stroke === 'none' ? cell('LinePattern', 0)
    : cell('LineColor', stroke) + cell('LinePattern', linePattern(st)) + cell('LineWeight', IN(Number(st.strokeWidth ?? 1)), undefined, 'PT');
  cells += cell('FillPattern', 0) + cell('ShdwPattern', 0);
  const endArrow = st.endArrow ?? 'classic';
  cells += cell('BeginArrow', arrow(st.startArrow, st.startFill)) + cell('EndArrow', arrow(endArrow, st.endFill)) +
    cell('BeginArrowSize', arrowSize(st.startSize ? Number(st.startSize) : undefined)) +
    cell('EndArrowSize', arrowSize(st.endSize ? Number(st.endSize) : undefined));
  if (st.rounded === '1' && P.length > 2) cells += cell('Rounding', IN(6));

  let geom = `<Section N='Geometry' IX='0'>${cell('NoFill', 1)}${cell('NoLine', 0)}${cell('NoShow', 0)}${cell('NoSnap', 0)}`;
  P.forEach((p, i) => { const l = local(p); geom += `<Row T='${i ? 'LineTo' : 'MoveTo'}' IX='${i + 1}'>${cell('X', l.x)}${cell('Y', l.y)}</Row>`; });
  geom += `</Section>`;

  let text = '', textSections = '';
  const runs = parseLabel(e.label, st);
  if (runs.length) {
    const m = measureRuns(runs);
    const lp = pointAlong(ptsPx, (e.labelOffsetX + 1) / 2);
    const lpx = { x: lp.x + e.labelOffset.x, y: lp.y + e.labelOffset.y };
    const l = local({ x: IN(lpx.x), y: IN(ctx.pageH - lpx.y) });
    const tw = IN(m.w * 1.08 + 6), th = IN(m.h + 2);
    cells += cell('TxtPinX', l.x) + cell('TxtPinY', l.y) + cell('TxtWidth', tw) + cell('TxtHeight', th) +
      cell('TxtLocPinX', tw / 2, 'TxtWidth*0.5') + cell('TxtLocPinY', th / 2, 'TxtHeight*0.5') + cell('TxtAngle', -ang) +
      cell('LeftMargin', IN(1), undefined, 'PT') + cell('RightMargin', IN(1), undefined, 'PT') +
      cell('TopMargin', IN(1), undefined, 'PT') + cell('BottomMargin', IN(1), undefined, 'PT') + cell('VerticalAlign', 1);
    const bg = normColor(st.labelBackgroundColor, 'none');
    if (bg !== 'none') cells += cell('TextBkgnd', bg) + cell('TextBkgndTrans', 0);
    const t = textXml(runs, 1);
    textSections = t.sections; text = t.text;
  }
  return `<Shape ID='${id}' NameU='${esc(e.id)}' Name='${esc(e.id)}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>${cells}${textSections}${geom}${text}</Shape>`;
}

// ---------- package ----------
function pageXml(page: Page, warnings: string[]): string {
  const ctx: Ctx = { pageH: page.height, nextId: 1, warnings };
  const verts = new Map<string, Vertex>();
  for (const c of page.cells) if (c.kind === 'vertex') verts.set(c.id, c);
  const shapes: string[] = [];
  for (const c of page.cells) {
    const xml = c.kind === 'vertex' ? vertexXml(c, ctx) : edgeXml(c, verts, ctx);
    if (xml) shapes.push(xml);
  }
  return `<?xml version='1.0' encoding='utf-8' ?>\n<PageContents ${NS} xml:space='preserve'><Shapes>${shapes.join('')}</Shapes></PageContents>`;
}

function documentXml(): string {
  const colors = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#E6E6E6', '#CDCDCD', '#B3B3B3', '#9A9A9A', '#808080', '#666666', '#4D4D4D', '#333333', '#1A1A1A']
    .map((c, i) => `<ColorEntry IX='${i}' RGB='${c}'/>`).join('');
  const style0 =
    cell('EnableLineProps', 1) + cell('EnableFillProps', 1) + cell('EnableTextProps', 1) + cell('HideForApply', 0) +
    cell('LineWeight', 0.01041666666666667, undefined, 'PT') + cell('LineColor', 0) + cell('LinePattern', 1) + cell('Rounding', 0) +
    cell('EndArrowSize', 2) + cell('BeginArrow', 0) + cell('EndArrow', 0) + cell('LineCap', 0) + cell('BeginArrowSize', 2) +
    cell('LineColorTrans', 0) + cell('CompoundType', 0) +
    cell('FillForegnd', 1) + cell('FillBkgnd', 0) + cell('FillPattern', 1) + cell('ShdwForegnd', 0) + cell('ShdwBkgnd', 1) +
    cell('ShdwPattern', 0) + cell('FillForegndTrans', 0) + cell('FillBkgndTrans', 0) + cell('ShdwForegndTrans', 0) +
    cell('ShdwBkgndTrans', 0) + cell('ShapeShdwType', 0) + cell('ShapeShdwOffsetX', 0) + cell('ShapeShdwOffsetY', 0) +
    cell('ShapeShdwObliqueAngle', 0) + cell('ShapeShdwScaleFactor', 1) + cell('ShapeShdwBlur', 0) + cell('ShapeShdwShow', 0) +
    cell('LeftMargin', 0, undefined, 'PT') + cell('RightMargin', 0, undefined, 'PT') + cell('TopMargin', 0, undefined, 'PT') +
    cell('BottomMargin', 0, undefined, 'PT') + cell('VerticalAlign', 1) + cell('DefaultTabStop', 0.5) +
    cell('TextDirection', 0) + cell('TextBkgndTrans', 0) +
    cell('LockWidth', 0) + cell('LockHeight', 0) + cell('LockMoveX', 0) + cell('LockMoveY', 0) + cell('LockAspect', 0) +
    cell('LockDelete', 0) + cell('LockBegin', 0) + cell('LockEnd', 0) + cell('LockRotate', 0) + cell('LockCrop', 0) +
    cell('LockVtxEdit', 0) + cell('LockTextEdit', 0) + cell('LockFormat', 0) + cell('LockGroup', 0) + cell('LockCalcWH', 0) +
    cell('LockSelect', 0) + cell('LockCustProp', 0) +
    cell('NoObjHandles', 0) + cell('NonPrinting', 0) + cell('NoCtlHandles', 0) + cell('NoAlignBox', 0) + cell('UpdateAlignBox', 0) +
    cell('HideText', 0) + cell('DynFeedback', 0) + cell('GlueType', 0) + cell('WalkPreference', 0) + cell('BegTrigger', 0, 'No Formula') +
    cell('EndTrigger', 0, 'No Formula') + cell('ObjType', 0) + cell('Comment', '') + cell('IsDropSource', 0) + cell('NoLiveDynamics', 0) +
    cell('LocalizeMerge', 0) + cell('NoProofing', 0) + cell('Calendar', 0) + cell('LangID', 'pl-PL') + cell('ShapeKeywords', '') +
    cell('DropOnPageScale', 1) +
    `<Section N='Character'><Row IX='0'>${cell('Font', 'Arial')}${cell('Color', 0)}${cell('Style', 0)}${cell('Case', 0)}${cell('Pos', 0)}${cell('FontScale', 1)}${cell('Size', 0.1666666666666667, undefined, 'PT')}${cell('DblUnderline', 0)}${cell('Overline', 0)}${cell('Strikethru', 0)}${cell('DoubleStrikethrough', 0)}${cell('Letterspace', 0)}${cell('ColorTrans', 0)}${cell('AsianFont', 0)}${cell('ComplexScriptFont', 0)}${cell('ComplexScriptSize', -1)}${cell('LangID', 'pl-PL')}</Row></Section>` +
    `<Section N='Paragraph'><Row IX='0'>${cell('IndFirst', 0)}${cell('IndLeft', 0)}${cell('IndRight', 0)}${cell('SpLine', -1.2)}${cell('SpBefore', 0)}${cell('SpAfter', 0)}${cell('HorzAlign', 1)}${cell('Bullet', 0)}${cell('BulletStr', '')}${cell('BulletFont', 0)}${cell('BulletFontSize', -1)}${cell('TextPosAfterBullet', 0)}${cell('Flags', 0)}</Row></Section>`;
  return `<?xml version='1.0' encoding='utf-8' ?>\n<VisioDocument ${NS} xml:space='preserve'>` +
    `<DocumentSettings TopPage='0' DefaultTextStyle='0' DefaultLineStyle='0' DefaultFillStyle='0' DefaultGuideStyle='0'>` +
    `<GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/>` +
    `<DynamicGridEnabled>1</DynamicGridEnabled><ProtectStyles>0</ProtectStyles><ProtectShapes>0</ProtectShapes>` +
    `<ProtectMasters>0</ProtectMasters><ProtectBkgnds>0</ProtectBkgnds></DocumentSettings>` +
    `<Colors>${colors}</Colors>` +
    `<FaceNames><FaceName NameU='Arial' UnicodeRanges='-536859905 -1073711037 9 0' CharSets='1073742335 -65536' Panose='2 11 6 4 2 2 2 2 2 4' Flags='325'/></FaceNames>` +
    `<StyleSheets><StyleSheet ID='0' NameU='No Style' IsCustomNameU='1' Name='No Style' IsCustomName='1'>${style0}</StyleSheet></StyleSheets>` +
    `<DocumentSheet NameU='TheDoc' IsCustomNameU='1' Name='TheDoc' IsCustomName='1' LineStyle='0' FillStyle='0' TextStyle='0'>` +
    `${cell('OutputFormat', 0)}${cell('LockPreview', 0)}${cell('AddMarkup', 0)}${cell('ViewMarkup', 0)}${cell('DocLockReplace', 0)}${cell('NoCoauth', 0)}${cell('DocLockDuplicatePage', 0)}${cell('PreviewQuality', 0)}${cell('PreviewScope', 0)}${cell('DocLangID', 'pl-PL')}</DocumentSheet>` +
    `</VisioDocument>`;
}

export async function toVsdx(pages: Page[]): Promise<{ data: Buffer; warnings: string[] }> {
  const zip = new JSZip();
  const warnings: string[] = [];
  const ct = [
    `<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/>`,
    `<Default Extension='xml' ContentType='application/xml'/>`,
    `<Override PartName='/visio/document.xml' ContentType='application/vnd.ms-visio.drawing.main+xml'/>`,
    `<Override PartName='/visio/pages/pages.xml' ContentType='application/vnd.ms-visio.pages+xml'/>`,
    `<Override PartName='/visio/windows.xml' ContentType='application/vnd.ms-visio.windows+xml'/>`,
    `<Override PartName='/docProps/core.xml' ContentType='application/vnd.openxmlformats-package.core-properties+xml'/>`,
    `<Override PartName='/docProps/app.xml' ContentType='application/vnd.openxmlformats-officedocument.extended-properties+xml'/>`,
  ];
  let pagesXml = '', pagesRels = '';
  pages.forEach((p, i) => {
    const n = i + 1;
    ct.push(`<Override PartName='/visio/pages/page${n}.xml' ContentType='application/vnd.ms-visio.page+xml'/>`);
    zip.file(`visio/pages/page${n}.xml`, pageXml(p, warnings));
    const W = IN(p.width), H = IN(p.height);
    pagesXml += `<Page ID='${i}' NameU='${esc(p.name)}' Name='${esc(p.name)}' ViewScale='-1' ViewCenterX='${r6(W / 2)}' ViewCenterY='${r6(H / 2)}'>` +
      `<PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>${cell('PageWidth', W)}${cell('PageHeight', H)}${cell('ShdwOffsetX', 0.125)}${cell('ShdwOffsetY', -0.125)}` +
      `${cell('PageScale', 1, undefined, 'IN_F')}${cell('DrawingScale', 1, undefined, 'IN_F')}${cell('DrawingSizeType', 0)}${cell('DrawingScaleType', 0)}` +
      `${cell('InhibitSnap', 0)}${cell('PageLockReplace', 0, undefined, 'BOOL')}${cell('PageLockDuplicate', 0, undefined, 'BOOL')}${cell('UIVisibility', 0)}` +
      `${cell('ShdwType', 0)}${cell('ShdwObliqueAngle', 0)}${cell('ShdwScaleFactor', 1)}${cell('DrawingResizeType', 0)}${cell('PageShapeSplit', 1)}` +
      `${cell('PrintPageOrientation', W > H ? 2 : 1)}</PageSheet><Rel r:id='rId${n}'/></Page>`;
    pagesRels += `<Relationship Id='rId${n}' Type='http://schemas.microsoft.com/visio/2010/relationships/page' Target='page${n}.xml'/>`;
  });

  zip.file('[Content_Types].xml', `<?xml version='1.0' encoding='utf-8' ?>\n<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>${ct.join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version='1.0' encoding='utf-8' ?>\n<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>` +
    `<Relationship Id='rId1' Type='http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties' Target='docProps/core.xml'/>` +
    `<Relationship Id='rId2' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties' Target='docProps/app.xml'/>` +
    `<Relationship Id='rId3' Type='http://schemas.microsoft.com/visio/2010/relationships/document' Target='visio/document.xml'/></Relationships>`);
  zip.file('docProps/core.xml', `<?xml version='1.0' encoding='utf-8' ?>\n<cp:coreProperties xmlns:cp='http://schemas.openxmlformats.org/package/2006/metadata/core-properties' xmlns:dc='http://purl.org/dc/elements/1.1/' xmlns:dcterms='http://purl.org/dc/terms/' xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance'><dc:creator>drawio2vsdx</dc:creator><dcterms:created xsi:type='dcterms:W3CDTF'>${new Date().toISOString()}</dcterms:created></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version='1.0' encoding='utf-8' ?>\n<Properties xmlns='http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'><Application>Microsoft Visio</Application><Template></Template><DocSecurity>0</DocSecurity></Properties>`);
  zip.file('visio/document.xml', documentXml());
  zip.file('visio/_rels/document.xml.rels', `<?xml version='1.0' encoding='utf-8' ?>\n<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>` +
    `<Relationship Id='rId1' Type='http://schemas.microsoft.com/visio/2010/relationships/pages' Target='pages/pages.xml'/>` +
    `<Relationship Id='rId2' Type='http://schemas.microsoft.com/visio/2010/relationships/windows' Target='windows.xml'/></Relationships>`);
  zip.file('visio/pages/pages.xml', `<?xml version='1.0' encoding='utf-8' ?>\n<Pages ${NS} xml:space='preserve'>${pagesXml}</Pages>`);
  zip.file('visio/pages/_rels/pages.xml.rels', `<?xml version='1.0' encoding='utf-8' ?>\n<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>${pagesRels}</Relationships>`);
  zip.file('visio/windows.xml', `<?xml version='1.0' encoding='utf-8' ?>\n<Windows ClientWidth='1600' ClientHeight='900' ${NS} xml:space='preserve'>` +
    `<Window ID='0' WindowType='Drawing' WindowState='1073741824' WindowLeft='-8' WindowTop='-31' WindowWidth='1616' WindowHeight='939' ContainerType='Page' Page='0' ViewScale='-1' ViewCenterX='${r6(IN(pages[0].width) / 2)}' ViewCenterY='${r6(IN(pages[0].height) / 2)}'>` +
    `<ShowRulers>1</ShowRulers><ShowGrid>0</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides><ShowConnectionPoints>1</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/><DynamicGridEnabled>1</DynamicGridEnabled><TabSplitterPos>0.5</TabSplitterPos></Window></Windows>`);

  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { data, warnings };
}
