// Direct unit coverage for the manual-debt-marker payload parser: comment
// extraction across the five comment-syntax families (including the
// HTML-suffix trim), and every diagnostic issue `parseDebtMarkerPayload` can
// emit. The identity/fingerprint helpers and the higher-level scan flow are
// exercised through `manual-debt-markers.test.ts` and
// `manual-debt-marker-record-parse.test.ts`; this file focuses on the
// payload-parsing branches those suites don't reach directly.
import { describe, expect, it } from "vitest";
import {
    debtMarkerFingerprint,
    explicitDebtMarkerFingerprint,
    extractDebtMarkerPayload,
    isMeasurableDebtTrigger,
    parseDebtMarkerPayload,
    supportsDebtMarkerComments,
} from "./manual-debt-marker-parser.js";

function validMarkerJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        decision: "keep the sync path",
        ceiling: "10k rows",
        trigger: "rows > 10000",
        ...overrides,
    });
}

describe("supportsDebtMarkerComments", () => {
    it("recognizes a slash-comment source extension (positive)", () => {
        expect(supportsDebtMarkerComments("src/index.ts")).toBe(true);
    });

    it("rejects an extension with no known comment syntax (negative)", () => {
        expect(supportsDebtMarkerComments("assets/logo.png")).toBe(false);
    });
});

describe("extractDebtMarkerPayload", () => {
    it("extracts the JSON payload from a slash-style comment (positive)", () => {
        const result = extractDebtMarkerPayload(
            "src/cache.ts",
            '  // interlinked-debt: {"decision":"single-process cache"}',
        );
        expect(result).toBe('{"decision":"single-process cache"}');
    });

    it("trims a trailing HTML comment closer from the extracted payload", () => {
        const result = extractDebtMarkerPayload(
            "docs/notes.html",
            '<!-- interlinked-debt: {"decision":"defer migration"} -->',
        );
        expect(result).toBe('{"decision":"defer migration"}');
    });

    it("returns null for a file whose extension has no comment syntax (negative)", () => {
        expect(extractDebtMarkerPayload("assets/logo.png", "interlinked-debt: {}")).toBeNull();
    });

    it("returns null when the line does not start with the file's comment prefix (negative)", () => {
        expect(extractDebtMarkerPayload("src/cache.ts", 'const x = "interlinked-debt: {}"')).toBeNull();
    });

    it("returns null when the comment does not carry the marker token (negative)", () => {
        expect(extractDebtMarkerPayload("src/cache.ts", "// just a regular comment")).toBeNull();
    });
});

describe("debtMarkerFingerprint / explicitDebtMarkerFingerprint", () => {
    it("produces a stable debt- prefixed key for the same inputs (positive)", () => {
        const fp = debtMarkerFingerprint("src/cache.ts", '{"decision":"a"}', 0);
        expect(fp).toBe(debtMarkerFingerprint("src/cache.ts", '{"decision":"a"}', 0));
        expect(fp.startsWith("debt-")).toBe(true);
    });

    it("changes the fingerprint when the duplicate occurrence ordinal changes (negative)", () => {
        const first = debtMarkerFingerprint("src/cache.ts", '{"decision":"a"}', 0);
        const second = debtMarkerFingerprint("src/cache.ts", '{"decision":"a"}', 1);
        expect(first).not.toBe(second);
    });

    it("derives the same key regardless of surrounding whitespace on the id (positive)", () => {
        expect(explicitDebtMarkerFingerprint("cache-limit")).toBe(
            explicitDebtMarkerFingerprint("  cache-limit  "),
        );
    });
});

describe("isMeasurableDebtTrigger", () => {
    it("accepts a trigger with a numeric threshold and unit (positive)", () => {
        expect(isMeasurableDebtTrigger("rows > 10000")).toBe(true);
    });

    it("rejects a prose-only trigger with no measurable boundary (negative)", () => {
        expect(isMeasurableDebtTrigger("when it becomes a problem")).toBe(false);
    });
});

describe("parseDebtMarkerPayload", () => {
    it("parses a fully valid payload including optional fields (positive)", () => {
        const result = parseDebtMarkerPayload(
            validMarkerJson({ owner: "qcody", review_after: "2026-12-01" }),
        );
        expect(result.issues).toEqual([]);
        expect(result.payload).toEqual({
            decision: "keep the sync path",
            ceiling: "10k rows",
            trigger: "rows > 10000",
            owner: "qcody",
            review_after: "2026-12-01",
        });
    });

    it("returns malformed-json for input that is not valid JSON (negative)", () => {
        const result = parseDebtMarkerPayload("{not json");
        expect(result.payload).toBeNull();
        expect(result.issues).toEqual([
            { code: "malformed-json", message: "marker payload is not valid JSON" },
        ]);
    });

    it("returns malformed-json when the parsed JSON is not an object (negative)", () => {
        const result = parseDebtMarkerPayload("[1,2,3]");
        expect(result.payload).toBeNull();
        expect(result.issues).toEqual([
            { code: "malformed-json", message: "marker payload must be a JSON object" },
        ]);
    });

    it("flags missing-decision when neither decision nor shortcut is present", () => {
        const result = parseDebtMarkerPayload(
            JSON.stringify({ ceiling: "10k rows", trigger: "rows > 10000" }),
        );
        expect(result.payload).toBeNull();
        expect(result.issues).toContainEqual({
            code: "missing-decision",
            message: "marker requires decision or shortcut",
        });
    });

    it("flags ambiguous-decision when decision and shortcut disagree", () => {
        const result = parseDebtMarkerPayload(
            JSON.stringify({
                decision: "keep sync",
                shortcut: "go async",
                ceiling: "10k rows",
                trigger: "rows > 10000",
            }),
        );
        expect(result.payload).toBeNull();
        expect(result.issues).toContainEqual({
            code: "ambiguous-decision",
            message: "decision and shortcut disagree; keep one canonical value",
        });
    });

    it("flags missing-ceiling when ceiling is absent", () => {
        const result = parseDebtMarkerPayload(
            JSON.stringify({ decision: "keep sync", trigger: "rows > 10000" }),
        );
        expect(result.payload).toBeNull();
        expect(result.issues).toContainEqual({
            code: "missing-ceiling",
            message: "marker requires ceiling",
        });
    });

    it("flags no-trigger when the trigger has no measurable boundary", () => {
        const result = parseDebtMarkerPayload(
            JSON.stringify({ decision: "keep sync", ceiling: "10k rows", trigger: "when needed" }),
        );
        expect(result.payload).toBeNull();
        expect(result.issues).toContainEqual({
            code: "no-trigger",
            message: "trigger must include a measurable threshold or comparison",
        });
    });

    it("flags unknown-field for a key outside the allowed marker schema", () => {
        const result = parseDebtMarkerPayload(validMarkerJson({ severity: "high" }));
        expect(result.payload).toBeNull();
        expect(result.issues).toContainEqual({
            code: "unknown-field",
            message: "unknown marker field: severity",
        });
    });

    it("flags invalid-field when an optional field is present but blank", () => {
        const result = parseDebtMarkerPayload(validMarkerJson({ owner: "   " }));
        expect(result.payload).toBeNull();
        expect(result.issues).toContainEqual({
            code: "invalid-field",
            message: "owner must be a non-empty string",
        });
    });

    it("flags invalid-review-date when review_after is not a real ISO date", () => {
        const result = parseDebtMarkerPayload(validMarkerJson({ review_after: "2026-02-30" }));
        expect(result.payload).toBeNull();
        expect(result.issues).toContainEqual({
            code: "invalid-review-date",
            message: "review_after must be a real ISO date (YYYY-MM-DD)",
        });
    });
});
