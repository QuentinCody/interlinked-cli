import { describe, expect, it } from "vitest";
import {
    nonEmptyString,
    parseDebtMarkerScanResult,
    parseMarker,
    parsedList,
    uniqueCanonical,
} from "./manual-debt-marker-record-parse.js";

function validMarker(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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

function validScan(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        schema_version: 1,
        source: "source-comments",
        read_only: true,
        repository: {
            root: "/repo",
            head_sha: "deadbeef",
            tree_sha: "cafebabe",
            working_tree_sha256: "abc123",
        },
        markers: [validMarker()],
        advisories: [],
        coverage: {
            roots: ["src"],
            scanned_paths: ["src/cache.ts"],
            files_considered: 1,
            files_scanned: 1,
            lines_scanned: 10,
            skipped: {
                binary: 0,
                excluded: 0,
                outside_project: 0,
                symlink: 0,
                too_large: 0,
                unreadable: 0,
                unsupported: 0,
            },
            default_exclusions: [],
            custom_exclusions: [],
        },
        obligation_ledger: { consulted: false, mutated: false },
        ...overrides,
    };
}

describe("nonEmptyString", () => {
    it("returns the string when non-empty (positive)", () => {
        expect(nonEmptyString("hello")).toBe("hello");
    });

    it("rejects empty strings and non-strings (negative)", () => {
        expect(nonEmptyString("")).toBeNull();
        expect(nonEmptyString(42)).toBeNull();
        expect(nonEmptyString(undefined)).toBeNull();
    });
});

describe("uniqueCanonical", () => {
    it("accepts a sorted set of unique values (positive)", () => {
        expect(uniqueCanonical(["a", "b", "c"])).toBe(true);
    });

    it("rejects duplicates and out-of-order values (negative)", () => {
        expect(uniqueCanonical(["a", "a"])).toBe(false);
        expect(uniqueCanonical(["b", "a"])).toBe(false);
    });
});

describe("parsedList", () => {
    it("maps every item through the parser (positive)", () => {
        expect(parsedList([1, 2, 3], (item) => (typeof item === "number" ? item * 2 : null)))
            .toEqual([2, 4, 6]);
    });

    it("returns null when any item fails to parse or input isn't an array (negative)", () => {
        expect(parsedList([1, "x"], (item) => (typeof item === "number" ? item : null))).toBeNull();
        expect(parsedList("not-an-array", (item) => item)).toBeNull();
    });
});

describe("parseMarker", () => {
    it("parses a well-formed marker, including optional fields (positive)", () => {
        expect(parseMarker(validMarker({ owner: "qcody" }))).toMatchObject({
            fingerprint: "fp-1",
            file: "src/cache.ts",
            line: 10,
            owner: "qcody",
        });
    });

    it("rejects a marker with a traversal path or missing required field (negative)", () => {
        expect(parseMarker(validMarker({ file: "../outside.ts" }))).toBeNull();
        expect(parseMarker(validMarker({ decision: undefined }))).toBeNull();
        expect(parseMarker(null)).toBeNull();
    });
});

describe("parseDebtMarkerScanResult", () => {
    it("parses a well-formed scan result end to end (positive)", () => {
        const result = parseDebtMarkerScanResult(validScan());
        expect(result).not.toBeNull();
        expect(result?.markers).toHaveLength(1);
        expect(result?.coverage.scanned_paths).toEqual(["src/cache.ts"]);
    });

    it("rejects a scan whose coverage doesn't account for every scanned marker (negative)", () => {
        expect(parseDebtMarkerScanResult(validScan({ coverage: undefined }))).toBeNull();
        const mismatched = validScan();
        (mismatched as { coverage: { scanned_paths: string[] } }).coverage.scanned_paths = [];
        expect(parseDebtMarkerScanResult(mismatched)).toBeNull();
        expect(parseDebtMarkerScanResult(null)).toBeNull();
    });
});
