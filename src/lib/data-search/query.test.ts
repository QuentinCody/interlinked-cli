import { describe, expect, it } from "vitest";
import { compareEvidence, validateEvidenceQuery } from "./query.js";

describe("evidence query validation", () => {
    it.each([
        [{ unknown: "field" }, "unknown query field: unknown"],
        [{ text: 42 }, "text must be a string"],
        [{ since: Infinity }, "since must be finite"],
        [{ until: Number.NaN }, "until must be finite"],
        [{ since: 2, until: 1 }, "since exceeds until"],
    ])("rejects malformed query input before searching: %j", (query, message) => {
        // test-contract: data-lab's parseQuery passes JSON object fields to this validator.
        expect(() => Reflect.apply(validateEvidenceQuery, undefined, [query])).toThrow(String(message));
    });

    it("accepts equal time bounds and a zero offset", () => {
        expect(() => validateEvidenceQuery({ since: 1, until: 1, offset: 0, limit: 1 })).not.toThrow();
    });
});

describe("evidence ordering", () => {
    it.each([
        [{ id: "a", time: null }, { id: "b", time: null }, -1],
        [{ id: "b", time: 7 }, { id: "a", time: 7 }, 1],
        [{ id: "a", time: 7 }, { id: "a", time: 7 }, 0],
    ])("orders equal timestamps consistently by id: %j", (left, right, expected) => {
        expect(compareEvidence(left, right)).toBe(expected);
    });
});
