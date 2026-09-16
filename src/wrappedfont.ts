// Port of the WrappedFont interface plus the shared POINTS_TO_SCALE constant.
// Rendering requests carry virtual-FS paths consumed by the msdfgen driver
// (/in/<name> for inputs, /out/out.png for the render target), mirroring how the
// Java tool shells out with working-directory-relative paths.

import { f32 } from './javaformat.js';
import type { FontInfoData } from './config.js';

/** 1 / 11.75f — Java computes this in float precision. */
export const POINTS_TO_SCALE = f32(1 / 11.75);

export const GLYPH_DIM = 64;

export interface RenderRequest {
    /** argv for msdfgen, excluding the program name. */
    args: string[];
    /** Input files referenced by args, keyed by virtual path. */
    files: Record<string, Uint8Array>;
}

export interface WrappedFont {
    getFontInfo(): FontInfoData;
    /** float32 result, like Java. */
    getWidth(charId: number): number;
    hasGlyph(charId: number): boolean;
    prepareRender(charId: number, outPath: string): RenderRequest;
}

/** additionalArgs splitting, byte-compatible with GlyphPage: argStr.split(" "). */
export function splitAdditionalArgs(argStr: string): string[] {
    return argStr === '' ? [] : argStr.split(' ');
}
