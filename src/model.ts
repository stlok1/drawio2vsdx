// Parsing .drawio (mxfile) into a flat, absolute-coordinate model.
import { DOMParser } from '@xmldom/xmldom';
import * as pako from 'pako';

export type Style = Record<string, string>;

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export interface Vertex {
  kind: 'vertex';
  id: string;
  label: string;
  style: Style;
  abs: Rect;            // absolute page coords (px, y down)
  parentId: string;
}

export interface Edge {
  kind: 'edge';
  id: string;
  label: string;
  style: Style;
  source?: string;
  target?: string;
  points: Pt[];         // absolute waypoints
  sourcePoint?: Pt;     // absolute, for dangling ends
  targetPoint?: Pt;
  labelOffsetX: number; // relative position along the edge, -1..1
  labelOffset: Pt;      // absolute offset in px
}

export interface Page {
  name: string;
  width: number;
  height: number;
  background?: string;
  cells: (Vertex | Edge)[]; // z-order
}

export function parseStyle(s: string | null): Style {
  const out: Style = {};
  if (!s) return out;
  for (const part of s.split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) out['__shape'] = out['__shape'] ?? part; // e.g. "text", "ellipse", "rhombus", "swimlane"
    else out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Shape name as draw.io sees it: explicit shape=..., or the leading style token. */
export function shapeOf(st: Style): string {
  return st.shape ?? st.__shape ?? 'rect';
}

function decompress(text: string): string {
  const bin = Buffer.from(text.trim(), 'base64');
  const inflated = new TextDecoder().decode(pako.inflateRaw(bin));
  return decodeURIComponent(inflated);
}

const num = (v: string | null | undefined, d = 0) => (v == null || v === '' ? d : Number(v));

export function parseMxfile(xml: string): Page[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const diagrams = Array.from(doc.getElementsByTagName('diagram'));
  const pages: Page[] = [];

  for (const d of diagrams) {
    let model = (d as any).getElementsByTagName('mxGraphModel')[0] as Element | undefined;
    if (!model) {
      const inner = decompress(d.textContent ?? '');
      model = new DOMParser().parseFromString(inner, 'text/xml').documentElement as unknown as Element;
    }
    pages.push(parseModel(d.getAttribute('name') ?? 'Page', model));
  }
  return pages;
}

function parseModel(name: string, model: Element): Page {
  const root = model.getElementsByTagName('root')[0];
  // Cells may be plain <mxCell> or wrapped in <UserObject>/<object label=...>
  type Raw = { id: string; parent: string; value: string; style: Style; vertex: boolean; edge: boolean;
    source?: string; target?: string; geo?: Element };
  const raws: Raw[] = [];
  for (const node of Array.from(root.childNodes) as Element[]) {
    if (node.nodeType !== 1) continue;
    let cell = node;
    let value: string | null = node.getAttribute('value');
    let id = node.getAttribute('id');
    if (node.tagName !== 'mxCell') {
      cell = node.getElementsByTagName('mxCell')[0];
      value = node.getAttribute('label');
      id = node.getAttribute('id');
    }
    if (!cell) continue;
    const geo = Array.from(cell.childNodes).find((c: any) => c.nodeType === 1 && c.tagName === 'mxGeometry') as Element | undefined;
    raws.push({
      id: id ?? '', parent: cell.getAttribute('parent') ?? '', value: value ?? '',
      style: parseStyle(cell.getAttribute('style')),
      vertex: cell.getAttribute('vertex') === '1', edge: cell.getAttribute('edge') === '1',
      source: cell.getAttribute('source') ?? undefined, target: cell.getAttribute('target') ?? undefined, geo,
    });
  }

  const byId = new Map(raws.map(r => [r.id, r]));
  // Absolute origin of a parent (vertices are relative to their parent vertex; layers are at 0,0)
  const originCache = new Map<string, Pt>();
  const originOf = (id: string): Pt => {
    if (originCache.has(id)) return originCache.get(id)!;
    const r = byId.get(id);
    let o: Pt = { x: 0, y: 0 };
    if (r && r.vertex && r.geo) {
      const p = originOf(r.parent);
      o = { x: p.x + num(r.geo.getAttribute('x')), y: p.y + num(r.geo.getAttribute('y')) };
    }
    originCache.set(id, o);
    return o;
  };

  const cells: (Vertex | Edge)[] = [];
  for (const r of raws) {
    if (!r.geo) continue;
    if (r.vertex) {
      const o = originOf(r.id);
      cells.push({ kind: 'vertex', id: r.id, label: r.value, style: r.style, parentId: r.parent,
        abs: { x: o.x, y: o.y, w: num(r.geo.getAttribute('width')), h: num(r.geo.getAttribute('height')) } });
    } else if (r.edge) {
      const po = originOf(r.parent);
      const pts: Pt[] = [];
      let sp: Pt | undefined, tp: Pt | undefined, off: Pt = { x: 0, y: 0 };
      for (const c of Array.from(r.geo.childNodes) as Element[]) {
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'Array') {
          for (const p of Array.from(c.getElementsByTagName('mxPoint')))
            pts.push({ x: po.x + num(p.getAttribute('x')), y: po.y + num(p.getAttribute('y')) });
        } else if (c.tagName === 'mxPoint') {
          const p = { x: po.x + num(c.getAttribute('x')), y: po.y + num(c.getAttribute('y')) };
          const as = c.getAttribute('as');
          if (as === 'sourcePoint') sp = p; else if (as === 'targetPoint') tp = p;
          else if (as === 'offset') off = { x: num(c.getAttribute('x')), y: num(c.getAttribute('y')) };
        }
      }
      cells.push({ kind: 'edge', id: r.id, label: r.value, style: r.style, source: r.source, target: r.target,
        points: pts, sourcePoint: sp, targetPoint: tp,
        labelOffsetX: num(r.geo.getAttribute('x')), labelOffset: off });
    }
  }
  return {
    name,
    width: num(model.getAttribute('pageWidth'), 850),
    height: num(model.getAttribute('pageHeight'), 1100),
    background: model.getAttribute('background') ?? undefined,
    cells,
  };
}
