import { parseWire, wireArray, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { capsExplainAction, capsSetAction, capsShowAction } from "./caps.js";

let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("caps commands", () => {
    function captureOutput(): void {
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    }

    // test-contract: JSON show returns the effective metric values and provenance rather than the human-readable table.
    it("shows effective caps as JSON", async () => {
        cwd = mkdtempSync(join(tmpdir(), "caps-show-"));
        captureOutput();

        const result = await capsShowAction({ json: true }, { cwd });

        expect(result).toBe(0);
        const output = parseWire(JSON.parse(String(logSpy.mock.calls[0]?.[0])), wireRecord(wireUnknown), "test JSON value");
        expect(output).toMatchObject({
            lines: { value: 500, source: "default", default: 500 },
            "function-tokens": { value: 500, source: "default", default: 500 },
            cyclomatic: { value: 25, source: "default", default: 25 },
            coverage: { value: 100, source: "default", default: 100 },
        });
        expect(Object.keys(output)).toEqual(["lines", "function-tokens", "cyclomatic", "cognitive", "crap", "coverage"]);
    });

    // test-contract: JSON set reports the selected metric and writes its numeric config value.
    it("sets a metric and emits its JSON result", async () => {
        cwd = mkdtempSync(join(tmpdir(), "caps-set-"));
        captureOutput();

        const result = await capsSetAction("cyclomatic", "12", { json: true }, { cwd });

        expect(result).toBe(0);
        expect(logSpy.mock.calls[0]?.[0]).toBe(
            JSON.stringify({ metric: "cyclomatic", value: 12, configKey: "max_cyclomatic" }),
        );
        expect(JSON.parse(readFileSync(join(cwd, ".interlinked", "metric-caps.json"), "utf8"))).toMatchObject({
            version: 1,
            max_cyclomatic: 12,
        });
    });

    // test-contract: coverage goals accept both inclusive scale boundaries and reject values outside that scale.
    it.each([
        ["1", 0],
        ["100", 0],
        ["0", 1],
        ["101", 1],
    ])("validates coverage boundary %s with exit code %s", async (value: string, expected: number) => {
        cwd = mkdtempSync(join(tmpdir(), "caps-coverage-"));
        captureOutput();

        const result = await capsSetAction("coverage", value, {}, { cwd });

        expect(result).toBe(expected);
        if (expected === 0) {
            expect(JSON.parse(readFileSync(join(cwd, ".interlinked", "metric-caps.json"), "utf8"))).toMatchObject({
                coverage_goal: Number(value),
            });
        } else {
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("coverage goal must be between 1 and 100"));
        }
    });

    // test-contract: the human-readable show row describes coverage as a higher-is-stricter goal, not as a maximum.
    it("renders coverage with goal semantics", async () => {
        cwd = mkdtempSync(join(tmpdir(), "caps-text-"));
        captureOutput();

        await capsShowAction({}, { cwd });

        const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
        expect(output).toContain("coverage    goal 100 %");
        expect(output).toContain("ratchets rise toward it");
        expect(output).not.toContain("coverage    ≤");
    });

    // test-contract: JSON explain returns only the requested glossary entry, while unknown metrics fail visibly.
    it("explains one metric in JSON and rejects an unknown metric", async () => {
        cwd = mkdtempSync(join(tmpdir(), "caps-explain-"));
        captureOutput();

        expect(await capsExplainAction("coverage", { json: true })).toBe(0);
        const explanation = parseWire(JSON.parse(String(logSpy.mock.calls[0]?.[0])), wireArray(wireRecord(wireUnknown)), "test JSON value");
        expect(explanation).toHaveLength(1);
        expect(explanation[0]).toMatchObject({
            key: "coverage",
            default: 100,
            stricter: "higher",
        });

        expect(await capsExplainAction("missing", { json: true })).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown metric "missing"'));
    });
});
