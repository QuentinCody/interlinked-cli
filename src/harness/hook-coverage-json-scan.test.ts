import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanLedgerFile } from "./hook-coverage-json-scan.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(content: string | Buffer): string {
    const root = mkdtempSync(join(tmpdir(), "hook-json-scan-"));
    roots.push(root);
    const path = join(root, "ledger.json");
    writeFileSync(path, content);
    return path;
}
const HISTORY = new Set(["checks", "reviews"]);
function scan(content: string | Buffer, chunkBytes?: number) {
    const elements: Array<[string, unknown]> = [];
    const result = scanLedgerFile(file(content), HISTORY, (key, value) => { elements.push([key, value]); }, chunkBytes);
    return { ...result, elements };
}

const tricky = {
    schema: 1, generation: 3, acceptedPolicy: null, files: { "a\"}].ts": { identity: "x\\", scope: "policy" } }, pending: [],
    checks: [{ id: "c1", findings: ["quote \" brace } bracket ] backslash \\ ", "😀 multibyte é"] }, { id: "c2", n: -1.5e3, ok: true }],
    reviews: [], other: [[1, 2], { nested: ["checks"] }],
};

describe("streaming ledger scanner — positive (must fire)", () => {
    it.each([1, 2, 3, 7, 64, 4096])("P1: emits every history element and keeps the rest as current (chunk %i bytes)", chunkBytes => {
        const result = scan(JSON.stringify(tricky, null, chunkBytes % 2 ? 0 : 2), chunkBytes);
        expect(result.elements).toEqual([["checks", tricky.checks[0]], ["checks", tricky.checks[1]]]);
        const { checks: _checks, reviews: _reviews, ...current } = tricky;
        expect(result.current).toEqual(current);
        expect(result.arrays).toEqual(["checks", "reviews"]);
    });

    it.each([
        ["truncated object", '{"schema":1,"checks":[{"id":"c1"}', "truncated"],
        ["trailing data", '{"schema":1} {}', "trailing data"],
        ["missing colon", '{"schema" 1}', "expected ':'"],
        ["trailing comma in history", '{"checks":[{"id":1},]}', "expected a value"],
        ["duplicate key", '{"checks":[],"checks":[]}', "duplicate key"],
        ["not an object", "[1,2]", "expected '{'"],
        ["bad scalar", '{"schema":tru}', "invalid JSON value"],
    ])("P2: refuses a %s with the byte offset", (_name, content, reason) => {
        expect(() => scan(content, 3)).toThrow(reason);
        expect(() => scan(content, 3)).toThrow(/at byte \d+/);
    });
});

describe("streaming ledger scanner — negative (must not fire)", () => {
    it("N1: a history key whose value is not an array is a member, not a stream", () => {
        const result = scan('{"reviews":{},"checks":null}', 2);
        expect(result.elements).toEqual([]);
        expect(result.arrays).toEqual([]);
        expect(result.current).toEqual({ reviews: {}, checks: null });
    });

    it("N2: a key named __proto__ stays an own member and does not change the prototype", () => {
        const result = scan('{"__proto__":{"polluted":true},"schema":1}');
        expect(Object.getPrototypeOf(result.current)).toBe(Object.prototype);
        expect(Object.hasOwn(result.current, "__proto__")).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});
