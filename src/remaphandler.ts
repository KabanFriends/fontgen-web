// Port of RemapHandler.java — config-driven page remapping and the remapping.dat
// writer. Faithful quirks:
//   - The output buffer is preallocated at 0x100*8*numRemaps bytes and written whole,
//     so when redirect records are suppressed (Hangul target + remapHangulChars=false)
//     the file ends in zero padding.
//   - Records are emitted per remap source in ascending page order, then ascending
//     char order within each page.

import { isPageHangul } from './pageutil.js';

export class RemapHandler {
    /** from-page -> to-page */
    private readonly remaps = new Map<number, number>();

    constructor(remaps: ReadonlyArray<{ from: number; to: number }>) {
        for (const r of remaps) this.remaps.set(r.from, r.to);
    }

    canWritePage(originalPage: number): boolean {
        // A page that another page remaps TO must not be written as itself.
        return this.remaps.has(originalPage) || !this.isTargetPage(originalPage);
    }

    private isTargetPage(page: number): boolean {
        for (const to of this.remaps.values()) {
            if (to === page) return true;
        }
        return false;
    }

    remap(originalPage: number): number {
        return this.remaps.get(originalPage) ?? originalPage;
    }

    /**
     * Builds the remapping.dat content: for every configured remap i -> t and every
     * char j: [j,i,j,t], plus [j,t,0xFE,0xFF] unless suppressed.
     */
    buildRemappingFile(remapHangulChars: boolean): Uint8Array {
        const buffer = new Uint8Array(0x100 * 8 * this.remaps.size);
        let pos = 0;
        const put = (...bytes: number[]) => {
            for (const b of bytes) buffer[pos++] = b & 0xFF;
        };
        for (let i = 0; i < 0x100; ++i) {
            if (!this.remaps.has(i)) continue;
            const remapped = this.remaps.get(i)!;
            for (let j = 0; j < 0x100; ++j) {
                put(j, i, j, remapped);
                const page = remapped >> 8;
                if (remapHangulChars || !isPageHangul(page)) {
                    put(j, remapped, 0xFE, 0xFF);
                }
            }
        }
        return buffer;
    }
}
