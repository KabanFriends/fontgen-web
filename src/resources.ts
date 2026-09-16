// Bundled resources mirroring src/main/resources/ of the Java tool.

import { decodePng } from './png.js';

const MISSING_CHAR_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAYdEVYdFNvZnR3YXJlAFBhaW50Lk5FVCA1LjEuN4vW9zkAAAC2ZVhJZklJKgAIAAAABQAaAQUAAQAAAEoAAAAbAQUAAQAAAFIAAAAoAQMAAQAAAAIAAAAxAQIAEAAAAFoAAABphwQAAQAAAGoAAAAAAAAAYAAAAAEAAABgAAAAAQAAAFBhaW50Lk5FVCA1LjEuNwADAACQBwAEAAAAMDIzMAGgAwABAAAAAQAAAAWgBAABAAAAlAAAAAAAAAACAAEAAgAEAAAAUjk4AAIABwAEAAAAMDEwMAAAAAAlR56NozS1xQAAAChJREFUKFNj/P///38GNMDIyMgI56ArQOczIXOwgcGggBHd1Qxo3gQAdHoQBZElGlgAAAAASUVORK5CYII=';

let cachedMissingChar: ReturnType<typeof decodePng> | null = null;

/** The 8x8 missing glyph image shown by MissingPixelWrappedFont (/missing_char.png). */
export function missingCharImage() {
    if (cachedMissingChar === null) {
        const bin = atob(MISSING_CHAR_PNG_BASE64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
        cachedMissingChar = decodePng(bytes);
    }
    return cachedMissingChar;
}
