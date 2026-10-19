import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeEvent } from "../__tests__/fixtures/evaluator.js";
import { addTscDeferred, finishTscDrain, readTscDeferred, readTscStore, tscSchedulerStorePath } from "./tsc-scheduler-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), "scheduler-store-"));
    roots.push(cwd);
    const event = makeEvent();
    addTscDeferred(cwd, event, join(cwd, "a.ts"), 0.1);
    return { cwd, event, store: tscSchedulerStorePath(cwd, event) };
}

describe("durable scheduler obligations", () => {
    it("retains an error across reads and clears it only after a passing drain", () => {
        const { cwd, event, store } = fixture();
        expect(finishTscDrain(cwd, store, readTscDeferred(cwd, event), ["TS2322"], false)).toBe(false);
        const failed = readTscDeferred(cwd, event);
        expect(failed.entries.map(entry => entry.path)).toEqual([join(cwd, "a.ts")]);
        expect(failed.blocking).toEqual(["TS2322"]);
        expect(finishTscDrain(cwd, store, failed, [], true)).toBe(false);
        expect(readTscDeferred(cwd, event).blocking).toEqual(["TS2322"]);
        expect(finishTscDrain(cwd, store, readTscDeferred(cwd, event), [], false)).toBe(true);
        expect(readTscDeferred(cwd, event).entries).toEqual([]);
    });

    it("never clears an edit arriving during compilation", () => {
        const { cwd, event, store } = fixture();
        const before = readTscDeferred(cwd, event);
        addTscDeferred(cwd, event, join(cwd, "a.ts"), 0.2);
        expect(finishTscDrain(cwd, store, before, [], false)).toBe(false);
        expect(readTscDeferred(cwd, event).entries).toHaveLength(1);
    });

    it("isolates sibling actors while retaining the legacy root key", () => {
        const { cwd, event, store } = fixture();
        const child = { ...event, subagent_id: "child" };
        expect(tscSchedulerStorePath(cwd, child)).not.toBe(store);
        expect(readTscDeferred(cwd, child).entries).toEqual([]);
        addTscDeferred(cwd, child, join(cwd, "b.ts"), 0.1);
        expect(readTscDeferred(cwd, event).entries.map(entry => entry.path)).toEqual([join(cwd, "a.ts")]);
    });

    it("keeps corrupt evidence through repeated reads", () => {
        const { cwd, store } = fixture();
        writeFileSync(store, "{invalid");
        for (let attempt = 0; attempt < 2; attempt++) expect(() => readTscStore(cwd, store)).toThrow();
        expect(readFileSync(store, "utf8")).toBe("{invalid");
    });

    it.each(["outside", "sequence", "probability", "findings", "orphan-findings"])("rejects malformed %s state", kind => {
        const { cwd, event, store } = fixture();
        const state = readTscDeferred(cwd, event);
        const value = kind === "outside" ? { ...state, entries: [{ ...state.entries[0], path: join(cwd, "../outside.ts") }] }
            : kind === "sequence" ? { ...state, seq: 0 }
            : kind === "probability" ? { ...state, entries: [{ ...state.entries[0], p: 2 }] }
            : kind === "findings" ? { ...state, blocking: [null] }
            : { ...state, entries: [], blocking: ["TS2322"] };
        writeFileSync(store, JSON.stringify(value));
        expect(() => readTscStore(cwd, store)).toThrow();
    });

    it("reads the initial on-disk format without inventing findings", () => {
        const { cwd, event, store } = fixture();
        const { blocking: _blocking, ...legacy } = readTscDeferred(cwd, event);
        writeFileSync(store, JSON.stringify(legacy));
        expect(readTscDeferred(cwd, event)).toEqual({ ...legacy, blocking: [] });
    });
});
