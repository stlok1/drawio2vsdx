// Re-creates draw.io edge geometry (orthogonalEdgeStyle / straight) as an explicit polyline.
import type { Edge, Pt, Rect, Vertex } from './model.js';
import { shapeOf } from './model.js';

type Ori = 'h' | 'v';
interface Term { p: Pt; ori: Ori | null; fixed: boolean; v?: Vertex; side?: 'top' | 'bottom' | 'left' | 'right' }

const TOL = 6; // px: draw.io snaps near-aligned segments, so do we

const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;
const within = (v: number, a: number, b: number) => v >= a - 0.01 && v <= b + 0.01;

/** Point on the perimeter of v hit by a vertical (x fixed) or horizontal (y fixed) ray from the side facing `toward`. */
function axisPerimeter(v: Vertex, axis: 'x' | 'y', value: number, toward: Pt): Pt {
  const r = v.abs, s = shapeOf(v.style);
  if (axis === 'x') {
    const down = toward.y > cy(r);
    let dy = r.h / 2;
    const t = (value - cx(r)) / (r.w / 2);
    if (s === 'ellipse') dy = (r.h / 2) * Math.sqrt(Math.max(0, 1 - t * t));
    else if (s === 'rhombus') dy = (r.h / 2) * Math.max(0, 1 - Math.abs(t));
    return { x: value, y: cy(r) + (down ? dy : -dy) };
  } else {
    const right = toward.x > cx(r);
    let dx = r.w / 2;
    const t = (value - cy(r)) / (r.h / 2);
    if (s === 'ellipse') dx = (r.w / 2) * Math.sqrt(Math.max(0, 1 - t * t));
    else if (s === 'rhombus') dx = (r.w / 2) * Math.max(0, 1 - Math.abs(t));
    return { x: cx(r) + (right ? dx : -dx), y: value };
  }
}

function constrained(v: Vertex, fx: number, fy: number, dx: number, dy: number): Term {
  const r = v.abs;
  const p = { x: r.x + fx * r.w + dx, y: r.y + fy * r.h + dy };
  let side: Term['side'];
  if (fy <= 0.001) side = 'top'; else if (fy >= 0.999) side = 'bottom';
  else if (fx <= 0.001) side = 'left'; else if (fx >= 0.999) side = 'right';
  let ori: Ori | null = side ? (side === 'top' || side === 'bottom' ? 'v' : 'h') : null;
  if (!side) ori = Math.abs(fy - 0.5) >= Math.abs(fx - 0.5) ? 'v' : 'h'; // e.g. points on a rhombus facet
  return { p, ori, fixed: true, v, side };
}

/** Unconstrained terminal: choose the side facing `toward` like draw.io's orthogonal connector. */
function floating(v: Vertex, toward: Pt, towardRect?: Rect): Term {
  const r = v.abs;
  // Vertical alignment possible?
  if (towardRect) {
    const ox0 = Math.max(r.x, towardRect.x), ox1 = Math.min(r.x + r.w, towardRect.x + towardRect.w);
    const vertGap = towardRect.y >= r.y + r.h || towardRect.y + towardRect.h <= r.y;
    if (ox1 > ox0 && vertGap) return { p: axisPerimeter(v, 'x', (ox0 + ox1) / 2, toward), ori: 'v', fixed: false, v };
    const oy0 = Math.max(r.y, towardRect.y), oy1 = Math.min(r.y + r.h, towardRect.y + towardRect.h);
    if (oy1 > oy0) return { p: axisPerimeter(v, 'y', (oy0 + oy1) / 2, toward), ori: 'h', fixed: false, v };
  } else {
    if (within(toward.x, r.x, r.x + r.w) && !within(toward.y, r.y, r.y + r.h))
      return { p: axisPerimeter(v, 'x', toward.x, toward), ori: 'v', fixed: false, v };
    if (within(toward.y, r.y, r.y + r.h) && !within(toward.x, r.x, r.x + r.w))
      return { p: axisPerimeter(v, 'y', toward.y, toward), ori: 'h', fixed: false, v };
  }
  const dx = (toward.x - cx(r)) / Math.max(r.w, 1), dy = (toward.y - cy(r)) / Math.max(r.h, 1);
  return Math.abs(dy) >= Math.abs(dx)
    ? { p: axisPerimeter(v, 'x', cx(r), toward), ori: 'v', fixed: false, v }
    : { p: axisPerimeter(v, 'y', cy(r), toward), ori: 'h', fixed: false, v };
}

function terminal(e: Edge, which: 'source' | 'target', verts: Map<string, Vertex>, toward: Pt, towardRect?: Rect): Term {
  const id = which === 'source' ? e.source : e.target;
  const v = id ? verts.get(id) : undefined;
  if (!v) {
    const p = (which === 'source' ? e.sourcePoint : e.targetPoint) ?? toward;
    return { p, ori: null, fixed: true };
  }
  const pre = which === 'source' ? 'exit' : 'entry';
  const fx = e.style[pre + 'X'], fy = e.style[pre + 'Y'];
  if (fx !== undefined && fy !== undefined)
    return constrained(v, Number(fx), Number(fy), Number(e.style[pre + 'Dx'] ?? 0), Number(e.style[pre + 'Dy'] ?? 0));
  return floating(v, toward, towardRect);
}

const perp = (o: Ori): Ori => (o === 'h' ? 'v' : 'h');

/** Slide a terminal point along its side to reach `value` on the given axis, if it stays on the side. */
function slide(t: Term, axis: 'x' | 'y', value: number): boolean {
  if (!t.v) return false;
  const r = t.v.abs;
  if (axis === 'x' && t.ori === 'v' && within(value, r.x, r.x + r.w)) { t.p = { ...t.p, x: value }; return true; }
  if (axis === 'y' && t.ori === 'h' && within(value, r.y, r.y + r.h)) { t.p = { ...t.p, y: value }; return true; }
  return false;
}

export function routeEdge(e: Edge, verts: Map<string, Vertex>): Pt[] {
  const sv = e.source ? verts.get(e.source) : undefined;
  const tv = e.target ? verts.get(e.target) : undefined;
  const wps = dedupe(e.points);
  const firstRef = wps[0] ?? (tv ? { x: cx(tv.abs), y: cy(tv.abs) } : e.targetPoint ?? { x: 0, y: 0 });
  const lastRef = wps[wps.length - 1] ?? (sv ? { x: cx(sv.abs), y: cy(sv.abs) } : e.sourcePoint ?? { x: 0, y: 0 });
  const S = terminal(e, 'source', verts, firstRef, wps.length ? undefined : tv?.abs);
  const T = terminal(e, 'target', verts, lastRef, wps.length ? undefined : sv?.abs);

  const edgeStyle = e.style.edgeStyle ?? '';
  const orth = edgeStyle === 'orthogonalEdgeStyle' || edgeStyle === 'elbowEdgeStyle' || edgeStyle === 'entityRelationEdgeStyle';
  if (!orth) return dedupe([S.p, ...wps, T.p]);

  // Straight-line case with two floating ends that already line up
  if (!wps.length && S.ori && T.ori && S.ori === T.ori) {
    if (S.ori === 'v' && Math.abs(S.p.x - T.p.x) < TOL) { if (!slide(T, 'x', S.p.x)) slide(S, 'x', T.p.x); }
    if (S.ori === 'h' && Math.abs(S.p.y - T.p.y) < TOL) { if (!slide(T, 'y', S.p.y)) slide(S, 'y', T.p.y); }
  }

  const out: Pt[] = [S.p];
  let cur = { ...S.p };
  let ori: Ori = S.ori ?? (Math.abs(firstRef.y - cur.y) >= Math.abs(firstRef.x - cur.x) ? 'v' : 'h');

  for (let i = 0; i <= wps.length; i++) {
    const isT = i === wps.length;
    let q = isT ? T.p : { ...wps[i] };
    // Snap near-aligned points
    if (Math.abs(q.x - cur.x) < TOL && q.x !== cur.x) {
      if (!isT) q.x = cur.x; else if (slide(T, 'x', cur.x)) q = T.p;
    }
    if (Math.abs(q.y - cur.y) < TOL && q.y !== cur.y) {
      if (!isT) q.y = cur.y; else if (slide(T, 'y', cur.y)) q = T.p;
    }
    const aligned = q.x === cur.x || q.y === cur.y;
    if (!isT) {
      if (!aligned) out.push(ori === 'v' ? { x: cur.x, y: q.y } : { x: q.x, y: cur.y });
      const prev = out[out.length - 1];
      const segOri: Ori = prev.x === q.x ? 'v' : 'h';
      out.push(q);
      ori = perp(segOri);
      cur = q;
    } else {
      const want: Ori = T.ori ?? perp(ori);
      if (aligned) {
        out.push(q);
      } else if (ori !== want) {
        out.push(ori === 'v' ? { x: cur.x, y: q.y } : { x: q.x, y: cur.y });
        out.push(q);
      } else if (ori === 'v') {
        const my = (cur.y + q.y) / 2;
        out.push({ x: cur.x, y: my }, { x: q.x, y: my }, q);
      } else {
        const mx = (cur.x + q.x) / 2;
        out.push({ x: mx, y: cur.y }, { x: mx, y: q.y }, q);
      }
    }
  }
  return simplify(dedupe(out));
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.abs(l.x - p.x) > 0.01 || Math.abs(l.y - p.y) > 0.01) out.push(p);
  }
  return out;
}

/** Drop collinear middle points. */
function simplify(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 0.01) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Point at relative position t (0..1) along a polyline. */
export function pointAlong(pts: Pt[], t: number): Pt {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); lens.push(l); total += l; }
  let d = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const k = lens[i] ? d / lens[i] : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
    }
    d -= lens[i];
  }
  return pts[0];
}
