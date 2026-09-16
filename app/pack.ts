// Assembles the downloadable Bedrock resource pack: manifest.json plus the
// generation output under font/smooth/. Per spec (2026-08-24): NO subpacks —
// contents live directly in the main pack and the manifest carries no
// "subpacks" key.

import { strToU8, zipSync } from 'fflate';

export interface PackMeta {
    name: string;
    description: string;
    /** "major.minor.patch"; falls back to 1.0.0 when malformed. */
    version: string;
}

/** RFC 4122 v4 uuid. `crypto.randomUUID` exists only in secure contexts, so a
 *  page served over plain http:// (a LAN IP, file://) has to fall back to
 *  `getRandomValues` — which insecure contexts do expose — and, failing that,
 *  to Math.random. Manifest uuids just have to be unique, not unguessable. */
function randomUuid(): string {
    const c: Partial<Crypto> | undefined = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') return c.randomUUID();

    const b = new Uint8Array(16);
    if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < b.length; ++i) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildManifest(meta: PackMeta): Record<string, unknown> {
    const version = parseVersion(meta.version);
    return {
        format_version: 2,
        header: {
            name: meta.name,
            description: meta.description,
            uuid: randomUuid(),
            version,
            min_engine_version: [1, 15, 0],
        },
        modules: [
            {
                description: `${meta.name} resources`,
                type: 'resources',
                uuid: randomUuid(),
                version,
            },
        ],
    };
}

/** Wraps the generator output (paths like 'smooth/smooth_00.png') into a zip. */
export function buildPackZip(files: Map<string, Uint8Array>, meta: PackMeta): Uint8Array {
    const zip: Record<string, Uint8Array> = {
        'manifest.json': strToU8(JSON.stringify(buildManifest(meta), null, 4)),
    };
    for (const [path, data] of files) {
        zip[`font/${path}`] = data;
    }
    return zipSync(zip);
}

function parseVersion(v: string): [number, number, number] {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    if (m === null) return [1, 0, 0];
    const parts = m.slice(1).map((s) => Math.trunc(Number(s)));
    if (parts.some((n) => !Number.isFinite(n))) return [1, 0, 0];
    return [parts[0], parts[1], parts[2]];
}
