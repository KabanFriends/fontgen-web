// Port of PageUtil.java — the pages the Bedrock client actually loads smooth textures
// for, plus the Hangul-page test used by the remapping machinery.

const SUPPORTED_PAGES: ReadonlySet<number> = new Set([
    0x00, 0x01, 0x02, 0x03, 0x04,
    0x20, 0x21, 0x2E, 0x2F,
    ...range(0x30, 0x3F),
    ...range(0x40, 0x4F),
    ...range(0x50, 0x5F),
    ...range(0x60, 0x6F),
    ...range(0x70, 0x7F),
    ...range(0x80, 0x8F),
    ...range(0x90, 0x9F),
    ...range(0xA0, 0xAF),
    ...range(0xB0, 0xBF),
    ...range(0xC0, 0xCF),
    ...range(0xD0, 0xD7),
    0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0xFE, 0xFF,
]);

function range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let p = from; p <= to; ++p) out.push(p);
    return out;
}

export function isPageSupported(page: number): boolean {
    return SUPPORTED_PAGES.has(page);
}

export function isPageHangul(page: number): boolean {
    // Hangul Syllables block
    return page >= 0xAC && page <= 0xD6;
}
