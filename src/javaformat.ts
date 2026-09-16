// float32 narrowing matching the Java tool's float arithmetic: every intermediate
// value in the width/scale formulas is a Java float, so we fround at the same points.
// This keeps .fontdata widths bit-identical to the JVM output at zero cost.

/** Bit-identical float32 value of x (Java float semantics). */
export function f32(x: number): number {
    return Math.fround(x);
}

// Note on -scale argument strings: the Java tool formats them with
// Float.toString/Double.toString. We pass JS String(number) instead — both are
// shortest-round-trip decimals that msdfgen parses back to values differing well
// below one float32 ulp, which is far below anything visible in the rasterization.
