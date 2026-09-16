// Port of SmoothGenerator: loads config, builds fonts + remap handler, writes
// remapping.dat, and iterates the configured page range with the same skip rules.

import { parseConfig, type ConfigValues } from './config.js';
import { FontHolder, type FileSource, type LoggerLike } from './fontholder.js';
import { RemapHandler } from './remaphandler.js';
import { CancelledError, generateGlyphPage } from './glyphpage.js';
import type { MsdfgenExecutor } from './msdfgen.js';
import { isPageSupported } from './pageutil.js';

export interface GenerationInputs {
    /** Parsed config.json content. */
    configJson: unknown;
    files: FileSource;
    msdfgen: MsdfgenExecutor;
    log: LoggerLike;
    /** Glyph-level progress; totals are known upfront because page skip rules are pure. */
    onProgress?: (done: number, total: number) => void;
    /** Polled between pages and before each glyph render. */
    isCancelled?: () => boolean;
    /** Restricts generation to this single Unicode page (same skip rules),
     *  ignoring the configured range — used by the app's page preview. */
    onlyPage?: number;
    /** Also collect raw atlas pixels + per-glyph widths per generated page
     *  (preview support; export runs leave these out to save memory). */
    keepRawPages?: boolean;
}

export interface GeneratedPageData {
    /** Unicode page whose glyphs were rendered (pre-remap source). */
    sourcePage: number;
    /** Remapped output id used in the file names (smooth_XX.*). */
    remappedPage: number;
    atlasRgba?: Uint8Array;
    glyphWidths?: Float32Array;
}

export interface GenerationOutput {
    /** Relative output paths as the Java tool would write them, e.g.
     *  'smooth/remapping.dat', 'smooth/smooth_AC.fontdata'. */
    files: Map<string, Uint8Array>;
    config: ConfigValues;
    /** Per-page data in generation order (only with keepRawPages / always
     *  carrying the page ids; raw buffers only when keepRawPages is set). */
    pages: GeneratedPageData[];
}

export async function runGeneration(inputs: GenerationInputs): Promise<GenerationOutput> {
    const { configJson, files, msdfgen, log } = inputs;

    const config = parseConfig(configJson, log);
    const fontHolder = new FontHolder(config.fonts, files, log);
    const remapHandler = new RemapHandler(config.pageRemapping);

    const outFiles = new Map<string, Uint8Array>();
    const pages: GeneratedPageData[] = [];

    if (fontHolder.getFontCount() === 0) {
        log.error('No valid font files were found, aborting');
        return { files: outFiles, config, pages };
    }

    // remapping.dat is always emitted first (empty file when no remaps are set).
    outFiles.set('smooth/remapping.dat', remapHandler.buildRemappingFile(config.remapHangulChars));

    const range = config.range;
    if (inputs.onlyPage === undefined) {
        log.info(`Range to generate: ${hex4(range.start)}-${hex4(range.end)}`);
    }
    log.info(`Available threads: ${config.threads}`);

    // The page list replaces the old offset/loops pair so a preview can pin one
    // page regardless of the configured range; default order is identical.
    const pageIds: number[] = [];
    if (inputs.onlyPage !== undefined) {
        pageIds.push(inputs.onlyPage);
    } else {
        const offset = Math.trunc(range.start / 0x100);
        const loops = Math.trunc((range.end - range.start) / 0x100);
        for (let p = offset; p <= offset + loops; ++p) pageIds.push(p);
    }

    // Page skip rules only depend on config, so the glyph total is known upfront.
    let totalPages = 0;
    for (const pageId of pageIds) {
        if (remapHandler.canWritePage(pageId) && isPageSupported(remapHandler.remap(pageId))) ++totalPages;
    }
    const totalGlyphs = totalPages * 0x100;
    let doneGlyphs = 0;

    for (let i = 0; i < pageIds.length; ++i) {
        if (inputs.isCancelled?.()) throw new CancelledError();
        const pct = ((i / pageIds.length) * 100).toFixed(2);
        const pageId = pageIds[i];
        const remappedPageId = remapHandler.remap(pageId);
        const label = `[${i + 1}/${pageIds.length} ${pct}%]`;

        if (!remapHandler.canWritePage(pageId)) {
            log.warn(`${label} Skipping ${hex4(pageId * 0x100)}-${hex4(pageId * 0x100 + 0xFF)} (Another page remaps to this page)`);
            continue;
        }
        if (!isPageSupported(remappedPageId)) {
            log.warn(`${label} Skipping ${hex4(pageId * 0x100)}-${hex4(pageId * 0x100 + 0xFF)} (Client does not load this page)`);
            continue;
        }

        log.info(`${label} Generating ${hex4(pageId * 0x100)}-${hex4(pageId * 0x100 + 0xFF)}`);
        const result = await generateGlyphPage(
            {
                fontHolder,
                remapHandler,
                msdfgen,
                showGlyphInfo: config.showGlyphInfo,
                log,
                onProgress: () => inputs.onProgress?.(++doneGlyphs, totalGlyphs),
                isCancelled: inputs.isCancelled,
            },
            pageId,
        );
        const name = `smooth_${hex2(remappedPageId)}`;
        outFiles.set(`smooth/${name}.png`, result.png);
        outFiles.set(`smooth/${name}.fontdata`, result.fontdata);
        pages.push({
            sourcePage: pageId,
            remappedPage: remappedPageId,
            atlasRgba: inputs.keepRawPages ? result.atlasRgba : undefined,
            glyphWidths: inputs.keepRawPages ? result.glyphWidths : undefined,
        });
    }

    log.info('Generation finished');
    return { files: outFiles, config, pages };
}

function hex4(v: number): string {
    return v.toString(16).toUpperCase().padStart(4, '0');
}

function hex2(v: number): string {
    return v.toString(16).toUpperCase().padStart(2, '0');
}
