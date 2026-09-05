import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCapturedData, recordCaptureReceipt } from "../lib/data/capture.js";
import { captureChecks } from "./doctor-data.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "doctor-data-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("doctor data producer coverage", () => {
    it("reports a populated historical stream as unmeasured", () => {
        mkdirSync(join(cwd, ".interlinked"));
        writeFileSync(join(cwd, ".interlinked", "costs.jsonl"), "{}\n");
        expect(captureChecks(cwd)).toContainEqual(expect.objectContaining({
            name: "Local data producers", status: "warn", message: expect.stringContaining("1 populated sources"),
        }));
    });
    it("reports a failed producer and observes its later successful append", () => {
        recordCaptureReceipt({ cwd, producer: "fixture" }, { source: "costs", status: "failed" });
        expect(captureChecks(cwd)).toContainEqual(expect.objectContaining({
            name: "Local data producers", status: "warn", message: expect.stringContaining("1 latest producer failure"),
        }));
        appendCapturedData({ cwd, producer: "fixture" }, "costs", [{ input_tokens: 2 }]);
        expect(captureChecks(cwd)).toContainEqual(expect.objectContaining({
            name: "Local data producers", message: expect.stringContaining("0 latest producer failure"),
        }));
    });
    it("does not report clean coverage when the data directory cannot be traversed", () => {
        writeFileSync(join(cwd, ".interlinked"), "not a directory");
        expect(captureChecks(cwd)).toContainEqual(expect.objectContaining({
            name: "Local data producers", status: "warn", message: expect.stringContaining("discovery is incomplete"),
        }));
    });
});
