import { describe, expect, it } from "vitest";
import { observeProjectProcess } from "./project-process-observation.js";

describe("optional process observation", () => {
    it("delivers measured facts without inventing an RSS sample for an unstarted check", () => {
        const rows: unknown[] = [];
        observeProjectProcess(row => rows.push(row), { waitMs: 12, execMs: 0 });
        expect(rows).toEqual([{ waitMs: 12, execMs: 0 }]);
    });

    it("keeps a broken telemetry sink from replacing the process verdict", () => {
        expect(() => observeProjectProcess(() => { throw new Error("ledger unavailable"); }, { waitMs: 0, execMs: 13 })).not.toThrow();
        expect(() => observeProjectProcess(undefined, { waitMs: 0, execMs: 13 })).not.toThrow();
    });
});
