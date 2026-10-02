import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTestReceipt } from "./test-run-receipt.js";

const details = {
    identity: "abc",
    platform: "darwin-arm64-25.0.0",
    toolchain: { node: "22.22.0", vitest: "4.1.11", typescript: "5.9.0" },
    stages: { exec_ms: 10, post_ms: 2 },
};
const passed = { version: 2, key: "abc", status: "passed", runId: "run", durationMs: 12, ...details };

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "test-receipt-backfill-"));
    mkdirSync(join(root, ".interlinked/test-runs"), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function store(text: string): void { writeFileSync(join(root, ".interlinked/test-runs/abc.json"), text); }

describe("readTestReceipt rejects malformed receipts — negative (must not fire)", () => {
    it("N1: a JSON value that is not an object is no receipt", () => {
        // test-contract: boundary — a stored null or string must read as absent, never throw or partially parse
        store("null");
        expect(readTestReceipt(root, "abc")).toBeNull();
        store('"passed"');
        expect(readTestReceipt(root, "abc")).toBeNull();
    });

    it("N2: a duration that is missing, negative or not finite is no receipt", () => {
        // test-contract: invariant — only a finite, non-negative duration certifies a run
        store(JSON.stringify({ ...passed, durationMs: "12" }));
        expect(readTestReceipt(root, "abc")).toBeNull();
        store(JSON.stringify({ ...passed, durationMs: -1 }));
        expect(readTestReceipt(root, "abc")).toBeNull();
        store(JSON.stringify({ ...passed, durationMs: null }));
        expect(readTestReceipt(root, "abc")).toBeNull();
    });

    it("N3: a toolchain with a non-string vitest or typescript is rejected", () => {
        // test-contract: invariant — each toolchain member is null or a string, nothing else
        store(JSON.stringify({ ...passed, toolchain: { node: "22", vitest: 4, typescript: null } }));
        expect(readTestReceipt(root, "abc")).toBeNull();
        store(JSON.stringify({ ...passed, toolchain: { node: "22", vitest: null, typescript: 5 } }));
        expect(readTestReceipt(root, "abc")).toBeNull();
    });
});

describe("readTestReceipt accepts well-formed toolchains — positive (must fire)", () => {
    it("P1: string and null vitest/typescript members are both accepted", () => {
        // test-contract: public-api — a receipt records absent tools as null and present ones as version strings
        store(JSON.stringify(passed));
        expect(readTestReceipt(root, "abc")?.toolchain).toEqual(details.toolchain);
        const toolchain = { node: "22", vitest: null, typescript: null };
        store(JSON.stringify({ ...passed, toolchain }));
        expect(readTestReceipt(root, "abc")?.toolchain).toEqual(toolchain);
    });
});
