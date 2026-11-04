import { expect, it } from "vitest";
import { cachedFunctionShingles } from "./dry-source-cache.js";

const source = "export function work(x: number) { const a = x + 1; const b = a * 2; return b + x; }";
it("reuses unchanged extraction and invalidates changed source text", () => {
    const first = cachedFunctionShingles(source, "/repo/cache-test.ts");
    expect(first.length).toBeGreaterThan(0);
    expect(cachedFunctionShingles(source, "/repo/cache-test.ts")).toBe(first);
    const changed = cachedFunctionShingles(source.replace("work", "different"), "/repo/cache-test.ts");
    expect(changed).not.toBe(first); expect(changed[0]?.name).toBe("different");
});
it("does not retain an unbounded corpus of old source records", () => {
    const first = cachedFunctionShingles(source, "/repo/oldest.ts");
    for (let n = 0; n < 128; n++) cachedFunctionShingles(source, `/repo/cache-${n}.ts`);
    expect(cachedFunctionShingles(source, "/repo/oldest.ts")).not.toBe(first);
});
