// sfnt (TTF/OTF) parser replicating the exact FontBox 3.0.3 behavior the Java tool
// depends on: cmap (3,1) lookups, hmtx advance widths, head.unitsPerEm and 'post'
// glyph names, including FontBox's quirks:
//
//   - cmap format 4: segments with start==65535 or end==65535 are skipped entirely;
//     with rangeOffset==0 entries are stored even when the mapped glyph is 0; later
//     segments overwrite earlier ones on duplicate codes.
//   - cmap format 12: groups whose glyph index reaches numGlyphs stop early.
//   - getSubtable(3,1) returns null when absent — in Java this NPEs out of
//     getWidth/hasGlyph (the task fails); we throw to match.
//   - HorizontalMetricsTable.getAdvanceWidth: gid < numHMetrics ? adv[gid] : last
//     entry; missing table -> 250 (TrueTypeFont.getAdvanceWidth).
//   - post v1: 258 standard mac names; v2: numberOfGlyphs read from the post table
//     itself, indices <258 map to standard names, >=32768 become ".undefined";
//     v2.5: per-glyph signed offsets; v3: no names at all (getName -> null).
//   - nameToGID: reverse post-name map built with LAST occurrence winning, then the
//     uniXXXX parse fallback, then "gnnnnn" as raw gid.

import { MAC_GLYPH_NAMES, NUMBER_OF_MAC_GLYPHS } from './wgl4names.js';

interface TableRecord {
    offset: number;
    length: number;
}

export class SfntFont {
    private readonly data: DataView;
    private readonly bytes: Uint8Array;
    private readonly tables = new Map<string, TableRecord>();

    private cmap31: Map<number, number> | null = null;
    private postNames: string[] | null | undefined; // undefined = not yet parsed
    private psNameReverse: Map<string, number> | null = null;

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
        this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const tag = this.readString(0, 4);
        if (tag !== "\x00\x01\x00\x00" && tag !== 'true' && tag !== 'OTTO') {
            throw new IOException(`not a sfnt font (tag ${JSON.stringify(tag)})`);
        }
        const numTables = this.u16(4);
        for (let i = 0; i < numTables; ++i) {
            const rec = 12 + 16 * i;
            const t = this.readString(rec, 4);
            this.tables.set(t, { offset: this.u32(rec + 8), length: this.u32(rec + 12) });
        }
    }

    // --- primitive readers -------------------------------------------------

    private u16(off: number): number {
        return this.data.getUint16(off);
    }

    private i16(off: number): number {
        return this.data.getInt16(off);
    }

    private u32(off: number): number {
        return this.data.getUint32(off);
    }

    private readString(off: number, len: number): string {
        let s = '';
        for (let i = 0; i < len; ++i) s += String.fromCharCode(this.bytes[off + i]);
        return s;
    }

    private require(tag: string): TableRecord {
        const t = this.tables.get(tag);
        if (!t) throw new IOException(`required table ${tag} is missing`);
        return t;
    }

    // --- metrics ------------------------------------------------------------

    /** head.unitsPerEm (FontBox HeaderTable.getUnitsPerEm). */
    getUnitsPerEm(): number {
        return this.u16(this.require('head').offset + 18);
    }

    /** hhea.ascender / hhea.descender in font units — the values FreeType exposes
     *  as face->ascender/face->descender, which is what msdfgen's getFontMetrics
     *  reports (both scaled by the same 1/64 legacy factor as loaded glyphs). */
    getAscender(): number {
        return this.i16(this.require('hhea').offset + 4);
    }

    getDescender(): number {
        return this.i16(this.require('hhea').offset + 6);
    }

    /** maxp.numGlyphs. */
    getNumGlyphs(): number {
        return this.u16(this.require('maxp').offset + 4);
    }

    /**
     * FontBox TrueTypeFont.getAdvanceWidth + HorizontalMetricsTable.getAdvanceWidth:
     * gid < numHMetrics ? advance[gid] : advance[last]; 250 when hmtx absent/empty.
     */
    getAdvanceWidth(gid: number): number {
        const hmtx = this.tables.get('hmtx');
        if (!hmtx) return 250;
        const numOfHMetrics = this.u16(this.require('hhea').offset + 34);
        if (numOfHMetrics === 0) return 250;
        if (gid < numOfHMetrics) {
            return this.u16(hmtx.offset + 4 * gid);
        }
        // The last entry of the array covers all remaining glyphs; FontBox sizes the
        // array by maxp.numGlyphs, so that entry sits at min(numGlyphs-1, numHMetrics-1).
        const numGlyphs = this.getNumGlyphs();
        const lastIndex = Math.min(numGlyphs - 1, numOfHMetrics - 1);
        return this.u16(hmtx.offset + 4 * lastIndex);
    }

    /** First cmap subtable with platform 3 encoding 1 (FontBox CmapTable.getSubtable). */
    private getCmapSubtable31(): Map<number, number> {
        if (this.cmap31) return this.cmap31;
        const cmap = this.require('cmap');
        const n = this.u16(cmap.offset + 2);
        let subOff = -1;
        for (let i = 0; i < n; ++i) {
            const rec = cmap.offset + 4 + 8 * i;
            if (this.u16(rec) === 3 && this.u16(rec + 2) === 1) {
                subOff = cmap.offset + this.u32(rec + 4);
                break;
            }
        }
        if (subOff < 0) {
            // Java: getSubtable returns null and getGlyphId NPEs out of the try block
            // (NPE != IOException), failing the calling code.
            throw new Error("NullPointerException-equivalent: no cmap (3,1) subtable");
        }
        const map = new Map<number, number>();
        const format = this.u16(subOff);
        switch (format) {
            case 0: this.processSubtype0(subOff, map); break;
            case 4: this.processSubtype4(subOff, map); break;
            case 6: this.processSubtype6(subOff, map); break;
            case 12: this.processSubtype12(subOff, map); break;
            default:
                // Formats 2/8/10/13/14 are not used by any font this pipeline touches;
                // FontBox would parse them, we fail loudly instead.
                throw new IOException(`unsupported cmap format ${format}`);
        }
        this.cmap31 = map;
        return map;
    }

    private processSubtype0(off: number, map: Map<number, number>): void {
        for (let c = 0; c < 256; ++c) map.set(c, this.bytes[off + 6 + c]);
    }

    private processSubtype4(off: number, map: Map<number, number>): void {
        // Mirrors FontBox CmapSubtable.processSubtype4 exactly.
        const segCountX2 = this.u16(off + 6);
        const segCount = segCountX2 / 2;
        const endCodesOff = off + 14;
        const startCodesOff = endCodesOff + segCountX2 + 2;
        const idDeltaOff = startCodesOff + segCountX2;
        const idRangeOffsetPos = idDeltaOff + segCountX2; // position of idRangeOffset[i]
        for (let i = 0; i < segCount; ++i) {
            const start = this.u16(startCodesOff + 2 * i);
            const end = this.u16(endCodesOff + 2 * i);
            const delta = this.u16(idDeltaOff + 2 * i);
            const rangeOffset = this.u16(idRangeOffsetPos + 2 * i);
            const segmentRangeOffset = idRangeOffsetPos + i * 2 + rangeOffset;
            if (start === 65535 || end === 65535) continue;
            for (let j = start; j <= end; ++j) {
                if (rangeOffset === 0) {
                    map.set(j, (j + delta) & 0xFFFF);
                } else {
                    const glyphOffset = segmentRangeOffset + (j - start) * 2;
                    let glyphIndex = this.u16(glyphOffset);
                    if (glyphIndex !== 0) {
                        glyphIndex = (glyphIndex + delta) & 0xFFFF;
                        map.set(j, glyphIndex);
                    }
                }
            }
        }
    }

    private processSubtype6(off: number, map: Map<number, number>): void {
        const firstCode = this.u16(off + 6);
        const entryCount = this.u16(off + 8);
        for (let i = 0; i < entryCount; ++i) {
            map.set(firstCode + i, this.u16(off + 10 + 2 * i));
        }
    }

    private processSubtype12(off: number, map: Map<number, number>): void {
        const numGlyphs = this.getNumGlyphs();
        const nbGroups = this.u32(off + 12);
        for (let g = 0; g < nbGroups; ++g) {
            const rec = off + 16 + 12 * g;
            const firstCode = this.u32(rec);
            const endCode = this.u32(rec + 4);
            const startGlyph = this.u32(rec + 8);
            for (let j = 0; j <= endCode - firstCode; ++j) {
                const glyphIndex = startGlyph + j;
                if (glyphIndex >= numGlyphs) break; // FontBox warns and breaks the group
                map.set(firstCode + j, glyphIndex);
            }
        }
    }

    /** CmapSubtable.getGlyphId for the (3,1) subtable. */
    getGlyphId(charCode: number): number {
        return this.getCmapSubtable31().get(charCode) ?? 0;
    }

    // --- post table ----------------------------------------------------------

    /** PostScriptTable.getName: null when the post table carries no usable names. */
    getPostScriptName(gid: number): string | null {
        this.readPostScriptNames();
        const names = this.postNames!;
        if (gid < 0 || names === null || gid >= names.length) return null;
        return names[gid];
    }

    private readPostScriptNames(): void {
        if (this.postNames !== undefined) return;
        const post = this.tables.get('post');
        if (!post) {
            this.postNames = null;
            return;
        }
        const off = post.offset;
        const versionFixed = this.u32(off); // e.g. 0x00020000 = v2
        const major = versionFixed >>> 16;
        const minor = versionFixed & 0xFFFF;
        if (major === 1 && minor === 0) {
            this.postNames = MAC_GLYPH_NAMES.slice();
        } else if (major === 2 && minor === 0) {
            const numGlyphsInPost = this.u16(off + 32);
            const glyphNameIndex: number[] = [];
            let maxIndex = Number.MIN_SAFE_INTEGER;
            for (let i = 0; i < numGlyphsInPost; ++i) {
                const index = this.u16(off + 34 + 2 * i);
                glyphNameIndex.push(index);
                if (index <= 32767) maxIndex = Math.max(maxIndex, index);
            }
            const nameArray: string[] = [];
            if (maxIndex >= NUMBER_OF_MAC_GLYPHS) {
                let p = off + 34 + 2 * numGlyphsInPost;
                const end = off + post.length;
                const count = maxIndex - NUMBER_OF_MAC_GLYPHS + 1;
                for (let i = 0; i < count && p < end; ++i) {
                    const len = this.bytes[p++];
                    nameArray.push(this.readString(p, len));
                    p += len;
                }
            }
            const names: string[] = [];
            for (const index of glyphNameIndex) {
                if (index >= 0 && index < NUMBER_OF_MAC_GLYPHS) {
                    names.push(MAC_GLYPH_NAMES[index]);
                } else if (index >= NUMBER_OF_MAC_GLYPHS && index <= 32767 && nameArray.length > 0) {
                    names.push(nameArray[index - NUMBER_OF_MAC_GLYPHS] ?? '.notdef');
                } else {
                    names.push('.undefined'); // reserved range 32768..65535
                }
            }
            this.postNames = names;
        } else if (major === 2 && minor === 5) {
            const count = this.getNumGlyphs();
            const names: string[] = [];
            for (let i = 0; i < count; ++i) {
                const offset = this.i16(off + 32 + i);
                const index = i + 1 + offset;
                if (index >= 0 && index < NUMBER_OF_MAC_GLYPHS) {
                    names.push(MAC_GLYPH_NAMES[index]);
                } else {
                    names.push('.undefined');
                }
            }
            this.postNames = names;
        } else {
            // v3 (and anything else): no PostScript name information
            this.postNames = null;
        }
    }

    /** FontBox TrueTypeFont.nameToGID. */
    nameToGid(name: string): number {
        this.readPostScriptNames();
        if (this.psNameReverse === null) {
            const rev = new Map<string, number>();
            if (this.postNames !== null && this.postNames !== undefined) {
                // HashMap.put loop: the LAST occurrence of a duplicated name wins
                for (let i = 0; i < this.postNames.length; ++i) rev.set(this.postNames[i], i);
            }
            this.psNameReverse = rev;
        }
        const gid = this.psNameReverse.get(name);
        if (gid !== undefined && gid > 0 && gid < this.getNumGlyphs()) {
            return gid;
        }
        const uni = parseUniName(name);
        if (uni > -1) {
            // getUnicodeCmapLookup(false): (3,1), then (3,10)
            const lookup = this.unicodeLookup();
            if (lookup) return lookup.get(uni) ?? 0;
            return 0;
        }
        if (/^g\d+$/.test(name)) return parseInt(name.substring(1), 10);
        return 0;
    }

    private unicodeLookup(): Map<number, number> | null {
        const cmap = this.tables.get('cmap');
        if (!cmap) return null;
        const n = this.u16(cmap.offset + 2);
        const wanted: Array<[number, number]> = [[3, 1], [3, 10]];
        for (const [plat, enc] of wanted) {
            for (let i = 0; i < n; ++i) {
                const rec = cmap.offset + 4 + 8 * i;
                if (this.u16(rec) === plat && this.u16(rec + 2) === enc) {
                    const subOff = cmap.offset + this.u32(rec + 4);
                    const map = new Map<number, number>();
                    switch (this.u16(subOff)) {
                        case 0: this.processSubtype0(subOff, map); break;
                        case 4: this.processSubtype4(subOff, map); break;
                        case 6: this.processSubtype6(subOff, map); break;
                        case 12: this.processSubtype12(subOff, map); break;
                        default: return null;
                    }
                    return map;
                }
            }
        }
        return null;
    }

    /** TrueTypeWrappedFont.hasGlyph — the full FontBox chain. */
    hasGlyph(charCode: number): boolean {
        const glyphId = this.getGlyphId(charCode);
        const name = this.getPostScriptName(glyphId);
        return name !== null && this.nameToGid(name) !== 0;
    }
}

/** Marker for FontBox IOException paths (caught -> width 0 / hasGlyph false). */
export class IOException extends Error {}

function parseUniName(name: string): number {
    if (!name.startsWith('uni') || name.length !== 7) return -1;
    try {
        const codePoint = parseInt(name.substring(3), 16);
        if (Number.isNaN(codePoint)) return -1;
        if (codePoint <= 0xD7FF || codePoint >= 0xE000) return codePoint;
        return -1;
    } catch {
        return -1;
    }
}
