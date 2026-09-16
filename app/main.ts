// App shell: form state <-> config.json, worker pool lifecycle, the right-panel
// page preview (render/cancel/caching lives in pageview.ts), glyph width
// editing, and pack assembly + download. The heavy lifting lives in src/ (the
// parity-tested pipeline); this file only adapts it to the browser.
//
// The font list mixes TTF/OTF entries and bitmap-sheet entries because config
// order is the fallback order across both kinds (FontHolder.getFirstFont).
//
// Manual glyph widths (edited in the page viewer or the left-panel editor) are
// NOT part of config.json: they patch the generated .fontdata floats directly,
// for both the live preview and the exported pack.

import './style.css';

import { runGeneration } from '../src/generator.js';
import { CancelledError } from '../src/glyphpage.js';
import { suggestFontSize } from '../src/filefont.js';
import { SfntFont } from '../src/sfnt.js';
import { parseConfig, type PageRemap } from '../src/config.js';
import type { FileSource, LoggerLike } from '../src/fontholder.js';
import { f32 } from '../src/javaformat.js';
import { isPageSupported } from '../src/pageutil.js';
import { MsdfgenPool } from './pool.js';
import { buildPackZip, type PackMeta } from './pack.js';
import { PageView, trimNum, type PageLoadResult } from './pageview.js';

interface FileFontEntry {
    kind: 'file';
    id: number;
    /** null until the user picks the actual file (config-imported placeholder). */
    file: File | null;
    name: string;
    size: number;
    padding: number;
    args: string;
    /** UI mode only: simple offset inputs vs the raw additionalArgs field. */
    argsGui: boolean;
    /** Vanilla-style framing (-pxrange 8 + metrics baseline translate); on by
     *  default in this tool, off for plain Java-tool configs. */
    vanillaStyle: boolean;
}

interface PixelFontEntry {
    kind: 'pixel';
    id: number;
    jsonFile: File | null;
    pngFile: File | null;
    /** Set for Bedrock textures (glyph_XX.png): chars are derived from the page
     *  id instead of an uploaded .json char grid. */
    bedrockPage: number | null;
    /** Config `name`: path of the pair under pixel/, extensionless. Editable. */
    name: string;
    scale: number;
    internalPadding: number;
    externalPadding: number;
    spaceWidth: number;
    args: string;
    /** UI mode only: simple offset inputs vs the raw additionalArgs field. */
    argsGui: boolean;
    useOverrides: boolean;
}

type FontEntry = FileFontEntry | PixelFontEntry;

interface OverrideRange {
    from: number; // char code (Java takes charAt(0))
    to: number; // char code
    width: number;
}

/** Virtual path the app stores its edited override table at. */
const OVERRIDES_PATH = 'width_overrides.json';

// --- DOM handles ------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
    const e = document.getElementById(id);
    if (e === null) throw new Error(`missing #${id}`);
    if (e.tagName.toLowerCase() !== tag) throw new Error(`#${id} is <${e.tagName.toLowerCase()}>, expected <${tag}>`);
    return e as HTMLElementTagNameMap[K];
}

const fontList = el('font-list', 'ol');
const addFontsBtn = el('add-fonts', 'button');
const fontInput = el('font-input', 'input');
const javaTextureBtn = el('add-java-texture', 'button');
const javaDialog = el('java-texture-dialog', 'dialog');
const javaPngPick = el('java-pick-png', 'button');
const javaJsonPick = el('java-pick-json', 'button');
const javaPngName = el('java-png-name', 'span');
const javaJsonName = el('java-json-name', 'span');
const javaImportBtn = el('java-import', 'button');
const javaCancelBtn = el('java-cancel', 'button');
const javaPngInput = el('java-png-input', 'input');
const javaJsonInput = el('java-json-input', 'input');
const bedrockBtn = el('add-bedrock-texture', 'button');
const bedrockInput = el('bedrock-input', 'input');
const rangeFrom = el('range-from', 'input');
const rangeTo = el('range-to', 'input');
const threadsInput = el('threads', 'input');
const remapHangul = el('remap-hangul', 'input');
const pageRemapArea = el('page-remapping', 'textarea');
const remapStatus = el('remap-status', 'span');
const presetHangulBtn = el('preset-hangul', 'button');
const clearRemapsBtn = el('clear-remaps', 'button');
const overrideBody = el('override-body', 'tbody');
const addOverrideBtn = el('add-override', 'button');
const importOverridesBtn = el('import-overrides', 'button');
const exportOverridesBtn = el('export-overrides', 'button');
const overrideStatus = el('override-status', 'span');
const overridesInput = el('overrides-input', 'input');
const importConfigBtn = el('import-config', 'button');
const exportConfigBtn = el('export-config', 'button');
const configInput = el('config-input', 'input');
const generateBtn = el('generate', 'button');
const logPre = el('log', 'pre');
const resultSection = el('result-section', 'section');
const packName = el('pack-name', 'input');
const packDesc = el('pack-desc', 'input');
const packVersion = el('pack-version', 'input');
const downloadZip = el('download-zip', 'a');
const glyphSection = el('glyph-section', 'section');
const glyphChar = el('glyph-char', 'span');
const glyphWidthInput = el('glyph-width', 'input');
const glyphComputed = el('glyph-computed', 'span');
const glyphResetBtn = el('glyph-reset', 'button');
const glyphCloseBtn = el('glyph-close', 'button');
const overlay = el('overlay', 'div');
const overlayTitle = el('overlay-title', 'h3');
const overlayBar = el('overlay-bar', 'progress');
const overlayLabel = el('overlay-label', 'p');
const overlayCancelBtn = el('overlay-cancel', 'button');

// --- State ------------------------------------------------------------------

let nextEntryId = 1;
const fonts: FontEntry[] = [];
const overrideRows: OverrideRange[] = [];

/** Manually edited glyph widths in px (char code -> px; 64 = full box). Applied
 *  on top of the generated .fontdata widths for display AND pack export. */
const manualWidths = new Map<number, number>();

let pool: MsdfgenPool | null = null;
let poolThreads = 0;
/** Font/sheet bytes keyed by virtual path; rebuilt whenever an input changes. */
let cachedFileMap: Map<string, Uint8Array> | null = null;

let previewBusy = false;
let previewToken = 0;
let previewCancelled = false;
let exportRunning = false;
let exportCancelled = false;

threadsInput.value = String(navigator.hardwareConcurrency || 4);

// --- Small helpers ----------------------------------------------------------

function download(filename: string, data: BlobPart, type: string): void {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const hex2 = (v: number): string => v.toString(16).toUpperCase().padStart(2, '0');

/** The Hangul-slot trick from CLAUDE.md / the UJF templates: pages the client
 *  does not load smooth textures for are redirected into unused Hangul slots. */
const HANGUL_PRESET: Array<{ from: string; to: string }> = [
    ...Array.from({ length: 0x1f - 0x05 + 1 }, (_, i) => ({ from: hex2(0x05 + i), to: hex2(0xac + i) })),
    ...Array.from({ length: 0x2d - 0x22 + 1 }, (_, i) => ({ from: hex2(0x22 + i), to: hex2(0xc7 + i) })),
];

function logLine(level: 'info' | 'warn' | 'error', msg: string): void {
    logPre.hidden = false;
    const span = document.createElement('span');
    if (level !== 'info') span.className = level;
    span.textContent = msg + '\n';
    logPre.appendChild(span);
    logPre.scrollTop = logPre.scrollHeight;
    while (logPre.childElementCount > 800) logPre.firstElementChild?.remove();
}

function logger(): LoggerLike {
    return {
        info: (m) => logLine('info', m),
        warn: (m) => logLine('warn', m),
        error: (m) => logLine('error', m),
    };
}

// --- Progress overlay ---------------------------------------------------------

let overlayUses = 0;

function acquireOverlay(title: string): void {
    overlayUses += 1;
    overlayTitle.textContent = title;
    overlayBar.value = 0;
    overlayLabel.textContent = '';
    overlay.hidden = false;
}

function releaseOverlay(): void {
    overlayUses = Math.max(0, overlayUses - 1);
    if (overlayUses === 0) overlay.hidden = true;
}

function setOverlayProgress(done: number, total: number, label: string): void {
    overlayBar.max = Math.max(1, total);
    overlayBar.value = done;
    overlayLabel.textContent = label;
}

overlayCancelBtn.addEventListener('click', () => {
    exportCancelled = true;
    previewCancelled = true;
});

// --- additionalArgs offset editing ---------------------------------------------
//
// The per-font offset GUI edits the `-pxtranslate <x> <y>` fragment inside a
// font's additionalArgs string in place; every other argument survives
// verbatim. msdfgen settings are last-wins, so when several fragments exist
// the LAST one is the live one and the one the GUI edits.

const NUM_PAT = String.raw`-?(?:\d+(?:\.\d*)?|\.\d+)`;
const PXTRANSLATE_RX = String.raw`(^| )-pxtranslate( +)(${NUM_PAT})( +)(${NUM_PAT})(?=$| )`;

/** The LAST -pxtranslate fragment (msdfgen settings are last-wins). Group 1 is
 *  the leading separator, 3/5 the two numbers. */
function lastPxTranslateMatch(args: string): RegExpExecArray | null {
    const re = new RegExp(PXTRANSLATE_RX, 'g');
    let last: RegExpExecArray | null = null;
    for (let m = re.exec(args); m !== null; m = re.exec(args)) last = m;
    return last;
}

/** The live -pxtranslate offset of an args string, or null when absent. */
function parsePxTranslate(args: string): { x: string; y: string } | null {
    const m = lastPxTranslateMatch(args);
    return m === null ? null : { x: m[3], y: m[5] };
}

/** Replaces the numbers of the last -pxtranslate fragment, or appends one. */
function withPxTranslate(args: string, x: string, y: string): string {
    const m = lastPxTranslateMatch(args);
    if (m !== null) {
        return args.slice(0, m.index)
            + m[1] + '-pxtranslate' + m[2] + x + m[4] + y
            + args.slice(m.index + m[0].length);
    }
    return args === '' ? `-pxtranslate ${x} ${y}` : `${args} -pxtranslate ${x} ${y}`;
}

/** Removes every -pxtranslate fragment (tidying doubled spaces it leaves). */
function withoutPxTranslate(args: string): string {
    const stripped = args.replace(
        new RegExp(` ?-pxtranslate( +)(?:${NUM_PAT})( +)(?:${NUM_PAT})(?=$| )`, 'g'), '');
    return stripped.replace(/ {2,}/g, ' ').trim();
}

// --- Input-change invalidation --------------------------------------------------

/** Any generation-relevant input changed: the preview must re-render and the
 *  font-byte cache is dropped. Width edits and pack metadata don't count. */
function inputsChanged(): void {
    cachedFileMap = null;
    pageView.markStale();
}

// Delegated: every INPUT/TEXTAREA under the config column reports on 'change'.
document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.closest('#left-col')) return;
    if (t.id.startsWith('pack-') || t.id === 'glyph-width') return;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') inputsChanged();
});

// --- Uploads ----------------------------------------------------------------

addFontsBtn.addEventListener('click', () => fontInput.click());
fontInput.addEventListener('change', async () => {
    for (const file of fontInput.files ?? []) {
        const existing = fonts.find((f): f is FileFontEntry => f.kind === 'file' && f.name === file.name);
        if (existing) {
            existing.file = file; // re-upload replaces the bytes
            continue;
        }
        fonts.push({
            kind: 'file',
            id: nextEntryId++,
            file,
            name: file.name,
            size: await defaultFontSize(file),
            padding: 0,
            args: '',
            argsGui: true,
            vanillaStyle: true,
        });
    }
    fontInput.value = '';
    renderFontList();
});

/** Default `size` for a freshly uploaded TTF/OTF: the per-font equivalent of
 *  Mojang's heuristic scale (see suggestFontSize), rounded for display; 48
 *  when the font's metrics can't be read in this browser. */
async function defaultFontSize(file: File): Promise<number> {
    try {
        const sf = new SfntFont(new Uint8Array(await file.arrayBuffer()));
        const s = suggestFontSize(sf);
        return s === null ? 48 : Math.round(s * 100) / 100;
    } catch {
        return 48;
    }
}

/** Config `name` for an uploaded bitmap texture: relative path minus extension;
 *  a leading `pixel/` directory is dropped since names are already pixel/-relative
 *  (`unicode/unicode_05` stays, `pixel/unicode/unicode_05` becomes it). */
function entryNameFromFile(file: File): string {
    const rel = file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name;
    let base = rel.replace(/\.(png|json)$/i, '');
    if (base.startsWith('pixel/')) base = base.slice('pixel/'.length);
    return base;
}

/** Creates a pixel entry or updates the one already using this name. */
function upsertPixelEntry(name: string, patch: Partial<PixelFontEntry>): void {
    const existing = fonts.find((f): f is PixelFontEntry => f.kind === 'pixel' && f.name === name);
    if (existing) {
        Object.assign(existing, patch); // re-import replaces the bytes
        return;
    }
    fonts.push({
        kind: 'pixel',
        id: nextEntryId++,
        jsonFile: null,
        pngFile: null,
        bedrockPage: null,
        name,
        scale: 0.75,
        internalPadding: 1,
        externalPadding: 0,
        spaceWidth: 4,
        // Fresh sheets start nudged one quarter-cell up (off y = 16); the offset
        // GUI reads/writes this same -pxtranslate fragment.
        args: '-pxtranslate 0 16',
        argsGui: true,
        useOverrides: false,
        ...patch,
    });
}

// Java texture flow: one .png plus its char-grid .json, picked in a dialog.
let pendingPng: File | null = null;
let pendingJson: File | null = null;

function refreshJavaDialog(): void {
    javaPngName.textContent = pendingPng?.name ?? '未選択';
    javaJsonName.textContent = pendingJson?.name ?? '未選択';
    javaPngName.classList.toggle('filled', pendingPng !== null);
    javaJsonName.classList.toggle('filled', pendingJson !== null);
    javaImportBtn.disabled = pendingPng === null || pendingJson === null;
}

javaTextureBtn.addEventListener('click', () => {
    pendingPng = null;
    pendingJson = null;
    refreshJavaDialog();
    javaDialog.showModal();
});
javaCancelBtn.addEventListener('click', () => javaDialog.close());

function wireJavaPicker(pick: HTMLButtonElement, input: HTMLInputElement, apply: (file: File) => void): void {
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file !== undefined) apply(file);
        input.value = '';
        refreshJavaDialog();
    });
}
wireJavaPicker(javaPngPick, javaPngInput, (file) => { pendingPng = file; });
wireJavaPicker(javaJsonPick, javaJsonInput, (file) => { pendingJson = file; });

javaImportBtn.addEventListener('click', () => {
    upsertPixelEntry(entryNameFromFile(pendingPng!), {
        pngFile: pendingPng!,
        jsonFile: pendingJson!,
        bedrockPage: null,
    });
    renderFontList();
    inputsChanged(); // the dialog lives outside #left-col, so nothing bubbled
    javaDialog.close();
});

// Bedrock texture flow: multi-select glyph_XX.png pages; each file's _XX hex
// suffix names the Unicode page and implies the whole char grid.
bedrockBtn.addEventListener('click', () => bedrockInput.click());
bedrockInput.addEventListener('change', () => {
    const list = bedrockInput.files;
    if (list !== null) importBedrockTextures(list);
    bedrockInput.value = '';
});

function importBedrockTextures(list: FileList): void {
    const skipped: string[] = [];
    let imported = 0;
    let default8 = false;
    for (const file of list) {
        if (!/\.png$/i.test(file.name)) continue;
        // default8.png is the client's own ASCII-ish sheet: its grid is a fixed
        // char set, not a Unicode page, so import it like a Java texture pair
        // with the hardcoded grid standing in for the uploaded .json.
        if (/^default8\.png$/i.test(file.name)) {
            upsertPixelEntry(entryNameFromFile(file), {
                pngFile: file,
                jsonFile: default8CharsFile(),
                bedrockPage: null,
            });
            default8 = true;
            continue;
        }
        const m = /_([0-9A-Fa-f]{2})\.png$/.exec(file.name);
        if (m === null) {
            skipped.push(file.name);
            continue;
        }
        upsertPixelEntry(entryNameFromFile(file), {
            pngFile: file,
            jsonFile: null,
            bedrockPage: parseInt(m[1], 16),
        });
        imported += 1;
    }
    renderFontList();
    if (skipped.length > 0) {
        alert(`名前に「_XX」形式のページ番号を含まない${skipped.length}個のファイルをスキップしました:\n${skipped.slice(0, 8).join('\n')}${skipped.length > 8 ? '\n…' : ''}`);
    }
    if (imported > 0) {
        logLine('info', `Added ${imported} Bedrock texture page${imported === 1 ? '' : 's'}; character grids derived from page ids.`);
    }
    if (default8) {
        logLine('info', 'Added default8.png with its hardcoded character grid.');
    }
}

/** The chars grid a Bedrock glyph page implies: row-major 16×16 covering the
 *  whole page (page*0x100 .. page*0x100+0xFF). */
function bedrockCharsJson(page: number): Uint8Array {
    const rows: string[] = [];
    for (let r = 0; r < 16; ++r) {
        let row = '';
        for (let col = 0; col < 16; ++col) {
            row += String.fromCharCode(page * 0x100 + r * 16 + col);
        }
        rows.push(row);
    }
    return new TextEncoder().encode(JSON.stringify({ chars: rows }));
}

/** The fixed 16×16 char grid of the client's default8.png sheet (same table as
 *  UniversalJavaFont's scripts/default/default8.json). */
const DEFAULT8_CHARS = [
    '\u00C0\u00C1\u00C2\u00C8\u00CA\u00CB\u00CD\u00D3\u00D4\u00D5\u00DA\u00DF\u00E3\u00F5\u011F\u0130',
    '\u0131\u0152\u0153\u015E\u015F\u0174\u0175\u017E\u0207\u00A7\u00A9\u2122\u24C7\u0000\u0000\u0000',
    '\u0000!"#$%&\'()*+,-./',
    '0123456789:;<=>?',
    '@ABCDEFGHIJKLMNO',
    'PQRSTUVWXYZ[\\]^_',
    '`abcdefghijklmno',
    'pqrstuvwxyz{|}~\u2302',
    '\u00C7\u00FC\u00E9\u00E2\u00E4\u00E0\u00E5\u00E7\u00EA\u00EB\u00E8\u00EF\u00EE\u00EC\u00C4\u00C5',
    '\u00C9\u00E6\u00C6\u00F4\u00F6\u00F2\u00FB\u00F9\u00FF\u00D6\u00DC\u00F8\u00A3\u00D8\u00D7\u0192',
    '\u00E1\u00ED\u00F3\u00FA\u00F1\u00D1\u00AA\u00BA\u00BF\u00AE\u00AC\u00BD\u00BC\u00A1\u00AB\u00BB',
    '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510',
    '\u2514\u2534\u252C\u251C\u2500\u253C\u255E\u255F\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567',
    '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256B\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580',
    '\u03B1\u03B2\u0393\u03C0\u03A3\u03C3\u03BC\u03C4\u03A6\u0398\u03A9\u03B4\u221E\u2205\u2208\u2229',
    '\u2261\u00B1\u2265\u2264\u2320\u2321\u00F7\u2248\u00B0\u2219\u00B7\u221A\u207F\u00B2\u25A0\u0000',
];

/** Stands in for the .json a Java texture pair would carry, so a default8.png
 *  import follows the ordinary uploaded-char-grid path from here on. */
function default8CharsFile(): File {
    const json = JSON.stringify({ chars: DEFAULT8_CHARS });
    return new File([json], 'default8.json', { type: 'application/json' });
}

// --- Width-override table ---------------------------------------------------

function renderOverrideTable(): void {
    overrideBody.innerHTML = '';
    exportOverridesBtn.disabled = overrideRows.length === 0;
    overrideStatus.textContent = `${overrideRows.length}項目`;

    overrideRows.forEach((row, i) => {
        const tr = document.createElement('tr');

        const mkChar = (value: number, onInput: (v: number) => void) => {
            const td = document.createElement('td');
            const input = document.createElement('input');
            input.type = 'text';
            input.value = String.fromCharCode(value);
            input.addEventListener('change', () => {
                // Java reads charAt(0); anything past the first char is ignored there too.
                if (input.value.length > 0) onInput(input.value.charCodeAt(0));
                else input.value = String.fromCharCode(row.from);
            });
            td.appendChild(input);
            return td;
        };

        const mkWidth = () => {
            const td = document.createElement('td');
            const input = document.createElement('input');
            input.type = 'number';
            input.step = 'any';
            input.value = String(row.width);
            input.addEventListener('change', () => {
                const v = Number(input.value);
                if (Number.isFinite(v)) row.width = v;
            });
            td.appendChild(input);
            return td;
        };

        const delTd = document.createElement('td');
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn';
        del.textContent = '✕';
        del.title = 'remove range';
        del.addEventListener('click', () => {
            overrideRows.splice(i, 1);
            renderOverrideTable();
            inputsChanged();
        });
        delTd.appendChild(del);

        tr.append(
            mkChar(row.from, (v) => { row.from = v; }),
            mkChar(row.to, (v) => { row.to = v; }),
            mkWidth(),
            delTd,
        );
        overrideBody.appendChild(tr);
    });
}

addOverrideBtn.addEventListener('click', () => {
    overrideRows.push({ from: 0x20, to: 0x20, width: 4 });
    renderOverrideTable();
    inputsChanged();
});

/** Parses an overrides JSON file ({overrides:[{from,to,width}]}) with the same
 *  semantics as the Java loader: from/to are single characters, not hex. */
function parseOverridesJson(text: string): OverrideRange[] {
    const json: unknown = JSON.parse(text);
    const arr = (json as Record<string, unknown>)['overrides'];
    if (!Array.isArray(arr)) throw new Error('"overrides" is not an array');
    const rows: OverrideRange[] = [];
    for (const el of arr) {
        const o = el as Record<string, unknown>;
        const from = String(o['from']);
        const to = String(o['to']);
        const width = Number(o['width']);
        if (from.length === 0 || to.length === 0 || !Number.isFinite(width)) {
            throw new Error('malformed override entry');
        }
        rows.push({ from: from.charCodeAt(0), to: to.charCodeAt(0), width });
    }
    return rows;
}

function encodeOverrides(): Uint8Array {
    const doc = {
        overrides: overrideRows.map((r) => ({
            from: String.fromCharCode(r.from),
            to: String.fromCharCode(r.to),
            width: r.width,
        })),
    };
    return new TextEncoder().encode(JSON.stringify(doc, null, 4));
}

importOverridesBtn.addEventListener('click', () => overridesInput.click());
overridesInput.addEventListener('change', async () => {
    const file = overridesInput.files?.[0];
    overridesInput.value = '';
    if (!file) return;
    try {
        overrideRows.splice(0, overrideRows.length, ...parseOverridesJson(await file.text()));
        renderOverrideTable();
        logLine('info', `Imported ${overrideRows.length} width override ranges from ${file.name}.`);
    } catch (e) {
        alert(`Could not import width overrides: ${(e as Error).message}`);
    }
});

exportOverridesBtn.addEventListener('click', () => {
    download(OVERRIDES_PATH, JSON.stringify({
        overrides: overrideRows.map((r) => ({
            from: String.fromCharCode(r.from),
            to: String.fromCharCode(r.to),
            width: r.width,
        })),
    }, null, 4), 'application/json');
});

// --- Font list rendering ----------------------------------------------------

function renderFontList(): void {
    fontList.innerHTML = '';
    fontList.classList.toggle('empty', fonts.length === 0);
    exportConfigBtn.disabled = fonts.length === 0;
    for (let i = 0; i < fonts.length; ++i) {
        fontList.appendChild(renderEntryRow(i));
    }
}

function renderEntryRow(i: number): HTMLLIElement {
    const f = fonts[i];
    const li = document.createElement('li');
    li.className = 'font-entry';

    const move = (delta: number) => {
        const j = i + delta;
        if (j < 0 || j >= fonts.length) return;
        [fonts[i], fonts[j]] = [fonts[j], fonts[i]];
        renderFontList();
        inputsChanged();
    };
    const mkMoveButtons = (): HTMLButtonElement[] => {
        const up = document.createElement('button');
        up.type = 'button'; up.className = 'icon-btn'; up.textContent = '▲'; up.title = 'move up';
        up.addEventListener('click', () => move(-1));
        const down = document.createElement('button');
        down.type = 'button'; down.className = 'icon-btn'; down.textContent = '▼'; down.title = 'move down';
        down.addEventListener('click', () => move(1));
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'icon-btn'; del.textContent = '✕'; del.title = 'remove';
        del.addEventListener('click', () => { fonts.splice(i, 1); renderFontList(); inputsChanged(); });
        return [up, down, del];
    };

    const mkNum = (labelText: string, value: number, onInput: (v: number) => void) => {
        const label = document.createElement('label');
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.value = String(value);
        input.addEventListener('change', () => {
            const v = Number(input.value);
            if (Number.isFinite(v)) onInput(v);
        });
        li.append(label, input);
    };

    /** Glyph-offset GUI vs the raw additionalArgs field, switched per entry.
     *  Both views edit the same `f.args` string: the GUI reads/writes only its
     *  -pxtranslate fragment, raw mode is the string as config.json stores it. */
    const mkArgsControls = () => {
        const guiSpan = document.createElement('span');
        guiSpan.className = 'args-gui';

        const mkOffset = (axis: 'x' | 'y'): HTMLInputElement => {
            const label = document.createElement('label');
            label.textContent = axis === 'x' ? 'off x' : 'off y';
            label.title = axis === 'x'
                ? 'horizontal glyph offset in px (-pxtranslate x) — positive moves right'
                : 'vertical glyph offset in px (-pxtranslate y) — positive moves up';
            const input = document.createElement('input');
            input.type = 'number';
            input.step = 'any';
            input.className = 'offset';
            input.addEventListener('change', () => commitOffsets());
            guiSpan.append(label, input);
            return input;
        };
        const xIn = mkOffset('x');
        const yIn = mkOffset('y');

        // Anything besides the offset fragment still lives in args — surfaced
        // read-only here so switching to GUI mode can't silently hide it.
        const otherHint = document.createElement('span');
        otherHint.className = 'hint other-args';
        guiSpan.appendChild(otherHint);

        const rawIn = document.createElement('input');
        rawIn.className = 'args';
        rawIn.placeholder = 'additional msdfgen args';
        rawIn.spellcheck = false;
        rawIn.title = 'all additional msdfgen arguments, passed through verbatim';
        rawIn.addEventListener('change', () => { f.args = rawIn.value; syncFromArgs(); });

        function syncFromArgs(): void {
            const t = parsePxTranslate(f.args);
            xIn.value = t?.x ?? '';
            yIn.value = t?.y ?? '';
            rawIn.value = f.args;
            const rest = withoutPxTranslate(f.args);
            otherHint.textContent = rest === '' ? '' : `other args: ${rest}`;
        }

        function commitOffsets(): void {
            const prev = parsePxTranslate(f.args);
            const xs = xIn.value.trim();
            const ys = yIn.value.trim();
            if (xs === '' && ys === '') {
                f.args = withoutPxTranslate(f.args); // both cleared: drop the offset
            } else {
                // One field cleared keeps its previous value; garbage reverts too.
                const okX = xs !== '' && Number.isFinite(Number(xs));
                const okY = ys !== '' && Number.isFinite(Number(ys));
                f.args = withPxTranslate(f.args, okX ? xs : prev?.x ?? '0', okY ? ys : prev?.y ?? '0');
            }
            syncFromArgs();
        }

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'icon-btn args-toggle';
        toggle.textContent = f.argsGui ? 'raw' : 'gui';
        toggle.title = f.argsGui
            ? 'edit the raw msdfgen arguments instead'
            : 'back to simple glyph-offset inputs';
        toggle.addEventListener('click', () => {
            f.argsGui = !f.argsGui;
            renderFontList(); // rebuilds this row in the other mode
        });

        guiSpan.hidden = !f.argsGui;
        rawIn.hidden = f.argsGui;
        li.append(guiSpan, rawIn, toggle);

        syncFromArgs();
    };

    const mkNameInput = (title: string) => {
        const input = document.createElement('input');
        input.className = 'name-input';
        input.type = 'text';
        input.value = f.name;
        input.title = title;
        input.spellcheck = false;
        input.addEventListener('change', () => { f.name = input.value.trim(); input.value = f.name; });
        li.appendChild(input);
    };

    if (f.kind === 'file') {
        if (f.file === null) {
            const chip = document.createElement('span');
            chip.className = 'missing-chip';
            chip.textContent = '⚠ file missing';
            chip.title = 're-add the TTF/OTF to fill this placeholder';
            li.appendChild(chip);
        }
        mkNameInput('TTF/OTF filename as referenced by the config');
        mkNum('size', f.size, (v) => { f.size = v; });
        mkNum('padding', f.padding, (v) => { f.padding = v; });
        mkArgsControls();
    } else {
        const missing = [
            f.pngFile === null ? '.png' : null,
            f.jsonFile === null && f.bedrockPage === null ? '.json' : null,
        ].filter((s): s is string => s !== null);
        if (missing.length > 0) {
            const chip = document.createElement('span');
            chip.className = 'missing-chip';
            chip.textContent = `⚠ missing ${missing.join(' + ')}`;
            chip.title = 'upload the sheet pair to fill this placeholder';
            li.appendChild(chip);
        }
        mkNameInput('Sheet pair path under pixel/, extensionless (e.g. unicode/unicode_05)');
        mkNum('scale', f.scale, (v) => { f.scale = v; });
        mkNum('pad', f.internalPadding, (v) => { f.internalPadding = v; });
        mkNum('ext', f.externalPadding, (v) => { f.externalPadding = v; });
        mkNum('space', f.spaceWidth, (v) => { f.spaceWidth = v; });
        mkArgsControls();

        /*
        const ovrLabel = document.createElement('label');
        ovrLabel.textContent = 'ovr';
        ovrLabel.title = 'apply the width-override table below';
        const ovr = document.createElement('input');
        ovr.type = 'checkbox';
        ovr.checked = f.useOverrides;
        ovr.addEventListener('change', () => { f.useOverrides = ovr.checked; });
        li.append(ovrLabel, ovr);
        */
    }

    li.append(...mkMoveButtons());
    return li;
}

// --- Page remapping ---------------------------------------------------------

function parseRemapTextarea(text: string): PageRemap[] | null {
    try {
        const json: unknown = JSON.parse(text);
        if (!Array.isArray(json)) return null;
        const out: PageRemap[] = [];
        for (const item of json) {
            if (typeof item !== 'object' || item === null) return null;
            const o = item as Record<string, unknown>;
            const from = parseInt(String(o['from']), 16);
            const to = parseInt(String(o['to']), 16);
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 0xff) return null;
            out.push({ from, to });
        }
        return out;
    } catch {
        return null;
    }
}

function refreshRemapStatus(): void {
    const remaps = parseRemapTextarea(pageRemapArea.value);
    remapStatus.textContent = remaps === null
        ? '⚠ 無効なJSON'
        : `${remaps.length}項目`;
}

pageRemapArea.addEventListener('input', () => {
    refreshRemapStatus();
    inputsChanged();
});
presetHangulBtn.addEventListener('click', () => {
    pageRemapArea.value = JSON.stringify(HANGUL_PRESET, null, 4);
    refreshRemapStatus();
    inputsChanged();
});
clearRemapsBtn.addEventListener('click', () => {
    pageRemapArea.value = '';
    refreshRemapStatus();
    inputsChanged();
});

// --- Config import/export ---------------------------------------------------

function collectConfigJson(): Record<string, unknown> {
    const fromPage = parseInt(rangeFrom.value.trim(), 16);
    const toPage = parseInt(rangeTo.value.trim(), 16);
    if (!Number.isInteger(fromPage) || !Number.isInteger(toPage) || fromPage < 0 || toPage > 0xff || fromPage > toPage) {
        throw new Error(`invalid page range ${rangeFrom.value}–${rangeTo.value} (hex 00–FF, from ≤ to)`);
    }
    const remaps = parseRemapTextarea(pageRemapArea.value);
    if (remaps === null) throw new Error('マッピング設定がJSON配列ではありません');

    const config: Record<string, unknown> = {
        range: { from: hex2(fromPage), to: hex2(toPage) },
        threads: Math.max(1, Math.trunc(Number(threadsInput.value)) || 4),
        fonts: fonts.map((f) => {
            if (f.kind === 'file') {
                const entry: Record<string, unknown> = { type: 'file', file: f.name, size: f.size };
                if (f.padding !== 0) entry['padding'] = f.padding;
                if (f.args !== '') entry['additionalArgs'] = f.args;
                if (f.vanillaStyle) entry['vanillaStyle'] = true;
                return entry;
            }
            // Keys mirror the Java schema; defaults are omitted like hand-written configs.
            const entry: Record<string, unknown> = { type: 'pixel', name: f.name };
            if (f.scale !== 1) entry['scale'] = f.scale;
            if (f.internalPadding !== 1) entry['padding'] = f.internalPadding;
            if (f.externalPadding !== 0) entry['externalPadding'] = f.externalPadding;
            if (f.spaceWidth !== 4) entry['spaceWidth'] = f.spaceWidth;
            if (f.useOverrides) entry['widthOverride'] = OVERRIDES_PATH;
            if (f.args !== '') entry['additionalArgs'] = f.args;
            return entry;
        }),
    };
    if (remaps.length > 0) {
        config['pageRemapping'] = remaps.map((r) => ({ from: hex2(r.from), to: hex2(r.to) }));
    }
    if (remapHangul.checked) {
        config['remapHangulChars'] = true;
    }
    return config;
}

exportConfigBtn.addEventListener('click', () => {
    try {
        download('config.json', JSON.stringify(collectConfigJson(), null, 4), 'application/json');
    } catch (e) {
        alert((e as Error).message);
    }
});

interface ImportedPixelSettings {
    scale: number;
    internalPadding: number;
    externalPadding: number;
    spaceWidth: number;
    args: string;
    useOverrides: boolean;
}

importConfigBtn.addEventListener('click', () => configInput.click());
configInput.addEventListener('change', async () => {
    const file = configInput.files?.[0];
    configInput.value = '';
    if (!file) return;
    try {
        const parsed = parseConfig(JSON.parse(await file.text()), logger());
        rangeFrom.value = hex2(Math.trunc(parsed.range.start / 0x100));
        rangeTo.value = hex2(Math.trunc(parsed.range.end / 0x100));
        threadsInput.value = String(parsed.threads);
        remapHangul.checked = parsed.remapHangulChars;
        pageRemapArea.value = parsed.pageRemapping.length > 0
            ? JSON.stringify(parsed.pageRemapping.map((r) => ({ from: hex2(r.from), to: hex2(r.to) })), null, 4)
            : '';
        refreshRemapStatus();

        // Merge font entries by kind+name: existing entries keep their uploaded
        // bytes and just take the config's numbers; unknown ones become
        // placeholders marked ⚠ until their files are uploaded.
        let updated = 0;
        let added = 0;
        let foreignOverridePaths = 0;

        const pixelSettings = (info: Extract<typeof parsed.fonts[number], { kind: 'pixel' }>): ImportedPixelSettings => ({
            scale: info.scale,
            internalPadding: info.internalPadding,
            externalPadding: info.padding,
            spaceWidth: info.spaceWidth,
            args: info.additionalArgs,
            useOverrides: info.widthOverride !== null,
        });

        for (const info of parsed.fonts) {
            if (info.kind === 'file') {
                const existing = fonts.find((f): f is FileFontEntry => f.kind === 'file' && f.name === info.filename);
                if (existing) {
                    Object.assign(existing, {
                        size: info.fontSize,
                        padding: info.padding,
                        args: info.additionalArgs,
                        vanillaStyle: info.vanillaStyle ?? true, // app default for Java-style configs
                    });
                    updated += 1;
                    continue;
                }
                fonts.push({
                    kind: 'file',
                    id: nextEntryId++,
                    file: null,
                    name: info.filename,
                    size: info.fontSize,
                    padding: info.padding,
                    args: info.additionalArgs,
                    argsGui: true,
                    vanillaStyle: info.vanillaStyle ?? true,
                });
                added += 1;
            } else {
                if (info.widthOverride !== null && info.widthOverride !== OVERRIDES_PATH) foreignOverridePaths += 1;
                const existing = fonts.find((f): f is PixelFontEntry => f.kind === 'pixel' && f.name === info.name);
                if (existing) {
                    Object.assign(existing, pixelSettings(info));
                    updated += 1;
                    continue;
                }
                fonts.push({
                    kind: 'pixel',
                    id: nextEntryId++,
                    jsonFile: null,
                    pngFile: null,
                    bedrockPage: null,
                    name: info.name,
                    argsGui: true,
                    ...pixelSettings(info),
                });
                added += 1;
            }
        }

        renderFontList();
        inputsChanged();
        logLine('info', `Imported settings from ${file.name}: ${updated} entr${updated === 1 ? 'y' : 'ies'} updated, ${added} added.`);
        const missingCount = fonts.filter((f) =>
            (f.kind === 'file' && f.file === null) ||
            (f.kind === 'pixel' && (f.jsonFile === null || f.pngFile === null))).length;
        if (missingCount > 0) {
            logLine('warn', `${missingCount} font entr${missingCount === 1 ? 'y has no file yet' : 'ies have no files yet'} (marked ⚠) — upload them above.`);
        }
        if (foreignOverridePaths > 0) {
            logLine('info', `Some entries reference their own width-override files — import those into the width-overrides table (entries stay pointed at the shared table here).`);
        }
    } catch (e) {
        alert(`Could not import config: ${(e as Error).message}`);
    }
});

// --- Generation ----------------------------------------------------------------

generateBtn.addEventListener('click', () => {
    void generate();
});

function mapSource(map: Map<string, Uint8Array>): FileSource {
    return {
        readFile: (path) => map.get(path) ?? null,
    };
}

function validateInputs(): string[] {
    const problems: string[] = [];
    if (fonts.length === 0) problems.push('フォントがありません');
    for (const f of fonts) {
        if (f.kind === 'file') {
            if (f.file === null) problems.push(`TTF/OTF "${f.name}" has not been uploaded`);
        } else {
            if (f.pngFile === null) problems.push(`bitmap sheet "${f.name}.png" has not been uploaded`);
            if (f.jsonFile === null && f.bedrockPage === null) {
                problems.push(`bitmap sheet "${f.name}" has no char grid (.json)`);
            }
            if (f.useOverrides && overrideRows.length === 0) {
                problems.push(`"${f.name}" uses width overrides but the table is empty`);
            }
        }
    }
    return problems;
}

function invalidateFileMap(): void {
    cachedFileMap = null;
}

async function buildFileMap(): Promise<Map<string, Uint8Array>> {
    if (cachedFileMap !== null) return cachedFileMap;
    const fileMap = new Map<string, Uint8Array>();
    let usesOverrides = false;
    for (const f of fonts) {
        if (f.kind === 'file') {
            fileMap.set(`fonts/${f.name}`, new Uint8Array(await f.file!.arrayBuffer()));
        } else {
            if (f.jsonFile !== null) {
                fileMap.set(`pixel/${f.name}.json`, new Uint8Array(await f.jsonFile.arrayBuffer()));
            } else {
                // Bedrock texture: the char grid follows from the page id.
                fileMap.set(`pixel/${f.name}.json`, bedrockCharsJson(f.bedrockPage!));
            }
            fileMap.set(`pixel/${f.name}.png`, new Uint8Array(await f.pngFile!.arrayBuffer()));
            if (f.useOverrides) usesOverrides = true;
        }
    }
    if (usesOverrides) {
        fileMap.set(OVERRIDES_PATH, encodeOverrides());
    }
    cachedFileMap = fileMap;
    return fileMap;
}

/** Serialized so two overlapping preview renders can't race pool creation and
 *  orphan a set of WASM workers. */
let poolTask: Promise<MsdfgenPool> = Promise.resolve(null as unknown as MsdfgenPool);

function ensurePool(threadCount: number): Promise<MsdfgenPool> {
    poolTask = poolTask.catch(() => { /* keep the chain alive after failures */ }).then(async () => {
        if (pool !== null && poolThreads === threadCount) return pool;
        pool?.terminateAll();
        pool = await MsdfgenPool.create(threadCount);
        poolThreads = threadCount;
        return pool;
    });
    return poolTask;
}

function currentThreadCount(): number {
    return Math.max(1, Math.trunc(Number(threadsInput.value)) || 4);
}

function updateGenerateButton(): void {
    generateBtn.disabled = previewBusy || exportRunning;
}

// --- Page preview ---------------------------------------------------------------

const pageView = new PageView(el('page-section', 'section'), {
    loadPage: (page) => loadPageForPreview(page),
    widthOf,
    setManualWidth: (charId, px) => {
        if (px === null) manualWidths.delete(charId);
        else if (Number.isFinite(px) && px >= 0) manualWidths.set(charId, Math.max(0, px));
        else return;
        refreshGlyphEditor();
    },
    selectionChanged: () => refreshGlyphEditor(),
    dragWidth: (charId, px) => {
        if (pageView.getSelected() !== charId) return;
        if (px === null) {
            refreshGlyphEditor();
            return;
        }
        if (document.activeElement !== glyphWidthInput) glyphWidthInput.value = trimNum(px);
    },
    busyChanged: (busy) => {
        previewBusy = busy;
        updateGenerateButton();
    },
});

/** Renders one page for the preview: a single-page run through the same
 *  pipeline as a full generation (same skip rules, same remapping). The viewer
 *  addresses pages by their ON-SCREEN id — with remapping, slot D shows the
 *  glyphs of whichever source page maps onto D. */
async function loadPageForPreview(page: number): Promise<PageLoadResult> {
    if (exportRunning) {
        return { ok: false, reason: 'pack generation is running — try again once it finishes' };
    }
    const problems = validateInputs();
    if (problems.length > 0) {
        return { ok: false, reason: problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more)` : '') };
    }
    let configJson: Record<string, unknown>;
    try {
        configJson = collectConfigJson();
    } catch (e) {
        return { ok: false, reason: (e as Error).message };
    }

    const token = ++previewToken;
    previewCancelled = false;
    acquireOverlay(`ページ ${hex2(page)} をレンダリング中`);
    try {
        const msdfgen = await ensurePool(currentThreadCount());
        const fileMap = await buildFileMap();

        const remaps = parseRemapTextarea(pageRemapArea.value) ?? [];
        let sourcePage: number | null = null;
        for (const r of remaps) {
            if (r.to === page && (sourcePage === null || r.from > sourcePage)) sourcePage = r.from;
        }
        if (sourcePage === null) sourcePage = page;

        const remapOfPage = (p: number): number => {
            for (const r of remaps) if (r.from === p) return r.to;
            return p;
        };
        const isTargetPage = (p: number): boolean => remaps.some((r) => r.to === p);

        const output = await runGeneration({
            configJson,
            files: mapSource(fileMap),
            msdfgen,
            log: logger(),
            onlyPage: sourcePage,
            keepRawPages: true,
            onProgress: (done, total) => setOverlayProgress(done, total, `${done} / ${total} glyphs`),
            isCancelled: () => previewCancelled || token !== previewToken,
        });

        const pd = output.pages[0];
        if (pd === undefined || pd.atlasRgba === undefined || pd.glyphWidths === undefined) {
            // Mirror the generator's skip rules for a human-readable reason.
            const sp = sourcePage;
            if (!(remaps.some((r) => r.from === sp) || !isTargetPage(sp))) {
                return { ok: false, reason: `another page remaps onto page ${hex2(sp)}` };
            }
            if (!isPageSupported(remapOfPage(sp))) {
                let reason = `the client does not load page ${hex2(sp)}`;
                const landsOn = remapOfPage(sp);
                if (landsOn !== sp) reason += ` — its glyphs end up on page ${hex2(landsOn)} instead`;
                return { ok: false, reason };
            }
            return { ok: false, reason: 'this page was skipped' };
        }

        const note = sourcePage !== page
            ? `page ${hex2(page)} · glyphs rendered from source page ${hex2(sourcePage)} (remapped)`
            : undefined;
        return { ok: true, data: { rgba: pd.atlasRgba, widths: pd.glyphWidths }, note };
    } catch (e) {
        if (e instanceof CancelledError || token !== previewToken) return { ok: false, reason: 'cancelled' };
        logLine('error', `Page render failed: ${(e as Error).message}`);
        return { ok: false, reason: `render failed: ${(e as Error).message}` };
    } finally {
        releaseOverlay();
    }
}

// --- Glyph width editor ------------------------------------------------------

function computedWidthPx(charId: number): number {
    const data = pageView.getCurrentData();
    if (data === null || (charId >> 8) !== pageView.currentPage) return 0;
    return data.widths[charId & 0xFF] * 64; // fontdata 1.0 == the full 64px box
}

function widthOf(charId: number): number {
    return manualWidths.get(charId) ?? computedWidthPx(charId);
}

/** The char a cell really represents: with page remapping, slot D holds the
 *  source page's characters, so U+0500 shows under display page AC. */
function realCharCode(displayCharId: number): number {
    const dispPage = displayCharId >> 8;
    const remaps = parseRemapTextarea(pageRemapArea.value) ?? [];
    let srcPage: number | null = null;
    for (const r of remaps) {
        if (r.to === dispPage && (srcPage === null || r.from > srcPage)) srcPage = r.from;
    }
    return (srcPage ?? dispPage) * 0x100 + (displayCharId & 0xFF);
}

function describeChar(c: number): string {
    const hex = `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
    if (c === 0x20) return `${hex} '␣' (スペース)`;
    if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return `${hex} (制御文字)`;
    return `${hex} '${String.fromCharCode(c)}'`;
}

function refreshGlyphEditor(): void {
    const sel = pageView.getSelected();
    if (sel === null) {
        glyphSection.hidden = true;
        return;
    }
    glyphSection.hidden = false;
    const real = realCharCode(sel);
    const viaRemap = (real >> 8) !== (sel >> 8) ? ` · from page ${hex2(real >> 8)}` : '';
    glyphChar.textContent = `${describeChar(real)}${viaRemap}`;
    const manual = manualWidths.get(sel);
    glyphComputed.textContent = `自動検出 = ${trimNum(computedWidthPx(sel))} px${manual !== undefined ? ' · edited' : ''}`;
    if (document.activeElement !== glyphWidthInput) glyphWidthInput.value = trimNum(widthOf(sel));
}

glyphWidthInput.addEventListener('change', () => {
    const sel = pageView.getSelected();
    if (sel === null) return;
    const v = Number(glyphWidthInput.value);
    if (!Number.isFinite(v) || v < 0) {
        glyphWidthInput.value = trimNum(widthOf(sel)); // uncapped upward, but never negative
        return;
    }
    manualWidths.set(sel, v);
    refreshGlyphEditor();
    pageView.redraw();
});

glyphResetBtn.addEventListener('click', () => {
    const sel = pageView.getSelected();
    if (sel === null) return;
    manualWidths.delete(sel);
    refreshGlyphEditor();
    pageView.redraw();
});

glyphCloseBtn.addEventListener('click', () => pageView.deselect());

// --- Pack export ----------------------------------------------------------------

/** Writes the manually edited widths into the generated .fontdata buffers.
 *  A char's width lands on its REMAPPED output page, exactly where the client
 *  looks it up (remapping.dat sends lookups for the source page there). */
function applyManualWidths(files: Map<string, Uint8Array>): void {
    if (manualWidths.size === 0) return;
    const remaps = parseRemapTextarea(pageRemapArea.value) ?? [];
    const remapOf = new Map(remaps.map((r) => [r.from, r.to]));
    let patched = 0;
    for (const [charId, px] of manualWidths) {
        const srcPage = charId >> 8;
        const outPage = remapOf.get(srcPage) ?? srcPage;
        const fd = files.get(`smooth/smooth_${hex2(outPage)}.fontdata`);
        if (fd === undefined) continue;
        const dv = new DataView(fd.buffer, fd.byteOffset, fd.byteLength);
        const pos = 4 + 4 * (charId & 0xFF);
        if (pos + 4 > fd.byteLength) continue;
        dv.setFloat32(pos, f32(Math.max(0, px) / 64), true);
        patched += 1;
    }
    if (patched > 0) {
        logLine('info', `Applied ${patched} manually edited glyph width${patched === 1 ? '' : 's'} to the .fontdata files.`);
    }
}

async function generate(): Promise<void> {
    if (exportRunning || previewBusy) return;

    let configJson: Record<string, unknown>;
    const problems = validateInputs();
    if (problems.length > 0) {
        alert(`生成できません:\n- ${problems.join('\n- ')}`);
        return;
    }
    try {
        configJson = collectConfigJson();
    } catch (e) {
        alert((e as Error).message);
        return;
    }

    exportRunning = true;
    exportCancelled = false;
    updateGenerateButton();
    resultSection.hidden = true;
    logPre.textContent = '';
    acquireOverlay('Generating pack');

    try {
        invalidateFileMap();
        const fileMap = await buildFileMap();
        const output = await runGeneration({
            configJson,
            files: mapSource(fileMap),
            msdfgen: await ensurePool(currentThreadCount()),
            log: logger(),
            onProgress: (done, total) => setOverlayProgress(done, total, `${done} / ${total} glyphs`),
            isCancelled: () => exportCancelled,
        });

        applyManualWidths(output.files);

        const meta: PackMeta = {
            name: packName.value.trim() || 'My Smooth Font',
            description: packDesc.value.trim(),
            version: packVersion.value.trim() || '1.0.0',
        };
        const zipBytes = buildPackZip(output.files, meta);
        const zipUrl = URL.createObjectURL(new Blob([new Uint8Array(zipBytes)], { type: 'application/octet-stream' }));
        downloadZip.href = zipUrl;
        downloadZip.download = `${meta.name.replace(/[^\w\- ]+/g, '') || 'pack'}.mcpack`;
        setTimeout(() => URL.revokeObjectURL(zipUrl), 60_000);

        resultSection.hidden = false;
        logLine('info', `Pack ready: ${output.files.size} files.`);
    } catch (e) {
        if (e instanceof CancelledError) {
            logLine('warn', 'Generation cancelled.');
        } else {
            logLine('error', `Generation failed: ${(e as Error).message}`);
        }
    } finally {
        exportRunning = false;
        releaseOverlay();
        updateGenerateButton();
    }
}

// --- Init ---------------------------------------------------------------------

renderFontList();
renderOverrideTable();
refreshRemapStatus(); // the Hangul trick ships enabled in the textarea
void pageView.navigate(0);
