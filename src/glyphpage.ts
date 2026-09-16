// Port of GlyphPage: renders all 256 glyphs of one Unicode page and composites them
// into the atlas plus the .fontdata width file.
//
// Quirks replicated from the Java original:
//   - The width is computed BEFORE rendering (empty glyphs still get real widths).
//   - A failed render writes NO width entry at all — subsequent widths shift left,
//     exactly like the Java future.get() path that skips buffer.putFloat on failure.
//   - additionalArgs are appended AFTER the -o argument.
//   - Output files use the REMAPPED page id.

import { f32 } from './javaformat.js';
import { decodePng, encodePng, type RgbaImage } from './png.js';
import { createAtlas, blitGlyph } from './atlas.js';
import { fontName } from './config.js';
import { GLYPH_DIM, splitAdditionalArgs } from './wrappedfont.js';
import type { MsdfgenExecutor } from './msdfgen.js';
import type { FontHolder, LoggerLike } from './fontholder.js';
import type { RemapHandler } from './remaphandler.js';

export interface GlyphPageResult {
    /** 'smooth_XX.png' bytes. */
    png: Uint8Array;
    /** 'smooth_XX.fontdata' bytes: 4 zero header bytes + 256 little-endian float32s. */
    fontdata: Uint8Array;
    /** Raw atlas pixels (RGBA, straight from compositing) so callers can preview
     *  a page without decoding the encoded PNG. */
    atlasRgba: Uint8Array;
    /** Final widths per glyph CELL (index i = char page*0x100+i). Only differs
     *  from the .fontdata entry order when a render task failed — that quirk
     *  shifts the file's entries left, and the preview/editing layer deliberately
     *  addresses glyphs by cell, not by shifted file position. */
    glyphWidths: Float32Array;
}

interface Glyph {
    charId: number;
    width: number; // float32
    /** null marks a failed task (cell left untouched, no width written). */
    image: RgbaImage | null;
    source: string;
}

export class CancelledError extends Error {
    constructor() {
        super('generation cancelled');
    }
}

export interface GlyphPageContext {
    fontHolder: FontHolder;
    remapHandler: RemapHandler;
    msdfgen: MsdfgenExecutor;
    showGlyphInfo: boolean;
    log: LoggerLike;
    /** Called after each glyph of the page settles (success or failure). */
    onProgress?: (doneInPage: number) => void;
    /** Checked before each glyph; when true, generation unwinds with CancelledError. */
    isCancelled?: () => boolean;
}

export async function generateGlyphPage(ctx: GlyphPageContext, pageId: number): Promise<GlyphPageResult> {
    const { fontHolder, remapHandler, log } = ctx;

    // Render phase: all 256 tasks are submitted at once and consumed in index
    // order — same structure as the Java Future[] loop, with concurrency living
    // inside the executor (thread pool there, worker pool in the app).
    const tasks: Promise<Glyph | null>[] = new Array(0x100);
    let done = 0;
    for (let i = 0; i < 0x100; ++i) {
        const id = (pageId * 0x100 + i) & 0xFFFF;
        tasks[i] = renderGlyph(ctx, id).catch((e) => {
            if (e instanceof CancelledError) throw e;
            log.error(`Glyph generation task failed: msdfgen for ${hex4(id)} — ${(e as Error).message}`);
            return null;
        }).then((glyph) => {
            ctx.onProgress?.(++done);
            return glyph;
        });
    }
    const results = await Promise.all(tasks);

    // Composite phase.
    const atlas = createAtlas();
    const buffer = new Uint8Array(0x404);
    const view = new DataView(buffer.buffer);
    const glyphWidths = new Float32Array(0x100);
    let offset = 4; // zero header

    for (let i = 0; i < results.length; ++i) {
        const glyph = results[i];
        if (glyph === null) continue; // ExecutionException path: no draw, no width
        if (glyph.image !== null) {
            blitGlyph(atlas, i % 0x10, Math.floor(i / 0x10), glyph.image);
        }
        view.setFloat32(offset, glyph.width, true); // little-endian float32
        offset += 4;
        glyphWidths[i] = glyph.width;

        if (ctx.showGlyphInfo) {
            const w = glyph.width.toString();
            if (isControlChar(glyph.charId)) {
                ctx.log.info(`${hex4(glyph.charId)} - Width: ${w}, Source: ${glyph.source}`);
            } else {
                const c = String.fromCharCode(glyph.charId);
                ctx.log.info(`${c} (${hex4(glyph.charId)}) - Width: ${w}, Source: ${glyph.source}`);
            }
        }
    }

    const remappedPageId = remapHandler.remap(pageId);
    if (pageId !== remappedPageId) {
        log.info(`Remapping page ${hex2(pageId)} to ${hex2(remappedPageId)}`);
    }

    return {
        png: encodePng(atlas),
        fontdata: buffer,
        atlasRgba: atlas.pixels,
        glyphWidths,
    };
}

async function renderGlyph(ctx: GlyphPageContext, id: number): Promise<Glyph> {
    if (ctx.isCancelled?.()) throw new CancelledError();

    const font = ctx.fontHolder.getFirstFont(id);

    // Width is computed before the U+0000 shortcut, so even the empty glyph has one.
    const width = f32(font.getWidth(id) + f32(font.getFontInfo().padding / GLYPH_DIM));

    if (id === 0x00) {
        return { charId: id, width, image: emptyImage(), source: 'None' };
    }

    const outPath = `/out/out_${hex4(id)}.png`;
    const request = font.prepareRender(id, outPath);
    for (const arg of splitAdditionalArgs(font.getFontInfo().additionalArgs)) {
        request.args.push(arg);
    }

    const outcome = await ctx.msdfgen.run(request);
    if (outcome.data === null) {
        const tail = outcome.logs.slice(-3).join(' | ');
        throw new Error(`no output produced${tail ? ` — ${tail}` : ''}`);
    }
    return { charId: id, width, image: decodePng(outcome.data), source: fontName(font.getFontInfo()) };
}

let cachedEmpty: RgbaImage | null = null;
function emptyImage(): RgbaImage {
    if (cachedEmpty === null) {
        cachedEmpty = { width: GLYPH_DIM, height: GLYPH_DIM, pixels: new Uint8Array(GLYPH_DIM * GLYPH_DIM * 4) };
    }
    return cachedEmpty;
}

/** Port of CharUtil.isControlChar. */
function isControlChar(c: number): boolean {
    return c < 0x20 || (c >= 0x80 && c <= 0x9F);
}

function hex4(v: number): string {
    return v.toString(16).toUpperCase().padStart(4, '0');
}

function hex2(v: number): string {
    return v.toString(16).toUpperCase().padStart(2, '0');
}
