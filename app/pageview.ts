// Right-panel page viewer. Renders one generated atlas page as legible glyphs
// by decoding the MTSDF data the way the Bedrock client samples it (median of
// the three MSDF channels, combined with the true-SDF alpha channel, threshold
// at the surface), and draws per-glyph width boxes on top. Supports the page
// navigator ([<] [XX] [>]), click-to-select, and dragging the right edge of the
// selected glyph's width box.
//
// The viewer caches rendered pages until markStale() (any generation-relevant
// input changed). Width edits are NOT part of that cache: they are applied on
// top of the computed widths through deps.widthOf, so dragging a handle only
// redraws — it never re-runs msdfgen.

import { ATLAS_SIZE, GLYPH_CELL, ATLAS_GRID } from '../src/atlas.js';

export interface PageData {
    /** Raw atlas RGBA (1024×1024×4), straight from the compositor. */
    rgba: Uint8Array;
    /** Final widths per glyph cell, 1.0 = the full 64px box. */
    widths: Float32Array;
}

export type PageLoadResult =
    | { ok: true; data: PageData; note?: string }
    | { ok: false; reason: string };

export interface PageViewDeps {
    loadPage(page: number): Promise<PageLoadResult>;
    /** Displayed width of a char in atlas pixels (manual edits already applied). */
    widthOf(charId: number): number;
    /** Commits a manual width in px; null reverts to the computed value. */
    setManualWidth(charId: number, px: number | null): void;
    selectionChanged(selected: number | null): void;
    /** Live width while the handle is dragged; px === null marks the end. */
    dragWidth(charId: number, px: number | null): void;
    busyChanged(busy: boolean): void;
}

const ZOOM_STEPS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
const HANDLE_HIT_PX = 7;
/** Rendered pages kept around (~4 MB of RGBA each); oldest evicted first. */
const MAX_CACHE = 12;

const COLOR_BOX = 'rgba(79, 156, 240, 0.18)';
const COLOR_EDGE = 'rgba(79, 156, 240, 0.9)';
const COLOR_SELECT = '#ffd166';

function hex2(v: number): string {
    return v.toString(16).toUpperCase().padStart(2, '0');
}

/** median-of-three without allocation */
function med3(a: number, b: number, c: number): number {
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

export class PageView {
    private readonly deps: PageViewDeps;

    private readonly cvs: HTMLCanvasElement;
    private readonly wrap: HTMLElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly statusSpan: HTMLElement;
    private readonly staleSpan: HTMLElement;
    private readonly pageInput: HTMLInputElement;
    private readonly prevBtn: HTMLButtonElement;
    private readonly nextBtn: HTMLButtonElement;
    private readonly zoomOutBtn: HTMLButtonElement;
    private readonly zoomInBtn: HTMLButtonElement;
    private readonly showWidthsInput: HTMLInputElement;

    /** Offscreen copy of the current atlas decoded into white-on-transparent coverage. */
    private readonly decoded: HTMLCanvasElement;
    private readonly decodeCtx: CanvasRenderingContext2D;
    private readonly decodeImg: ImageData;

    private page: number = 0;
    private data: PageData | null = null;
    private readonly cache = new Map<number, PageLoadResult & { ok: true }>();
    private stale = false;
    private zoom = 1.0;
    private busyDepth = 0;
    private runToken = 0;
    private staleTimer: ReturnType<typeof setTimeout> | null = null;

    private selectedIdx: number | null = null;
    private drag: { idx: number; pointerId: number; startX: number; startW: number; moved: boolean } | null = null;
    private currentX = 0;

    constructor(root: HTMLElement, deps: PageViewDeps) {
        this.deps = deps;
        const q = <K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] => {
            const e = root.querySelector('#' + id);
            if (e === null || e.tagName.toLowerCase() !== tag) throw new Error(`page view: missing #${id}`);
            return e as HTMLElementTagNameMap[K];
        };
        this.cvs = q('page-canvas', 'canvas');
        this.wrap = q('canvas-wrap', 'div');
        this.ctx = this.cvs.getContext('2d')!;
        this.statusSpan = q('page-status', 'span');
        this.staleSpan = q('page-stale', 'span');
        this.pageInput = q('page-input', 'input');
        this.prevBtn = q('page-prev', 'button');
        this.nextBtn = q('page-next', 'button');
        this.zoomOutBtn = q('zoom-out', 'button');
        this.zoomInBtn = q('zoom-in', 'button');
        this.showWidthsInput = q('show-widths', 'input');

        this.decoded = document.createElement('canvas');
        this.decoded.width = ATLAS_SIZE;
        this.decoded.height = ATLAS_SIZE;
        this.decodeCtx = this.decoded.getContext('2d')!;
        this.decodeImg = this.decodeCtx.createImageData(ATLAS_SIZE, ATLAS_SIZE);

        this.prevBtn.addEventListener('click', () => void this.navigate(this.page - 1));
        this.nextBtn.addEventListener('click', () => void this.navigate(this.page + 1));
        this.zoomOutBtn.addEventListener('click', () => this.stepZoom(-1));
        this.zoomInBtn.addEventListener('click', () => this.stepZoom(1));
        this.showWidthsInput.addEventListener('change', () => this.redraw());

        // Auto-commit once two hex digits are typed; Enter/blur commits whatever is there.
        this.pageInput.addEventListener('input', () => {
            if (/^[0-9a-fA-F]{2}$/.test(this.pageInput.value)) void this.commitPageField();
        });
        this.pageInput.addEventListener('change', () => void this.commitPageField());
        this.pageInput.addEventListener('focus', () => this.pageInput.select());

        this.cvs.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        this.cvs.addEventListener('pointermove', (e) => this.onPointerMove(e));
        this.cvs.addEventListener('pointerup', (e) => this.onPointerUp(e));
        this.cvs.addEventListener('pointercancel', (e) => this.onPointerUp(e));

        this.applyZoom();
        this.redraw();
    }

    // --- Navigation -----------------------------------------------------------

    get currentPage(): number {
        return this.page;
    }

    get hasData(): boolean {
        return this.data !== null;
    }

    getSelected(): number | null {
        return this.selectedIdx === null ? null : this.page * 0x100 + this.selectedIdx;
    }

    getCurrentData(): PageData | null {
        return this.data;
    }

    isBusy(): boolean {
        return this.busyDepth > 0;
    }

    deselect(): void {
        this.select(null);
    }

    async navigate(page: number, opts: { force?: boolean } = {}): Promise<void> {
        page = ((page % 0x100) + 0x100) % 0x100;
        this.pageInput.value = hex2(page);
        if (page !== this.page) {
            this.page = page;
            this.select(null);
        }
        const cached = this.stale ? undefined : this.cache.get(page);
        if (cached !== undefined && opts.force !== true) {
            this.apply(cached);
            return;
        }
        await this.loadAndApply(page);
    }

    /** Any generation-relevant input changed: drop the cache and re-render the
     *  current page shortly after (so spinner drags and typing settle first). */
    markStale(): void {
        this.cache.clear();
        this.staleSpan.hidden = false;
        this.staleSpan.textContent = '再レンダリングが必要';
        if (this.staleTimer !== null) clearTimeout(this.staleTimer);
        this.staleTimer = setTimeout(() => {
            this.staleTimer = null;
            void this.navigate(this.page, { force: true });
        }, 700);
    }

    /** Redraw only — used after width edits, which never need a re-render. */
    redraw(): void {
        this.paint();
    }

    private async commitPageField(): Promise<void> {
        const v = parseInt(this.pageInput.value.trim(), 16);
        if (Number.isInteger(v) && v >= 0 && v <= 0xFF) {
            await this.navigate(v);
        } else {
            this.pageInput.value = hex2(this.page);
        }
    }

    private async loadAndApply(page: number): Promise<void> {
        const token = ++this.runToken;
        this.setBusy(true);
        this.staleSpan.hidden = true;
        this.status(`ページ ${hex2(page)} をレンダリング中…`);
        try {
            const result = await this.deps.loadPage(page);
            if (token !== this.runToken) return; // superseded by a newer navigation
            if (result.ok) {
                this.cache.set(page, result);
                while (this.cache.size > MAX_CACHE) {
                    const oldest = this.cache.keys().next().value;
                    if (oldest === undefined) break;
                    this.cache.delete(oldest);
                }
                this.apply(result);
                this.status(result.note ?? `page ${hex2(page)} · ${hex4(page * 0x100)}–${hex4(page * 0x100 + 0xFF)}`);
            } else {
                this.data = null;
                this.selectedIdx = null;
                this.deps.selectionChanged(null);
                this.redraw();
                this.status(result.reason, 'warn');
            }
        } catch (e) {
            if (token === this.runToken) {
                this.data = null;
                this.redraw();
                this.status(`render failed: ${(e as Error).message}`, 'warn');
            }
        } finally {
            this.setBusy(false);
        }
    }

    private apply(result: PageLoadResult & { ok: true }): void {
        this.data = result.data;
        this.decodeAtlas(result.data.rgba);
        if (this.selectedIdx !== null) {
            // Keep the selection only when it still points at a real cell (it always does).
            this.deps.selectionChanged(this.getSelected());
        }
        this.redraw();
    }

    private setBusy(delta: boolean): void {
        this.busyDepth += delta ? 1 : -1;
        if (this.busyDepth < 0) this.busyDepth = 0;
        this.deps.busyChanged(this.busyDepth > 0);
    }

    private status(msg: string, level?: 'warn'): void {
        this.statusSpan.textContent = msg;
        this.statusSpan.className = level === 'warn' ? 'hint warn-text' : 'hint';
    }

    // --- Zoom -------------------------------------------------------------------

    private stepZoom(delta: number): void {
        const i = ZOOM_STEPS.indexOf(this.zoom);
        const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i === -1 ? 1 : i) + delta))];
        if (next === this.zoom) return;
        this.zoom = next;
        this.applyZoom();
        this.redraw();
    }

    private applyZoom(): void {
        const size = ATLAS_SIZE * this.zoom;
        this.cvs.width = size;
        this.cvs.height = size;
        this.cvs.style.width = `${size}px`;
        this.cvs.style.height = `${size}px`;
        this.zoomOutBtn.disabled = this.zoom <= ZOOM_STEPS[0];
        this.zoomInBtn.disabled = this.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
    }

    // --- MTSDF decoding -----------------------------------------------------------

    /** Decodes the atlas into white-on-transparent coverage: the client samples the
     *  median of the three MSDF channel distances plus the true-SDF alpha channel;
     *  bytes ≥128 mean "inside" (msdfgen maps distance 0 to mid-scale). */
    private decodeAtlas(rgba: Uint8Array): void {
        const px = this.decodeImg.data;
        for (let i = 0, o = 0; o < px.length; i += 4, o += 4) {
            const m = med3(rgba[i], rgba[i + 1], rgba[i + 2]);
            const v = m > rgba[i + 3] ? m : rgba[i + 3];
            px[o] = 255;
            px[o + 1] = 255;
            px[o + 2] = 255;
            px[o + 3] = v >= 128 ? 255 : 0;
        }
        this.decodeCtx.putImageData(this.decodeImg, 0, 0);
    }

    // --- Painting ---------------------------------------------------------------

    private cellPx(): number {
        return GLYPH_CELL * this.zoom;
    }

    private paint(): void {
        const ctx = this.ctx;
        const size = ATLAS_SIZE * this.zoom;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#101216';
        ctx.fillRect(0, 0, size, size);

        if (this.data === null) {
            return;
        }

        ctx.drawImage(this.decoded, 0, 0, ATLAS_SIZE, ATLAS_SIZE, 0, 0, size, size);

        const cell = this.cellPx();

        // Faint gridlines between glyph cells.
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let g = 1; g < ATLAS_GRID; ++g) {
            const p = Math.round(g * cell) + 0.5;
            ctx.moveTo(p, 0);
            ctx.lineTo(p, size);
            ctx.moveTo(0, p);
            ctx.lineTo(size, p);
        }
        ctx.stroke();

        if (!this.showWidthsInput.checked) {
            this.paintSelection(cell);
            return;
        }

        // Width boxes: semi-transparent fill spanning the advance width, bright
        // right-edge handle on the selected glyph.
        for (let i = 0; i < ATLAS_GRID * ATLAS_GRID; ++i) {
            const w = this.effectiveWidthPx(i);
            if (!(w > 0)) continue;
            const x = (i % ATLAS_GRID) * cell;
            const y = Math.floor(i / ATLAS_GRID) * cell;
            const sw = w * this.zoom;
            const selected = i === this.selectedIdx;
            ctx.fillStyle = selected ? 'rgba(255, 209, 102, 0.20)' : COLOR_BOX;
            ctx.fillRect(x, y, sw, cell);
            ctx.fillStyle = selected ? COLOR_SELECT : COLOR_EDGE;
            ctx.fillRect(x + sw - (selected ? 2 : 1.5), y, selected ? 4 : 3, cell);
        }

        this.paintSelection(cell);

        if (this.selectedIdx !== null) {
            const x = (this.selectedIdx % ATLAS_GRID) * cell;
            const y = Math.floor(this.selectedIdx / ATLAS_GRID) * cell;
            const w = this.effectiveWidthPx(this.selectedIdx);
            ctx.font = `${Math.max(13, 11 * this.zoom)}px ui-monospace, monospace`;
            ctx.fillStyle = '#000';
            ctx.fillText(`${trimNum(w)}px`, x + 7, y + Math.max(15, 13 * this.zoom) + 1);
            ctx.fillStyle = COLOR_SELECT;
            ctx.fillText(`${trimNum(w)}px`, x + 6, y + Math.max(15, 13 * this.zoom));
        }
    }

    private paintSelection(cell: number): void {
        if (this.selectedIdx === null) return;
        const x = (this.selectedIdx % ATLAS_GRID) * cell;
        const y = Math.floor(this.selectedIdx / ATLAS_GRID) * cell;
        this.ctx.strokeStyle = COLOR_SELECT;
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
    }

    /** Width shown while painting: the live drag value wins over the stored one. */
    private effectiveWidthPx(idx: number): number {
        if (this.drag !== null && this.drag.idx === idx) {
            return Math.min(64, Math.max(0, this.drag.startW + (this.currentX - this.drag.startX) / this.zoom));
        }
        return this.deps.widthOf(this.page * 0x100 + idx);
    }

    // --- Pointer interaction ------------------------------------------------------

    private canvasXY(e: PointerEvent): { x: number; y: number } {
        const r = this.cvs.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    private hitHandle(idx: number, x: number, y: number): boolean {
        const cell = this.cellPx();
        const cx = (idx % ATLAS_GRID) * cell;
        const cy = Math.floor(idx / ATLAS_GRID) * cell;
        if (y < cy || y > cy + cell) return false;
        const hx = cx + this.effectiveWidthPx(idx) * this.zoom;
        return Math.abs(x - hx) <= HANDLE_HIT_PX;
    }

    private onPointerDown(e: PointerEvent): void {
        if (this.data === null) return;
        const { x, y } = this.canvasXY(e);
        const cell = this.cellPx();
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        if (cx < 0 || cy < 0 || cx >= ATLAS_GRID || cy >= ATLAS_GRID) return;
        const idx = cy * ATLAS_GRID + cx;

        if (this.showWidthsInput.checked && idx === this.selectedIdx && this.hitHandle(idx, x, y)) {
            this.drag = { idx, pointerId: e.pointerId, startX: x, startW: this.effectiveWidthPx(idx), moved: false };
            this.currentX = x;
            this.cvs.setPointerCapture(e.pointerId);
            this.redraw();
            return;
        }

        this.select(idx);
        // A plain click selects; only the handle starts a drag, so nothing else here.
    }

    private onPointerMove(e: PointerEvent): void {
        const { x, y } = this.canvasXY(e);

        if (this.drag !== null) {
            if (e.pointerId !== this.drag.pointerId) return;
            this.currentX = x;
            if (Math.abs(x - this.drag.startX) > 2) this.drag.moved = true;
            this.deps.dragWidth(this.page * 0x100 + this.drag.idx, this.effectiveWidthPx(this.drag.idx));
            this.redraw();
            return;
        }

        // Cursor feedback near the draggable edge of the selected glyph.
        this.cvs.style.cursor =
            this.data !== null && this.showWidthsInput.checked && this.selectedIdx !== null && this.hitHandle(this.selectedIdx, x, y)
                ? 'ew-resize'
                : 'crosshair';
    }

    private onPointerUp(e: PointerEvent): void {
        if (this.drag === null || e.pointerId !== this.drag.pointerId) return;
        const { idx, moved } = this.drag;
        const w = this.effectiveWidthPx(idx);
        this.drag = null;
        this.deps.dragWidth(this.page * 0x100 + idx, null);
        if (moved) {
            this.deps.setManualWidth(this.page * 0x100 + idx, w);
        }
        this.redraw();
    }

    private select(idx: number | null): void {
        if (this.selectedIdx === idx) return;
        this.selectedIdx = idx;
        this.deps.selectionChanged(idx === null ? null : this.page * 0x100 + idx);
        this.redraw();
    }
}

/** Formats a px width for display/editor fields: up to 2 decimals, no trailing zeros. */
export function trimNum(v: number): string {
    const s = v.toFixed(2);
    return s.endsWith('.00') ? s.slice(0, -3) : s.endsWith('0') ? s.slice(0, -1) : s;
}

function hex4(v: number): string {
    return v.toString(16).toUpperCase().padStart(4, '0');
}
