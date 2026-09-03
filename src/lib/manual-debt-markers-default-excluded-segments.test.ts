import { describe, expect, it } from "vitest";
import {
    DEFAULT_EXCLUDED_SEGMENTS,
    findingIds,
    isExcluded,
    normalizedExclusions,
    scanDate,
} from "./manual-debt-markers-default-excluded-segments.js";

describe("DEFAULT_EXCLUDED_SEGMENTS", () => {
    it("includes the standard build/vendor directory names", () => {
        expect(DEFAULT_EXCLUDED_SEGMENTS.has("node_modules")).toBe(true);
        expect(DEFAULT_EXCLUDED_SEGMENTS.has(".git")).toBe(true);
        expect(DEFAULT_EXCLUDED_SEGMENTS.has("dist")).toBe(true);
    });
});

describe("normalizedExclusions", () => {
    it("trims a leading ./ and trailing slash, then sorts", () => {
        expect(normalizedExclusions(["./b/", "a", " c "])).toEqual(["a", "b", "c"]);
    });

    it("drops blank entries", () => {
        expect(normalizedExclusions(["", "  ", "keep"])).toEqual(["keep"]);
    });
});

describe("isExcluded", () => {
    it("excludes a path whose any segment matches a default exclusion", () => {
        expect(isExcluded("src/node_modules/pkg/index.ts", [])).toBe(true);
    });

    it("excludes an exact custom-exclusion match and its descendants", () => {
        expect(isExcluded("scratch", ["scratch"])).toBe(true);
        expect(isExcluded("scratch/probe.ts", ["scratch"])).toBe(true);
    });

    it("does not exclude an unrelated path", () => {
        expect(isExcluded("src/lib/a.ts", ["scratch"])).toBe(false);
    });
});

describe("scanDate", () => {
    it("formats an injected clock as YYYY-MM-DD", () => {
        expect(scanDate(() => Date.UTC(2026, 0, 5))).toBe("2026-01-05");
    });

    it("throws for a clock returning a non-finite time", () => {
        expect(() => scanDate(() => Number.NaN)).toThrow(/invalid/);
    });
});

describe("findingIds", () => {
    it("returns the supplied set verbatim when given", () => {
        const supplied = new Set(["a", "b"]);
        expect(findingIds("/nonexistent-root", supplied)).toBe(supplied);
    });

    it("returns an empty set when the project root has no findings corpus", () => {
        const result = findingIds("/definitely/not/a/real/project/root/xyz");
        expect(result).not.toBeNull();
        expect([...(result ?? [])]).toEqual([]);
    });
});
