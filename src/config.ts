// Port of the Config / ConfigKey / JsonCodecs / FontInfoBuilder stack. The JSON schema
// is kept 1:1 with the Java tool so existing hand-written and UJF-generated configs
// load unchanged.
//
// Gson leniency is replicated: a malformed value for one key logs and keeps the
// default (Config.load catches per key), and nested optional fields fall back to
// their default on any error (JsonUtil.getOrDefault). All floats are narrowed to
// float32 exactly like Gson's getAsFloat.

import { f32 } from './javaformat.js';

export interface FontRange {
    start: number;
    end: number;
}

export interface FileFontInfoData {
    kind: 'file';
    filename: string;
    fontSize: number;      // float32
    padding: number;       // float32, default 0
    additionalArgs: string;
    /** Web-tool extension (unknown keys are ignored by Gson): frame glyphs with
     *  the font's vertical metrics like Mojang's own msdfgen tool fork did —
     *  -pxrange 8 plus an automatic -translate 0 <baseline>. */
    vanillaStyle?: boolean;
}

export interface PixelFontInfoData {
    kind: 'pixel';
    name: string;
    internalPadding: number; // float32 ("padding"), default 1
    padding: number;         // float32 ("externalPadding"), default 0
    scale: number;           // float32, default 1
    spaceWidth: number;      // float32, default 4
    widthOverride: string | null;
    additionalArgs: string;
}

export type FontInfoData = FileFontInfoData | PixelFontInfoData;

/** FontInfo.name(): the filename for file fonts, the sheet name for pixel fonts. */
export function fontName(info: FontInfoData): string {
    return info.kind === 'file' ? info.filename : info.name;
}

export interface PageRemap {
    from: number;
    to: number;
}

export interface WidthOverride {
    from: number; // char
    to: number;   // char
    width: number; // float32
}

export interface ConfigValues {
    testMode: boolean;
    showGlyphInfo: boolean;
    threads: number;
    range: FontRange;
    fonts: FontInfoData[];
    pageRemapping: PageRemap[];
    remapHangulChars: boolean;
}

export const DEFAULT_CONFIG: ConfigValues = {
    testMode: false,
    showGlyphInfo: false,
    threads: 4,
    range: { start: 0x0000, end: 0xFFFF },
    fonts: [],
    pageRemapping: [],
    remapHangulChars: false,
};

type Logger = { warn(msg: string): void; error(msg: string): void; info(msg: string): void };

/** Parses config.json content into typed values, mirroring Config.load's per-key fallback. */
export function parseConfig(json: unknown, log: Logger): ConfigValues {
    const values: ConfigValues = { ...DEFAULT_CONFIG };
    if (typeof json !== 'object' || json === null) {
        log.error('Malformed config json');
        return values;
    }
    const obj = json as Record<string, unknown>;

    // Config.load skips keys that are not present in the JSON at all.
    tryAssign('testMode', () => { values.testMode = asBoolean(obj['testMode']); });
    tryAssign('showGlyphInfo', () => { values.showGlyphInfo = asBoolean(obj['showGlyphInfo']); });
    tryAssign('threads', () => { values.threads = asInt(obj['threads']); });
    tryAssign('range', () => {
        const rangeObj = requireObject(obj['range'], 'range');
        values.range = {
            start: parseHex(rangeObj['from']) * 0x100,
            end: parseHex(rangeObj['to']) * 0x100 + 0xFF,
        };
    });
    tryAssign('fonts', () => {
        const arr = requireArray(obj['fonts']);
        values.fonts = arr.map(buildFontInfo);
    });
    tryAssign('pageRemapping', () => {
        const arr = requireArray(obj['pageRemapping']);
        values.pageRemapping = arr.map((el) => {
            const o = requireObject(el, 'pageRemapping entry');
            return { from: parseHex(o['from']), to: parseHex(o['to']) };
        });
    });
    tryAssign('remapHangulChars', () => { values.remapHangulChars = asBoolean(obj['remapHangulChars']); });

    return values;

    function tryAssign(key: string, fn: () => void): void {
        if (obj[key] === undefined) return;
        try {
            fn();
        } catch (e) {
            log.error(`Failed to parse config key ${key}: ${(e as Error).message}`);
        }
    }
}

/** FontInfoBuilder.build — polymorphic by "type", JsonUtil.getOrDefault for optionals. */
function buildFontInfo(element: unknown): FontInfoData {
    const obj = requireObject(element, 'font entry');
    const type = asString(obj['type']);
    switch (type) {
        case 'file':
            return {
                kind: 'file',
                filename: asString(obj['file']),
                fontSize: getOrDefault(() => asFloat(obj['size']), f32(0)),
                padding: getOrDefault(() => asFloat(obj['padding']), f32(0)),
                additionalArgs: getOrDefault(() => asString(obj['additionalArgs']), ''),
                vanillaStyle: getOrDefault(() => asBoolean(obj['vanillaStyle']), false),
            };
        case 'pixel':
            return {
                kind: 'pixel',
                name: asString(obj['name']),
                internalPadding: getOrDefault(() => asFloat(obj['padding']), f32(1)),
                padding: getOrDefault(() => asFloat(obj['externalPadding']), f32(0)),
                scale: getOrDefault(() => asFloat(obj['scale']), f32(1)),
                spaceWidth: getOrDefault(() => asFloat(obj['spaceWidth']), f32(4)),
                widthOverride: getOrDefault(() =>
                    obj['widthOverride'] === undefined || obj['widthOverride'] === null
                        ? null : asString(obj['widthOverride']), null),
                additionalArgs: getOrDefault(() => asString(obj['additionalArgs']), ''),
            };
        default:
            throw new Error(`Unknown font info type: ${type}`);
    }
}

// --- Gson-ish coercion helpers ---------------------------------------------

function getOrDefault<T>(getter: () => T, defaultValue: T): T {
    try {
        return getter();
    } catch {
        return defaultValue;
    }
}

function requireObject(v: unknown, what: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${what} is not an object`);
    }
    return v as Record<string, unknown>;
}

function requireArray(v: unknown): unknown[] {
    if (!Array.isArray(v)) throw new Error('value is not an array');
    return v;
}

function asString(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw new Error('value is not a string');
}

function asFloat(v: unknown): number {
    // getAsFloat narrows to float32; accepts numbers and numeric strings like Gson
    const n = typeof v === 'number' ? v : Number(asString(v));
    if (Number.isNaN(n)) throw new Error('value is not a number');
    return f32(n);
}

function asInt(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(asString(v));
    if (Number.isNaN(n)) throw new Error('value is not a number');
    return Math.trunc(n); // getAsInt narrows double -> int
}

function asBoolean(v: unknown): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true'; // Boolean.parseBoolean semantics
    throw new Error('value is not a boolean');
}

/** Integer.parseInt(String, 16) over whatever Gson's getAsString yields. */
export function parseHex(v: unknown): number {
    const s = asString(v).trim();
    const m = /^[+-]?[0-9a-fA-F]+$/.exec(s);
    if (!m) throw new Error(`not a hex integer: ${JSON.stringify(s)}`);
    const n = parseInt(s, 16);
    return n;
}
