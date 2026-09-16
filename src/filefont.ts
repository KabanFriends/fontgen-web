// Port of FileWrappedFont / TrueTypeWrappedFont / OpenTypeWrappedFont. FontBox
// dispatches by file extension, but both wrapped classes behave identically for the
// metrics used here, so a single implementation covers ttf and otf.

import { f32 } from './javaformat.js';
import { SfntFont, IOException } from './sfnt.js';
import type { FileFontInfoData } from './config.js';
import { GLYPH_DIM, POINTS_TO_SCALE, type RenderRequest, type WrappedFont } from './wrappedfont.js';

/** Default fontSize equivalent to Mojang's heuristic scale: their batch tool
 *  sized every font so ascender..descender filled the 63px glyph cell
 *  (scale = 63 / ((ascender - descender) / 64) in msdfgen shape units).
 *  Inverted through our render formula (fontSize * 1000/upem / 11.75) so the
 *  app can prefill the matching size; null when metrics are unusable. */
export function suggestFontSize(font: SfntFont): number | null {
    try {
        const upem = font.getUnitsPerEm();
        const faceHeight = font.getAscender() - font.getDescender(); // font units
        if (!(faceHeight > 0)) return null;
        return (63 / (faceHeight / 64)) / POINTS_TO_SCALE * upem / 1000;
    } catch (e) {
        if (!(e instanceof IOException)) throw e;
        return null; // no hhea/upem: caller keeps its fallback default
    }
}

export class FileWrappedFontImpl implements WrappedFont {
    private readonly correctionFactor: number; // float32

    constructor(
        private readonly info: FileFontInfoData,
        readonly bytes: Uint8Array,
        private readonly font: SfntFont,
    ) {
        let cf = 1;
        try {
            cf = f32(1000 / font.getUnitsPerEm());
        } catch (e) {
            if (!(e instanceof IOException)) throw e;
            cf = 1;
        }
        this.correctionFactor = cf;
    }

    getFontInfo(): FileFontInfoData {
        return this.info;
    }

    getWidth(charId: number): number {
        // advanceWidth * fontSize * 96 / 72 / unitsPerEm / 64 — float32 at every step.
        try {
            const gid = this.font.getGlyphId(charId);
            const advance = this.font.getAdvanceWidth(gid);
            const upem = this.font.getUnitsPerEm();
            const fontSize = this.info.fontSize;
            let v = f32(f32(advance * fontSize) * 96);
            v = f32(v / 72);
            v = f32(v / upem);
            v = f32(v / GLYPH_DIM);
            return v;
        } catch (e) {
            if (!(e instanceof IOException)) throw e;
            return 0;
        }
    }

    hasGlyph(charId: number): boolean {
        try {
            return this.font.hasGlyph(charId);
        } catch (e) {
            if (!(e instanceof IOException)) throw e;
            return false;
        }
    }

    prepareRender(charId: number, outPath: string): RenderRequest {
        // scale = fontSize * correctionFactor * (1/11.75), float32 steps like Java.
        const scaleStr = String(
            f32(f32(this.info.fontSize * this.correctionFactor) * POINTS_TO_SCALE),
        );
        const args = [
            'mtsdf',
            '-font', '/in/font.ttf',
            `0x${charId.toString(16).toUpperCase().padStart(4, '0')}`,
            '-dimensions', String(GLYPH_DIM), String(GLYPH_DIM),
            '-scale', scaleStr,
        ];
        if (this.info.vanillaStyle === true) {
            // Mojang's msdfgen tool fork (vanilla smooth fonts) rendered every
            // page with a wide 8px distance range and framed each cell with the
            // font's own vertical metrics: translate.y = -(hhea descender),
            // putting the descender line at the cell's bottom edge. Glyph
            // coordinates AND metrics share msdfgen's legacy 1/64 font-unit
            // scale, so the baseline is simply -descender/64 in shape units.
            // additionalArgs are appended after these by GlyphPage, so a raw
            // -translate still overrides this one, while -pxtranslate composes
            // with it (msdfgen adds pxTranslate/scale to translate).
            args.push('-pxrange', '8');
            try {
                args.push('-translate', '0', String(-this.font.getDescender() / 64));
            } catch (e) {
                if (!(e instanceof IOException)) throw e; // no hhea: keep glyphs unframed
            }
        }
        args.push('-o', outPath);
        return {
            args,
            files: { '/in/font.ttf': this.bytes },
        };
    }
}
