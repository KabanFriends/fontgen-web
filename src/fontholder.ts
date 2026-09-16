// Port of FontHolder plus the loadFont() paths of FileFontInfo / PixelFontInfo and
// FileFontTypes.parse (including the width-override file loading that happens inside
// PixelWrappedFont's constructor).

import { decodePng } from './png.js';
import { SfntFont, IOException } from './sfnt.js';
import type { FontInfoData, PixelFontInfoData, WidthOverride } from './config.js';
import { fontName } from './config.js';
import { f32 } from './javaformat.js';
import { missingCharImage } from './resources.js';
import { MissingPixelWrappedFont, PixelWrappedFont } from './pixelfont.js';
import { FileWrappedFontImpl } from './filefont.js';
import type { WrappedFont } from './wrappedfont.js';

export interface LoggerLike {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

/** Working-directory file access, mirroring the Java tool's directory-relative reads. */
export interface FileSource {
    /** Returns file bytes, or null when absent (Java's File.exists() == false). */
    readFile(path: string): Uint8Array | null;
}

export class FontHolder {
    readonly fonts: WrappedFont[] = [];
    readonly fallbackFont: WrappedFont;

    constructor(fontInfoArray: FontInfoData[], files: FileSource, log: LoggerLike) {
        for (const info of fontInfoArray) {
            const font = loadFont(info, files, log);
            if (font === null) {
                log.warn(`Font ${fontName(info)} could not be loaded, skipping`);
                continue;
            }
            this.fonts.push(font);
        }

        // Java does fonts.get(0) unconditionally: an empty list crashes here,
        // before SmoothGenerator.start()'s "No valid font files" check can run.
        const first = this.fonts[0];
        if (first === undefined) {
            throw new Error('IndexOutOfBoundsException: fonts list is empty');
        }
        this.fallbackFont =
            first instanceof PixelWrappedFont
                ? new MissingPixelWrappedFont(first.getFontInfo(), missingCharImage())
                : first;
    }

    getFirstFont(charId: number): WrappedFont {
        for (const font of this.fonts) {
            if (font.hasGlyph(charId)) {
                return font;
            }
        }
        return this.fallbackFont;
    }

    getFontCount(): number {
        return this.fonts.length;
    }
}

export function loadFont(info: FontInfoData, files: FileSource, log: LoggerLike): WrappedFont | null {
    switch (info.kind) {
        case 'file':
            return loadFileFont(info, files, log);
        case 'pixel':
            return loadPixelFont(info, files, log);
    }
}

function loadFileFont(
    info: Extract<FontInfoData, { kind: 'file' }>,
    files: FileSource,
    log: LoggerLike,
): WrappedFont | null {
    const bytes = files.readFile(`fonts/${info.filename}`);
    if (bytes === null) {
        log.warn(`Font file ${info.filename} was not found`);
        return null;
    }

    // FileFontTypes.parse: only the reader matching the extension attempts a parse;
    // an IOException is logged and null returned.
    const dot = info.filename.lastIndexOf('.');
    const ext = dot === -1 ? '' : info.filename.slice(dot + 1).toLowerCase();
    if (ext !== 'ttf' && ext !== 'otf') return null;

    try {
        const font = new SfntFont(bytes);
        log.info(`Loaded file font: ${info.filename}`);
        return new FileWrappedFontImpl(info, bytes, font);
    } catch (e) {
        if (!(e instanceof IOException)) throw e;
        log.error(`Failed to read ${info.filename} using ${ext === 'ttf' ? 'TrueTypeFontReader' : 'OpenTypeFontReader'}: ${(e as Error).message}`);
        return null;
    }
}

function loadPixelFont(
    info: PixelFontInfoData,
    files: FileSource,
    log: LoggerLike,
): WrappedFont | null {
    const jsonBytes = files.readFile(`pixel/${info.name}.json`);
    const pngBytes = files.readFile(`pixel/${info.name}.png`);
    if (jsonBytes === null || pngBytes === null) {
        log.warn(`Pixel font files ${info.name}.(json|png) were not found`);
        return null;
    }

    try {
        const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, unknown>;
        const charSetRaw = json['chars'];
        if (!Array.isArray(charSetRaw)) throw new Error('chars is not an array');
        const chars: string[] = charSetRaw.map((el) => {
            if (typeof el !== 'string') throw new Error('char set is not a string');
            return el;
        });
        const fullImage = decodePng(pngBytes);

        const font = new PixelWrappedFont(info, chars, fullImage, loadWidthOverrides(info, files, log));
        log.info(`Loaded pixel font: ${info.name} (W:${font.getGridWidth()} H:${font.getGridHeight()} RS:${font.getRenderScale()})`);
        return font;
    } catch (e) {
        log.error(`Failed to load pixel font ${info.name}: ${(e as Error).message}`);
        return null;
    }
}

/** Width overrides are loaded inside PixelWrappedFont's constructor in Java. */
function loadWidthOverrides(
    info: PixelFontInfoData,
    files: FileSource,
    log: LoggerLike,
): WidthOverride[] {
    if (info.widthOverride === null) return [];

    const bytes = files.readFile(info.widthOverride);
    if (bytes === null) {
        log.warn(`Width override file ${info.widthOverride} does not exist`);
        return [];
    }

    try {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const arr = json['overrides'];
        if (!Array.isArray(arr)) throw new Error('overrides is not an array');
        const overrides = arr.map((el): WidthOverride => {
            const o = el as Record<string, unknown>;
            const fromStr = requireString(o['from']);
            const toStr = requireString(o['to']);
            // Java takes charAt(0) — the FIRST CHARACTER, not a hex parse.
            const from = fromStr.charCodeAt(0);
            const to = toStr.charCodeAt(0);
            const width = asFloat(o['width']);
            return { from, to, width };
        });
        log.info(`Using width override file ${info.widthOverride}`);
        return overrides;
    } catch (e) {
        log.error(`Failed to read width override file ${info.widthOverride}: ${(e as Error).message}`);
        throw e; // Java rethrows out of the ctor -> loadFont catches Throwable -> skip font
    }
}

function requireString(v: unknown): string {
    if (typeof v === 'string') return v;
    throw new Error('value is not a string');
}

function asFloat(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(requireString(v));
    if (Number.isNaN(n)) throw new Error('value is not a number');
    return f32(n);
}
