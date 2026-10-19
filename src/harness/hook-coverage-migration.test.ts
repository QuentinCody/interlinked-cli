import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCheckReceipt, HookReviewReceipt } from "./hook-coverage-evidence.js";
import { historyLogPath, readHistory } from "./hook-coverage-history-log.js";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";

const V8_STRING_LIMIT = 0x1fffffe8;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string {
    const root = mkdtempSync(join(tmpdir(), "hook-ledger-migration-"));
    roots.push(root);
    return root;
}
const current = { schema: 1, generation: 4, policyGeneration: 2, acceptedPolicy: null,
    files: { "a.ts": { identity: "v2", scope: "reservation" } },
    pending: [{ id: "p1", path: "a.ts", identity: "v2", scope: "reservation", writer: "unknown" }] };
const check = (index: number, findings: string[] = []): HookCheckReceipt => ({ id: `check-${index}`, path: "a.ts", identity: String(index),
    policyDigest: "d", policyGeneration: 1, checks: ["lint"], findings, checkedAt: "2026-10-10T00:00:00Z", kind: "automated_check" });
const review = (index: number): HookReviewReceipt => ({ id: `review-${index}`, path: "a.ts", identity: String(index),
    evidence: "read it", reviewedAt: "2026-10-10T00:00:00Z", kind: "manual_review" });
const others = (root: string, path: string) => readdirSync(root).filter(name => name !== "coverage.json" && join(root, name) !== path);

describe("legacy hook coverage ledger migration — positive (must fire)", () => {
    it("P1: moves every receipt to the history log, keeps the legacy file as a backup, and rewrites only current state", () => {
        const root = directory(), path = join(root, "coverage.json");
        const checks = Array.from({ length: 30 }, (_, index) => check(index, [`finding "${index}" \\ }`])), reviews = [review(0), review(1)];
        const legacy = JSON.stringify({ ...current, reviews, checks });
        writeFileSync(path, legacy);
        const ledger = new HookCoverageLedger(path);
        const log = historyLogPath(path);
        const history = readHistory(log, statSync(log).size);
        expect(history.checks.map(row => row.id)).toEqual(checks.map(row => row.id));
        expect(history.checks).toEqual(checks);
        expect(history.reviews).toEqual(reviews);
        const backups = readdirSync(root).filter(name => name.startsWith("coverage.json.legacy-"));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(root, backups[0]!), "utf8")).toBe(legacy);
        const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        expect(Object.keys(state).sort()).toEqual(["acceptedPolicy", "files", "generation", "history", "pending", "policyGeneration", "schema"]);
        expect(state.history).toMatchObject({ bytes: statSync(log).size, checks: 30, reviews: 2 });
        expect(ledger.snapshot()).toEqual({ ...current, checks, reviews });
        expect(ledger.statusReport().history).toMatchObject({ checks: { total: 30 }, reviews: { total: 2, returned: 2 } });
        expect(new HookCoverageLedger(path).snapshot()).toEqual(ledger.snapshot());
    });

    it("P2: save() bytes do not depend on the number of retained receipts", () => {
        const sizes = [0, 400].map(count => {
            const root = directory(), path = join(root, "coverage.json");
            writeFileSync(path, JSON.stringify({ ...current, checks: Array.from({ length: count }, (_, index) => check(index, ["x".repeat(4096)])) }));
            const ledger = new HookCoverageLedger(path);
            ledger.observe("b.ts", "v1", "reservation");
            const state = JSON.parse(readFileSync(path, "utf8")) as { history: { bytes: number } };
            return { bytes: statSync(path).size - JSON.stringify(state.history).length, log: state.history.bytes };
        });
        expect(sizes[1]!.log).toBeGreaterThan(400 * 4096);
        expect(sizes[1]!.bytes).toBe(sizes[0]!.bytes);
    });

    it("P3: loads a legacy ledger larger than the V8 string limit through the streaming path", () => {
        const root = directory(), path = join(root, "coverage.json");
        const descriptor = openSync(path, "w");
        const finding = "y".repeat(256 * 1024);
        let written = 0, count = 0;
        try {
            written += writeSync(descriptor, `${JSON.stringify(current).slice(0, -1)},"reviews":[${JSON.stringify(review(0))}],"checks":[`);
            while (written <= V8_STRING_LIMIT + 1024 * 1024) {
                written += writeSync(descriptor, `${count ? "," : ""}${JSON.stringify(check(count, [finding]))}`);
                count++;
            }
            written += writeSync(descriptor, "]}\n");
        } finally { closeSync(descriptor); }
        expect(statSync(path).size).toBeGreaterThan(V8_STRING_LIMIT);
        const ledger = new HookCoverageLedger(path);
        expect(ledger.summary()).toEqual({ generation: 4, policyGeneration: 2, pendingCount: 1, acceptedPolicy: null });
        expect(ledger.statusReport().history).toMatchObject({ checks: { total: count }, reviews: { total: 1 } });
        expect(statSync(path).size).toBeLessThan(4096);
        const lines = readFileSync(historyLogPath(path)).subarray(0, 4096).toString("utf8");
        expect(lines.startsWith(JSON.stringify(review(0)))).toBe(true);
    }, 300_000);
});

describe("legacy hook coverage ledger migration — negative (must not fire)", () => {
    it("N1: a ledger without legacy arrays is not rewritten on load", () => {
        const root = directory(), path = join(root, "coverage.json"), bytes = JSON.stringify(current);
        writeFileSync(path, bytes);
        const before = statSync(path).mtimeMs;
        const ledger = new HookCoverageLedger(path);
        expect(ledger.observation().pending).toHaveLength(1);
        expect(readFileSync(path, "utf8")).toBe(bytes);
        expect(statSync(path).mtimeMs).toBe(before);
        expect(others(root, path)).toEqual([]);
    });

    it.each([
        // A small file parses whole, so truncation surfaces as the parser's error before any migration.
        ["truncated", `${JSON.stringify({ ...current, checks: [check(0)] }).slice(0, -3)}`, "JSON", false],
        ["an invalid receipt", JSON.stringify({ ...current, checks: [{ ...check(0), kind: "manual" }] }), "Invalid hook check receipts", true],
        ["an invalid review", JSON.stringify({ ...current, reviews: [{ ...review(0), kind: "automated_check" }] }), "review receipt", true],
        ["an invalid header", JSON.stringify({ ...current, schema: 2, checks: [check(0)] }), "ledger header", true],
        ["both a pointer and inline history", JSON.stringify({ ...current, history: { bytes: 0, checks: 0, reviews: 0 }, checks: [] }), "both", true],
    ])("N2: a legacy file with %s leaves the previous ledger and any existing log untouched", (_name, bytes, reason, migrating) => {
        const root = directory(), path = join(root, "coverage.json"), log = historyLogPath(path);
        writeFileSync(path, bytes);
        writeFileSync(log, "previous log bytes\n");
        expect(() => new HookCoverageLedger(path)).toThrow(reason);
        if (migrating) expect(() => new HookCoverageLedger(path)).toThrow("previous ledger is unchanged");
        expect(readFileSync(path, "utf8")).toBe(bytes);
        expect(readFileSync(log, "utf8")).toBe("previous log bytes\n");
        expect(readdirSync(root).sort()).toEqual(["coverage-history.jsonl", "coverage.json"]);
    });

    it("N4: a truncated legacy file too large to parse whole fails in the streaming path and is left untouched", () => {
        const root = directory(), path = join(root, "coverage.json");
        const descriptor = openSync(path, "w");
        try {
            writeSync(descriptor, `${JSON.stringify(current).slice(0, -1)},"checks":[`);
            const row = JSON.stringify(check(0, ["z".repeat(1024 * 1024)]));
            for (let index = 0; index < 66; index++) writeSync(descriptor, `${index ? "," : ""}${row}`);
        } finally { closeSync(descriptor); }
        const size = statSync(path).size;
        expect(size).toBeGreaterThan(64 * 1024 * 1024);
        expect(() => new HookCoverageLedger(path)).toThrow(/previous ledger is unchanged: Malformed hook coverage ledger at byte \d+: file is truncated/);
        expect(statSync(path).size).toBe(size);
        expect(others(root, path)).toEqual([]);
    }, 60_000);

    it("N3: a committed pointer whose log lost bytes is refused instead of reporting less history", () => {
        const root = directory(), path = join(root, "coverage.json");
        writeFileSync(path, JSON.stringify({ ...current, history: { bytes: 100, checks: 1, reviews: 0, recent: { checks: [0], reviews: [] } } }));
        expect(() => new HookCoverageLedger(path)).toThrow("0 of 100 committed bytes");
        expect(existsSync(historyLogPath(path))).toBe(false);
    });
});
