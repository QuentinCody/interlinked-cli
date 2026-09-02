import { describe, expect, it } from "vitest";
import type { ManualDebtMarker } from "./manual-debt-markers.js";
import { parseTransition } from "./manual-debt-marker-transition.js";

function makeMarker(overrides: Partial<ManualDebtMarker> = {}): ManualDebtMarker {
    return {
        fingerprint: "fp-1",
        content_fingerprint: "cf-1",
        file: "src/cache.ts",
        line: 10,
        decision: "single-process cache",
        ceiling: "10k keys",
        trigger: "keys > 10000 items",
        ...overrides,
    };
}

describe("parseTransition — positive (must fire)", () => {
    it("P1: parses an opened transition (before null, after present)", () => {
        const after = makeMarker();
        const result = parseTransition({
            action: "opened",
            fingerprint: "fp-1",
            before: null,
            after,
        });
        expect(result).toEqual({ action: "opened", fingerprint: "fp-1", before: null, after });
    });

    it("P2: parses a closed transition (before present, after null)", () => {
        const before = makeMarker();
        const result = parseTransition({
            action: "closed",
            fingerprint: "fp-1",
            before,
            after: null,
        });
        expect(result).toEqual({ action: "closed", fingerprint: "fp-1", before, after: null });
    });

    it("P3: parses a changed transition (before/after differ in content_fingerprint)", () => {
        const before = makeMarker({ content_fingerprint: "cf-1" });
        const after = makeMarker({ content_fingerprint: "cf-2" });
        const result = parseTransition({
            action: "changed",
            fingerprint: "fp-1",
            before,
            after,
        });
        expect(result).toEqual({ action: "changed", fingerprint: "fp-1", before, after });
    });
});

describe("parseTransition — negative (must not fire)", () => {
    it("N1: rejects a non-object value", () => {
        expect(parseTransition("not an object")).toBeNull();
        expect(parseTransition(null)).toBeNull();
    });

    it("N2: rejects a missing/empty fingerprint", () => {
        const after = makeMarker();
        expect(parseTransition({ action: "opened", fingerprint: "", before: null, after })).toBeNull();
        expect(parseTransition({ action: "opened", before: null, after })).toBeNull();
    });

    it("N3: rejects a malformed before/after marker payload", () => {
        expect(parseTransition({
            action: "opened",
            fingerprint: "fp-1",
            before: { not: "a marker" },
            after: makeMarker(),
        })).toBeNull();
        expect(parseTransition({
            action: "closed",
            fingerprint: "fp-1",
            before: makeMarker(),
            after: { not: "a marker" },
        })).toBeNull();
    });

    it("N4: rejects an opened transition whose after fingerprint mismatches", () => {
        const after = makeMarker({ fingerprint: "other-fp" });
        expect(parseTransition({
            action: "opened",
            fingerprint: "fp-1",
            before: null,
            after,
        })).toBeNull();
    });

    it("N5: rejects a changed transition whose markers are actually identical", () => {
        const before = makeMarker();
        const after = makeMarker();
        expect(parseTransition({
            action: "changed",
            fingerprint: "fp-1",
            before,
            after,
        })).toBeNull();
    });

    it("N6: rejects an unrecognized action", () => {
        expect(parseTransition({
            action: "renamed",
            fingerprint: "fp-1",
            before: null,
            after: makeMarker(),
        })).toBeNull();
    });
});
