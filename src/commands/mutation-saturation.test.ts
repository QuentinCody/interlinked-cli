// `interlinked mutation saturation`: render, ratchet write, and exit codes over a real manifest on disk.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSymbolHashes } from "../harness/mutation/identity.js";
import { emptyManifest, saveManifest } from "../harness/mutation/manifest.js";
import type { MutantStatus, SymbolRecord } from "../harness/mutation/types.js";
import { mutationSaturationCommand, renderSaturation } from "./mutation-saturation.js";

const SOURCE = "export function f(n: number): number {\n\treturn n + 1;\n}\n";
let root: string;

function symbolsFor(file: string, status: MutantStatus): Record<string, SymbolRecord> {
	const out: Record<string, SymbolRecord> = {};
	for (const [symbolId, entry] of computeSymbolHashes(file, SOURCE) ?? []) {
		out[symbolId] = {
			symbolId, qualifiedName: entry.qualifiedName, symbolHash: entry.symbolHash, instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
			mutants: { aaaaaaaaaaaaaaaa: { mutantId: "aaaaaaaaaaaaaaaa", siteId: "bbbbbbbbbbbbbbbb", mutator: "ArithmeticOperator", originalLexeme: "n + 1", replacement: "n - 1", ordinalWithinSymbol: 0, status, firstSeen: "2026-11-06T00:00:00Z" } },
		};
	}
	return out;
}

function seed(statuses: Record<string, MutantStatus>): void {
	const base = emptyManifest({ engine: "stryker", engineVersion: "9", dependencyGraphVersion: "0", environmentHash: "t", authoritativeAt: "2026-11-06T00:00:00Z" });
	const files: Record<string, Record<string, SymbolRecord>> = {};
	for (const [file, status] of Object.entries(statuses)) {
		writeFileSync(join(root, file), SOURCE);
		files[file] = symbolsFor(file, status);
	}
	saveManifest(join(root, ".interlinked"), { ...base, files });
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "saturation-cmd-"));
	mkdirSync(join(root, ".interlinked"));
	log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	process.exitCode = undefined;
});
afterEach(() => {
	log.mockRestore();
	process.exitCode = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("mutationSaturationCommand", () => {
	it("--ratchet records saturated files; a later survivor in one is a regression (exit 1)", async () => {
		seed({ "a.ts": "killed", "b.ts": "survived" });
		await mutationSaturationCommand({ cwd: root, ratchet: true });
		expect(process.exitCode).toBe(0);
		const baseline = JSON.parse(readFileSync(join(root, ".interlinked", "saturation-baseline.json"), "utf8"));
		expect(baseline.saturated).toEqual(["a.ts"]);

		seed({ "a.ts": "survived", "b.ts": "survived" });
		await mutationSaturationCommand({ cwd: root, json: true });
		expect(process.exitCode).toBe(1);
		const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
		expect(printed.regressions.map((r: { file: string }) => r.file)).toEqual(["a.ts"]);
	});

	it("reports an error (exit 2) with no manifest", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await mutationSaturationCommand({ cwd: root });
		expect(process.exitCode).toBe(2);
		err.mockRestore();
	});
});

describe("renderSaturation", () => {
	it("prints totals, the stability caveat and regressions", () => {
		const text = renderSaturation({ rows: [], totals: { saturated: 1, open: 2, unknown: 3, unmeasured: 0, gone: 0, files: 6 } }, [], 5);
		expect(text).toMatch(/1\/6 saturated/);
		expect(text).toMatch(/stability, not correctness/);
	});
});
