// Port of PixelWrappedFont / MissingPixelWrappedFont: sheet slicing, the
// rightmost-opaque-pixel width scan, width overrides, and shapedesc render requests.

import { f32 } from './javaformat.js';
import type { PixelFontInfoData, WidthOverride } from './config.js';
import { imageToShapeDesc } from './shapedesc.js';
import type { RgbaImage } from './png.js';
import { GLYPH_DIM, type RenderRequest, type WrappedFont } from './wrappedfont.js';

export class PixelWrappedFont implements WrappedFont {
    protected info: PixelFontInfoData;
    protected readonly fullImage: RgbaImage;
    protected readonly glyphs = new Map<number, RgbaImage>();
    private readonly glyphWidths = new Map<number, number>();
    private readonly widthOverrides: WidthOverride[];
    private readonly gridWidth: number;
    private readonly gridHeight: number;

    /**
     * @param chars empty array selects the "missing" construction path
     *   (Java's protected ctor): fixed 8x8 grid, no sliced glyphs, no width scan.
     */
    constructor(info: PixelFontInfoData, chars: string[], fullImage: RgbaImage, widthOverrides: WidthOverride[]) {
        this.info = info;
        this.fullImage = fullImage;

        if (chars.length === 0) {
            // Java protected ctor: grid hardcoded to 8x8, no slicing, empty width map.
            this.gridWidth = 8;
            this.gridHeight = 8;
            this.widthOverrides = widthOverrides;
            return;
        }

        const length = chars[0].length;
        for (const chars1 of chars) {
            if (chars1.length !== length) {
                throw new Error('All character sets must have the same length');
            }
        }

        // Java integer division on both.
        this.gridWidth = Math.trunc(fullImage.width / length);
        this.gridHeight = Math.trunc(fullImage.height / chars.length);

        for (let y = 0; y < chars.length; ++y) {
            const charsRow = chars[y];
            for (let x = 0; x < charsRow.length; ++x) {
                const c = charsRow.charCodeAt(x);
                const gx = x * this.gridWidth;
                const gy = y * this.gridHeight;
                this.glyphs.set(c, subImage(fullImage, gx, gy, this.gridWidth, this.gridHeight));
            }
        }

        // Width scan: rightmost pixel index with any nonzero alpha, maxed over rows.
        for (const [c, image] of this.glyphs) {
            let maxWidth = 0;
            for (let y = 0; y < image.height; ++y) {
                let width = 0;
                for (let x = 0; x < image.width; ++x) {
                    if (image.pixels[(y * image.width + x) * 4 + 3] !== 0) {
                        width = x;
                    }
                }
                maxWidth = Math.max(maxWidth, width);
            }
            this.glyphWidths.set(c, maxWidth);
        }

        this.widthOverrides = widthOverrides;
    }

    getFontInfo(): PixelFontInfoData {
        return this.info;
    }

    getWidth(charId: number): number {
        let width = this.glyphWidths.get(charId) ?? 0;
        if (charId === 0x20 /* ' ' */) {
            width = this.info.spaceWidth;
        }
        for (const override of this.widthOverrides) {
            if (charId >= override.from && charId <= override.to) {
                width = override.width;
                break;
            }
        }
        // (width + 1 + internalPadding) / gridWidth * scale — float32 at each step.
        const t1 = f32(width + 1);
        const t2 = f32(t1 + this.info.internalPadding);
        const t3 = f32(t2 / this.gridWidth);
        return f32(t3 * this.info.scale);
    }

    getGridWidth(): number {
        return this.gridWidth;
    }

    getGridHeight(): number {
        return this.gridHeight;
    }

    /** 64.0 / gridWidth * scale in double precision. */
    getRenderScale(): number {
        return (64.0 / this.gridWidth) * this.info.scale;
    }

    hasGlyph(charId: number): boolean {
        return this.glyphs.has(charId);
    }

    protected getGlyphImage(charId: number): RgbaImage | undefined {
        return this.glyphs.get(charId);
    }

    prepareRender(charId: number, outPath: string): RenderRequest {
        const hexId = charId.toString(16).toUpperCase().padStart(4, '0');
        const image = this.getGlyphImage(charId);
        if (!image) throw new Error(`no glyph image for U+${hexId} (should be unreachable)`);
        const shapeDesc = imageToShapeDesc(image);
        const vpath = `/in/shape_${hexId}.txt`;
        return {
            args: [
                'mtsdf',
                '-shapedesc', vpath,
                '-dimensions', String(GLYPH_DIM), String(GLYPH_DIM),
                '-scale', String(this.getRenderScale()),
                '-o', outPath,
            ],
            files: { [vpath]: new TextEncoder().encode(shapeDesc) },
        };
    }
}

/**
 * Port of MissingPixelWrappedFont: fixed 8x8 grid showing the bundled missing_char.png
 * for every character, with a constant width.
 */
export class MissingPixelWrappedFont extends PixelWrappedFont {
    constructor(parent: PixelFontInfoData, missingCharImage: RgbaImage) {
        super(
            {
                ...parent,
                name: '#missing',
                widthOverride: null,
            },
            [], // unused: glyphs are overridden below
            missingCharImage,
            [],
        );
    }

    override hasGlyph(_charId: number): boolean {
        return true;
    }

    override getWidth(charId: number): number {
        const t1 = f32(5 + this.info.internalPadding);
        const t2 = f32(t1 / 8);
        return f32(t2 * this.info.scale);
    }

    protected override getGlyphImage(_charId: number): RgbaImage {
        return this.fullImage;
    }
}

function subImage(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
    const pixels = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; ++row) {
        const src = ((y + row) * img.width + x) * 4;
        pixels.set(img.pixels.subarray(src, src + w * 4), row * w * 4);
    }
    return { width: w, height: h, pixels };
}
