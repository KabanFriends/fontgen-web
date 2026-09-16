// Port of ShapeDescGenerator.java — traces a pixel-art glyph's opaque-pixel outline
// into msdfgen `-shapedesc` contour text (bottom-left origin, unit-square edges netted
// into CCW loops, outer loops CCW and holes CW, edges color-cycled m/y/c so adjacent
// right-angle edges share one MSDF channel).
//
// Deliberate divergence from the Java original: the JVM stores its intermediate maps in
// java.util.HashMap, whose iteration order leaks into the contour walk (which vertex
// starts a loop, and how edges pair up where pixels touch diagonally). We iterate plain
// Maps in insertion order instead, which is deterministic but not necessarily the JVM's
// order. Consequences, by design:
//   - Loop geometry and orientation are unaffected (they come from the edge netting).
//   - Each loop is rotated to its lexicographically smallest vertex before emission
//     (same as Java), so the m/y/c color cycle alignment usually matches anyway.
//   - Where they don't match, MSDF channels get cyclically rotated — and the Bedrock
//     client samples MTSDF as the MEDIAN of the three channels, which is invariant
//     under channel rotation. So these differences are invisible in-game.

import type { RgbaImage } from './png.js';

const ALPHA_THRESHOLD = 25;
const COLOR_CYCLE = ['m', 'y', 'c'];

interface Pt {
    readonly x: number;
    readonly y: number;
}

function makePt(x: number, y: number): Pt {
    return { x, y };
}

function ptEq(a: Pt, b: Pt): boolean {
    return a.x === b.x && a.y === b.y;
}

/** Lexicographic comparison, matching ShapeDescGenerator.comparePt. */
function comparePt(p1: Pt, p2: Pt): number {
    if (p1.x !== p2.x) return p1.x - p2.x;
    return p1.y - p2.y;
}

interface NetEdge {
    /** Canonical endpoints, lexicographically a <= b. */
    readonly a: Pt;
    readonly b: Pt;
    /** Net directed flow: positive means a->b. */
    net: number;
}

/** Default entry point matching PixelWrappedFont.processGlyph usage. */
export function imageToShapeDesc(img: RgbaImage): string {
    if (!img) throw new Error('img == null');

    const w = img.width;
    const h = img.height;

    // Foreground mask, top-left origin: alpha > threshold AND not pure black.
    const mask = new Uint8Array(w * h);
    for (let yy = 0; yy < h; ++yy) {
        for (let xx = 0; xx < w; ++xx) {
            const o = (yy * w + xx) * 4;
            const a = img.pixels[o + 3];
            mask[yy * w + xx] =
                a > ALPHA_THRESHOLD &&
                img.pixels[o] + img.pixels[o + 1] + img.pixels[o + 2] > 0
                    ? 1
                    : 0;
        }
    }

    // Pool of points keyed by coordinates (shared instances, like the Java pool).
    const pool = new Map<string, Pt>();
    const getPt = (x: number, y: number): Pt => {
        const key = `${x},${y}`;
        let p = pool.get(key);
        if (p === undefined) {
            p = makePt(x, y);
            pool.set(key, p);
        }
        return p;
    };

    // Net counts per undirected edge; positive means a->b (a == lexicographic min).
    const netCounts = new Map<string, NetEdge>();
    const addDirected = (from: Pt, to: Pt): void => {
        const [a, b] = comparePt(from, to) <= 0 ? [from, to] : [to, from];
        const key = `${a.x},${a.y}|${b.x},${b.y}`;
        const entry = netCounts.get(key);
        const delta = ptEq(a, from) ? 1 : -1;
        if (entry === undefined) netCounts.set(key, { a, b, net: delta });
        else entry.net += delta;
    };

    // Each foreground pixel contributes its CCW unit square in bottom-left coords.
    for (let yy = 0; yy < h; ++yy) {
        for (let xx = 0; xx < w; ++xx) {
            if (!mask[yy * w + xx]) continue;
            const xl = xx;
            const xr = xx + 1;
            const yb = h - yy - 1;
            const yt = yb + 1;
            const p0 = getPt(xl, yb);
            const p1 = getPt(xr, yb);
            const p2 = getPt(xr, yt);
            const p3 = getPt(xl, yt);
            addDirected(p0, p1);
            addDirected(p1, p2);
            addDirected(p2, p3);
            addDirected(p3, p0);
        }
    }

    // Outgoing adjacency lists from surviving directed edges, in edge insertion order.
    const outAdj = new Map<Pt, Pt[]>();
    for (const edge of netCounts.values()) {
        if (edge.net === 0) continue;
        const owner = edge.net > 0 ? edge.a : edge.b;
        const target = edge.net > 0 ? edge.b : edge.a;
        let list = outAdj.get(owner);
        if (list === undefined) {
            list = [];
            outAdj.set(owner, list);
        }
        for (let i = 0; i < Math.abs(edge.net); ++i) list.push(target);
    }

    // Convert lists to queues without reordering.
    const outQ = new Map<Pt, Pt[]>();
    for (const [pt, list] of outAdj) outQ.set(pt, list.slice());

    // Walk cycles consuming edges.
    const loops: Pt[][] = [];
    while (true) {
        let startFrom: Pt | null = null;
        for (const [pt, dq] of outQ) {
            if (dq.length > 0) {
                startFrom = pt;
                break;
            }
        }
        if (startFrom === null) break;
        const dq = outQ.get(startFrom)!;
        const startTo = dq.shift()!;
        let u = startFrom;
        let v = startTo;
        const poly: Pt[] = [];
        let safety = 0;
        while (true) {
            poly.push(u);
            const dqV = outQ.get(v);
            if (dqV === undefined || dqV.length === 0) {
                break; // degenerate / incomplete boundary
            }
            const nxt = dqV.shift()!;
            u = v;
            v = nxt;
            if (ptEq(u, startFrom) && ptEq(v, startTo)) break; // closed
            if (++safety > pool.size * 4 + 10000) break;
        }
        if (poly.length >= 3) loops.push(simplifyAxisAligned(poly));
    }

    // Canonicalize (rotate to lexicographically smallest first vertex) and dedupe.
    const norm: Pt[][] = [];
    const seen = new Set<string>();
    for (const p of loops) {
        if (p.length < 3) continue;
        let minIdx = 0;
        for (let i = 1; i < p.length; ++i) {
            if (comparePt(p[i], p[minIdx]) < 0) minIdx = i;
        }
        const rot: Pt[] = [];
        for (let i = 0; i < p.length; ++i) rot.push(p[(minIdx + i) % p.length]);
        const key = serializePoly(rot);
        if (!seen.has(key)) {
            seen.add(key);
            norm.push(rot);
        }
    }

    // Outer contours come out CCW and holes CW directly from the CCW unit-square
    // netting, so no reversal is needed before emission (Java's sign check is a no-op).
    const blocks: string[] = [];
    for (const poly of norm) {
        const area = polygonSignedArea(poly);
        if (Math.abs(area) < 1e-9) continue;
        blocks.push(polygonToShapedesc(poly));
    }
    return blocks.join('\n');
}

function simplifyAxisAligned(poly: Pt[]): Pt[] {
    if (poly.length <= 2) return poly.slice();
    const out: Pt[] = [];
    const n = poly.length;
    for (let i = 0; i < n; ++i) {
        const a = poly[(i + n - 1) % n];
        const b = poly[i];
        const c = poly[(i + 1) % n];
        if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) continue;
        out.push(b);
    }
    if (out.length < 3) return poly.slice();
    return out;
}

function polygonSignedArea(poly: Pt[]): number {
    let a = 0.0;
    const n = poly.length;
    for (let i = 0; i < n; ++i) {
        const p0 = poly[i];
        const p1 = poly[(i + 1) % n];
        a += p0.x * p1.y - p1.x * p0.y;
    }
    return 0.5 * a;
}

function polygonToShapedesc(poly: Pt[]): string {
    const parts: string[] = [];
    for (let i = 0; i < poly.length; ++i) {
        parts.push(
            `${formatCoord(poly[i].x)},${formatCoord(poly[i].y)}; ${COLOR_CYCLE[i % COLOR_CYCLE.length]}; `,
        );
    }
    return '{ ' + parts.join('') + '# }';
}

function serializePoly(poly: Pt[]): string {
    return poly.map((p) => `${p.x},${p.y}`).join(';');
}

function formatCoord(v: number): string {
    const r = Math.round(v); // coords are integral here; matches Math.rint in practice
    if (Math.abs(v - r) < 1e-9) return String(r);
    let s = v.toFixed(6);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}
