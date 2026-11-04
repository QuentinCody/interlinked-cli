import { describe, expect, it } from "vitest";
import { canonical, hash, parsePolicy } from "./relation-core.js";

describe("relation identity and policy boundary", () => {
    it("canonicalizes object keys but preserves ordered participants", () => {
        expect(hash({ b: 2, a: 1 })).toBe(hash({ a: 1, b: 2 }));
        expect(hash(["producer", "consumer"])).not.toBe(hash(["consumer", "producer"]));
        expect(() => canonical({ value: undefined })).toThrow();
        expect(() => canonical(Number.NaN)).toThrow();
    });
    it("rejects duplicate invariants, ambiguous scope and undeclared exceptions", () => {
        const entry = { id: "no-false-pass", version: "1", statement: "Unavailable is not passing", applicability: "verification", clauses: ["Missing evidence cannot pass"], exceptions: [], participants: [], groups: [], contextFiles: [] };
        expect(parsePolicy({ version: 1, invariants: [entry], scenarios: [] }).invariants).toHaveLength(1);
        expect(() => parsePolicy({ version: 1, invariants: [entry, entry], scenarios: [] })).toThrow();
        expect(() => parsePolicy({ version: 1, invariants: [{ ...entry, applicability: "" }], scenarios: [] })).toThrow();
        expect(() => parsePolicy({ version: 1, invariants: [{ ...entry, exceptions: undefined }], scenarios: [] })).toThrow();
    });
});
