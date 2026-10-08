import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBytes } from "../lib/metrics/inventory.js";
import { COVERAGE_SOURCES_ARTIFACT, measuredCoverage, recentCoverageSources, recordCoverageSources } from "./coverage-source-binding.js";

let base: string;
let root: string;
let store: string;

function metric(pct: number) {
	return { total: 10, covered: pct / 10, skipped: 0, pct };
}

function writeRun(runId: string, files: Record<string, number>, mtime?: number): string {
	const directory = join(store, runId);
	mkdirSync(join(directory, "coverage"), { recursive: true });
	const summary: Record<string, unknown> = { total: { lines: metric(50) } };
	for (const [path, pct] of Object.entries(files)) summary[join(root, path)] = { lines: metric(pct), branches: metric(pct) };
	writeFileSync(join(directory, "coverage/coverage-summary.json"), JSON.stringify(summary));
	recordCoverageSources(directory, root);
	if (mtime !== undefined) utimesSync(join(directory, COVERAGE_SOURCES_ARTIFACT), mtime, mtime);
	return directory;
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "coverage-binding-"));
	root = join(base, "checkout");
	store = join(base, "store");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(store, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("recordCoverageSources — validated snapshot hashes", () => {
	// test-contract: invariant — with a validated snapshot, the binding carries the snapshot's hash even when the file changed after the snapshot, and omits a file the snapshot lacks
	it("P: binds the snapshot bytes, not the live bytes, and omits a file absent from the snapshot", () => {
		writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
		writeFileSync(join(root, "src/b.ts"), "export const b = 1;\n");
		const snapshotHash = hashBytes(Buffer.from("export const a = 1;\n"));
		writeFileSync(join(root, "src/a.ts"), "export const a = 2; // written after the snapshot\n");
		const directory = join(store, "run-snap");
		mkdirSync(join(directory, "coverage"), { recursive: true });
		const summary = { total: { lines: metric(50) }, [join(root, "src/a.ts")]: { lines: metric(80) }, [join(root, "src/b.ts")]: { lines: metric(60) } };
		writeFileSync(join(directory, "coverage/coverage-summary.json"), JSON.stringify(summary));
		expect(recordCoverageSources(directory, root, new Map([["src/a.ts", snapshotHash]]))).toBe(true);
		const written = JSON.parse(readFileSync(join(directory, COVERAGE_SOURCES_ARTIFACT), "utf8"));
		expect(Object.keys(written.files)).toEqual(["src/a.ts"]);
		expect(written.files["src/a.ts"].sha256).toBe(snapshotHash);
	});

	it("N: without a snapshot map it still hashes the live file", () => {
		writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
		const directory = writeRun("run-live", { "src/a.ts": 80 });
		const written = JSON.parse(readFileSync(join(directory, COVERAGE_SOURCES_ARTIFACT), "utf8"));
		expect(written.files["src/a.ts"].sha256).toBe(hashBytes(Buffer.from("export const a = 1;\n")));
	});
});

describe("recordCoverageSources — binds each measured file to the bytes the run measured", () => {
	it("writes the sha256 and the summary metrics of every file under the run root", () => {
		writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
		const directory = writeRun("run-1", { "src/a.ts": 80 });
		const written = JSON.parse(readFileSync(join(directory, COVERAGE_SOURCES_ARTIFACT), "utf8"));
		expect(written).toEqual({ version: 1, files: { "src/a.ts": { sha256: hashBytes(Buffer.from("export const a = 1;\n")), metrics: { lines: 80, branches: 80 } } } });
	});

	it("skips the total row, files outside the root and files that vanished", () => {
		writeFileSync(join(root, "src/a.ts"), "a");
		const directory = join(store, "run-2");
		mkdirSync(join(directory, "coverage"), { recursive: true });
		writeFileSync(join(directory, "coverage/coverage-summary.json"), JSON.stringify({
			total: { lines: metric(1) }, [join(root, "src/a.ts")]: { lines: metric(90) }, [join(root, "src/gone.ts")]: { lines: metric(90) }, "/elsewhere/x.ts": { lines: metric(90) },
		}));
		expect(recordCoverageSources(directory, root)).toBe(true);
		expect(Object.keys(JSON.parse(readFileSync(join(directory, COVERAGE_SOURCES_ARTIFACT), "utf8")).files)).toEqual(["src/a.ts"]);
	});

	it("records nothing when the run left no summary or an unreadable one", () => {
		const directory = join(store, "run-3");
		mkdirSync(join(directory, "coverage"), { recursive: true });
		expect(recordCoverageSources(directory, root)).toBe(false);
		writeFileSync(join(directory, "coverage/coverage-summary.json"), "{not json");
		expect(recordCoverageSources(directory, root)).toBe(false);
	});
});

describe("measuredCoverage — positive (must match): the exact bytes were measured", () => {
	it("returns the newest run that measured these bytes", () => {
		writeFileSync(join(root, "src/a.ts"), "v1");
		writeRun("old", { "src/a.ts": 60 }, 1_000);
		writeRun("new", { "src/a.ts": 95 }, 2_000);
		const match = measuredCoverage(recentCoverageSources(store), { path: "src/a.ts", sha256: hashBytes(Buffer.from("v1")) });
		expect(match).toEqual({ runId: "new", metrics: { lines: 95, branches: 95 } });
	});

	it("falls back to an older run when the newest one measured other bytes", () => {
		writeFileSync(join(root, "src/a.ts"), "v1");
		writeRun("old", { "src/a.ts": 60 }, 1_000);
		writeFileSync(join(root, "src/a.ts"), "v2");
		writeRun("new", { "src/a.ts": 95 }, 2_000);
		expect(measuredCoverage(recentCoverageSources(store), { path: "src/a.ts", sha256: hashBytes(Buffer.from("v1")) })?.runId).toBe("old");
	});
});

describe("measuredCoverage — negative (must not match)", () => {
	it("returns null for bytes no run measured, a path no run saw, and an empty store", () => {
		writeFileSync(join(root, "src/a.ts"), "v1");
		writeRun("only", { "src/a.ts": 60 });
		const indexes = recentCoverageSources(store);
		expect(measuredCoverage(indexes, { path: "src/a.ts", sha256: hashBytes(Buffer.from("edited")) })).toBeNull();
		expect(measuredCoverage(indexes, { path: "src/b.ts", sha256: hashBytes(Buffer.from("v1")) })).toBeNull();
		expect(recentCoverageSources(join(base, "missing-store"))).toEqual([]);
	});

	it("ignores a sources file with a malformed entry instead of trusting part of it", () => {
		const directory = join(store, "bad");
		mkdirSync(join(directory, "coverage"), { recursive: true });
		writeFileSync(join(directory, COVERAGE_SOURCES_ARTIFACT), JSON.stringify({ version: 1, files: { "src/a.ts": { sha256: "short", metrics: {} } } }));
		expect(recentCoverageSources(store)).toEqual([]);
	});

	it("reads only the newest runs up to the bound", () => {
		writeFileSync(join(root, "src/a.ts"), "v1");
		for (let i = 0; i < 4; i++) writeRun(`run-${i}`, { "src/a.ts": 60 }, 1_000 + i);
		expect(recentCoverageSources(store, 2).map((index) => index.runId)).toEqual(["run-3", "run-2"]);
	});
});
