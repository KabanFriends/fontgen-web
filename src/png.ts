// Pure-TypeScript PNG codec shared by the browser app and the node-side golden
// harness. Decode covers everything real font sheets and atlas files use: bit
// depths 1/2/4/8, color types 0/2/3/4/6, tRNS, non-interlaced. Encode emits
// 8-bit RGBA (color type 6, filter 0), which is all the pipeline ever writes.
//
// zlib is provided by fflate so the same code runs on node and in browsers.

import { unzlibSync, zlibSync } from 'fflate';

export interface RgbaImage {
    width: number;
    height: number;
    /** RGBA, top-down, straight (non-premultiplied) alpha. */
    pixels: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(data: Uint8Array): RgbaImage {
    if (data.length < 57 || !SIGNATURE.every((b, i) => data[i] === b)) {
        throw new Error('not a PNG file');
    }

    let off = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Uint8Array | null = null; // RGB triplets
    let trns: Uint8Array | null = null; // palette alphas / key color samples
    const idat: Uint8Array[] = [];
    let seenIEND = false;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (off + 8 <= data.length && !seenIEND) {
        const len = view.getUint32(off);
        const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
        const body = data.subarray(off + 8, off + 8 + len);
        switch (type) {
            case 'IHDR':
                width = view.getUint32(off + 8);
                height = view.getUint32(off + 12);
                depth = data[off + 16];
                colorType = data[off + 17];
                if (data[off + 18] !== 0 || data[off + 19] !== 0) throw new Error('unsupported PNG compression/filter method');
                interlace = data[off + 20];
                break;
            case 'PLTE':
                palette = body.slice();
                break;
            case 'tRNS':
                trns = body.slice();
                break;
            case 'IDAT':
                idat.push(body);
                break;
            case 'IEND':
                seenIEND = true;
                break;
        }
        off += 12 + len; // length + type + data + crc
    }
    if (!width || !height) throw new Error('PNG header chunk missing');
    if (interlace === 1) throw new Error('interlaced PNGs are not supported');
    if (interlace !== 0) throw new Error(`unknown interlace method ${interlace}`);

    // Inflate concatenated IDAT streams.
    const total = idat.reduce((n, c) => n + c.length, 0);
    const zdata = new Uint8Array(total);
    let zoff = 0;
    for (const c of idat) {
        zdata.set(c, zoff);
        zoff += c.length;
    }
    const raw = unzlibSync(zdata);

    const channels = COLOR_CHANNELS[colorType];
    if (channels === 0) throw new Error(`unsupported PNG color type ${colorType}`);
    if (![1, 2, 4, 8].includes(depth)) throw new Error(`unsupported PNG bit depth ${depth}`);
    if (colorType === 3 && palette === null) throw new Error('palette PNG missing PLTE chunk');

    // Unfilter into packed scanlines (one byte per sample when depth is 8).
    const bitsPerLine = width * channels * depth;
    const stride = Math.ceil(bitsPerLine / 8);
    const bpp = Math.max(1, Math.trunc((channels * depth) / 8)); // filter unit
    const lines = new Uint8Array(stride * height);
    let src = 0;
    for (let y = 0; y < height; ++y) {
        const filter = raw[src++];
        const line = raw.subarray(src, src + stride);
        const out = lines.subarray(y * stride, (y + 1) * stride);
        unfilterRow(filter, line, out, y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null, bpp);
        src += stride;
    }

    // Expand to RGBA.
    const image: RgbaImage = { width, height, pixels: new Uint8Array(width * height * 4) };
    const px = image.pixels;
    const pal = palette!; // checked above for color type 3
    const maxSample = (1 << depth) - 1;
    for (let y = 0; y < height; ++y) {
        const line = lines.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < width; ++x) {
            const o = (y * width + x) * 4;
            switch (colorType) {
                case 0: { // grayscale (+ optional transparent key)
                    const s = sample(line, x, channels, depth);
                    const v = Math.round((s * 255) / maxSample);
                    px[o] = px[o + 1] = px[o + 2] = v;
                    const key = trns !== null ? (trns[1] & maxSample) : -1; // 16-bit field, low bits significant
                    px[o + 3] = s === key ? 0 : 255;
                    break;
                }
                case 2: { // truecolor (+ optional transparent key)
                    const r = sample(line, x * 3, channels, depth);
                    const g = sample(line, x * 3 + 1, channels, depth);
                    const b = sample(line, x * 3 + 2, channels, depth);
                    px[o] = Math.round((r * 255) / maxSample);
                    px[o + 1] = Math.round((g * 255) / maxSample);
                    px[o + 2] = Math.round((b * 255) / maxSample);
                    const keyed =
                        trns !== null &&
                        r === (trns[1] & maxSample) &&
                        g === (trns[3] & maxSample) &&
                        b === (trns[5] & maxSample);
                    px[o + 3] = keyed ? 0 : 255;
                    break;
                }
                case 3: { // palette
                    const idx = sample(line, x, channels, depth);
                    px[o] = pal[idx * 3];
                    px[o + 1] = pal[idx * 3 + 1];
                    px[o + 2] = pal[idx * 3 + 2];
                    px[o + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
                    break;
                }
                case 4: { // gray + alpha
                    const g = sample(line, x * 2, channels, depth);
                    const a = sample(line, x * 2 + 1, channels, depth);
                    px[o] = px[o + 1] = px[o + 2] = Math.round((g * 255) / maxSample);
                    px[o + 3] = depth === 8 ? a : Math.round((a * 255) / maxSample);
                    break;
                }
                case 6: { // RGBA
                    px[o] = sample(line, x * 4, channels, depth);
                    px[o + 1] = sample(line, x * 4 + 1, channels, depth);
                    px[o + 2] = sample(line, x * 4 + 2, channels, depth);
                    px[o + 3] = sample(line, x * 4 + 3, channels, depth);
                    break;
                }
            }
        }
    }
    return image;
}

const COLOR_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Reads one packed sample from a scanline (MSB-first for sub-byte depths). */
function sample(line: Uint8Array, index: number, _channels: number, depth: number): number {
    if (depth === 8) return line[index];
    const bitPos = index * depth;
    const byte = line[bitPos >> 3];
    const shift = 8 - depth - (bitPos & 7);
    return (byte >> shift) & ((1 << depth) - 1);
}

function unfilterRow(filter: number, line: Uint8Array, out: Uint8Array, prev: Uint8Array | null, bpp: number): void {
    switch (filter) {
        case 0:
            out.set(line);
            break;
        case 1: // Sub
            for (let i = 0; i < line.length; ++i) {
                out[i] = (line[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff;
            }
            break;
        case 2: // Up
            for (let i = 0; i < line.length; ++i) {
                out[i] = (line[i] + (prev ? prev[i] : 0)) & 0xff;
            }
            break;
        case 3: // Average
            for (let i = 0; i < line.length; ++i) {
                const left = i >= bpp ? out[i - bpp] : 0;
                const up = prev ? prev[i] : 0;
                out[i] = (line[i] + ((left + up) >> 1)) & 0xff;
            }
            break;
        case 4: // Paeth
            for (let i = 0; i < line.length; ++i) {
                const a = i >= bpp ? out[i - bpp] : 0;
                const b = prev ? prev[i] : 0;
                const c = prev && i >= bpp ? prev[i - bpp] : 0;
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                out[i] = (line[i] + pred) & 0xff;
            }
            break;
        default:
            throw new Error(`unknown PNG row filter ${filter}`);
    }
}

/** Encodes an RGBA image as an 8-bit truecolor+alpha PNG. */
export function encodePng(image: RgbaImage): Uint8Array {
    const { width, height, pixels } = image;
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; ++y) {
        raw[y * (stride + 1)] = 0; // filter type: None
        raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    return new Uint8Array([
        ...SIGNATURE,
        ...chunk('IHDR', ihdr),
        ...chunk('IDAT', zlibSync(raw)),
        ...chunk('IEND', new Uint8Array(0)),
    ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; ++i) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

let crcTable: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
    if (crcTable === null) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; ++n) {
            let c = n;
            for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; ++i) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
