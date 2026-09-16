// Atlas compositing: paste each 64x64 glyph into its cell of the 1024x1024 atlas.
//
// The Java tool composites through Java2D drawImage into a TYPE_INT_ARGB image, whose
// premultiply/unpremultiply round trip shifts some low-alpha colors by +/-1/255. We do a
// plain copy instead: the Bedrock client samples MTSDF as the median of the three
// channels, where a 1/255 wobble is invisible.

import type { RgbaImage } from './png.js';

export const ATLAS_SIZE = 1024;
export const GLYPH_CELL = 64;
export const ATLAS_GRID = ATLAS_SIZE / GLYPH_CELL; // 16

export interface Atlas {
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array; // RGBA, straight alpha — same layout as RgbaImage
}

export function createAtlas(): Atlas {
    return { width: ATLAS_SIZE, height: ATLAS_SIZE, pixels: new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4) };
}

/** Blits a glyph image at cell (gridX, gridY) like graphics.drawImage(img, gx*64, gy*64). */
export function blitGlyph(atlas: Atlas, gridX: number, gridY: number, img: RgbaImage): void {
    const ox = gridX * GLYPH_CELL;
    const oy = gridY * GLYPH_CELL;
    for (let y = 0; y < img.height && oy + y < atlas.height; ++y) {
        for (let x = 0; x < img.width && ox + x < atlas.width; ++x) {
            const so = (y * img.width + x) * 4;
            if (img.pixels[so + 3] === 0) continue; // SrcOver with a=0 source is a no-op
            const do_ = ((oy + y) * atlas.width + ox + x) * 4;
            atlas.pixels[do_] = img.pixels[so];
            atlas.pixels[do_ + 1] = img.pixels[so + 1];
            atlas.pixels[do_ + 2] = img.pixels[so + 2];
            atlas.pixels[do_ + 3] = img.pixels[so + 3];
        }
    }
}
