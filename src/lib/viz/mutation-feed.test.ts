import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMutantWatcher,
	diffSnapshots,
	emptySnapshot,
	type MutantEvent,
	mutationManifestPath,
	parseManifest,
	readMutantSnapshot,
} from "./mutation-feed.js";

// node:fs's ESM namespace is non-configurable, so a plain `vi.spyOn(fs,
// "readFileSync")` throws ("Cannot redefine property"). Route through
// vi.mock instead: keep every real implementation, wrap readFileSync in a
// spy-able vi.fn() so one test can force it to throw.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

/** Minimal well-formed manifest with one file, one symbol, N mutants. */
function manifest(mutants: Record<string, { status: string; mutator?: string }>) {
	return JSON.stringify({
		generation: 3,
		engine: "stryker",
		files: {
			"src/a.ts": {
				sym1: {
					qualifiedName: "doThing",
					mutants: Object.fromEntries(
						Object.entries(mutants).map(([id, m]) => [
							id,
							{
								mutantId: id,
								mutator: m.mutator ?? "ConditionalExpression",
								originalLexeme: "a === b",
								replacement: "true",
								status: m.status,
							},
						]),
					),
				},
			},
		},
	});
}

describe("mutationManifestPath", () => {
	it("resolves under the project's .interlinked dir", () => {
		expect(mutationManifestPath("/proj")).toBe(join("/proj", ".interlinked", "mutation-manifest.json"));
	});
});

describe("parseManifest", () => {
	it("flattens mutants with file, symbol, and mutation detail", () => {
		const snap = parseManifest(manifest({ m1: { status: "killed" } }));
		expect(snap.mutants).toEqual([
			{
				id: "m1",
				file: "src/a.ts",
				symbol: "doThing",
				mutator: "ConditionalExpression",
				original: "a === b",
				replacement: "true",
				status: "killed",
			},
		]);
		expect(snap).toMatchObject({ generation: 3, engine: "stryker", files: 1, total: 1 });
	});

	it("tallies statuses across the manifest", () => {
		const snap = parseManifest(manifest({ m1: { status: "killed" }, m2: { status: "survived" }, m3: { status: "killed" } }));
		expect(snap.byStatus).toEqual({ killed: 2, survived: 1 });
	});

	it("returns an empty snapshot on malformed JSON", () => {
		expect(parseManifest("{oops")).toEqual(emptySnapshot());
	});

	it("returns an empty snapshot when `files` is missing or not an object", () => {
		expect(parseManifest(JSON.stringify({ generation: 1 }))).toEqual(emptySnapshot());
		expect(parseManifest(JSON.stringify({ files: [] }))).toEqual(emptySnapshot());
	});

	it("skips mutant records with no identity and defaults missing detail", () => {
		const raw = JSON.stringify({
			files: { "src/a.ts": { sym: { mutants: { bad: { status: "killed" }, ok: { mutantId: "ok" } } } } },
		});
		const snap = parseManifest(raw);
		expect(snap.mutants).toHaveLength(1);
		expect(snap.mutants[0]).toMatchObject({ id: "ok", status: "indeterminate", mutator: "unknown", symbol: "anonymous" });
	});
});

describe("readMutantSnapshot", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "viz-mutants-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads a manifest from disk", () => {
		const path = join(dir, "mutation-manifest.json");
		writeFileSync(path, manifest({ m1: { status: "survived" } }));
		expect(readMutantSnapshot(path).mutants[0]?.status).toBe("survived");
	});

	it("returns an empty snapshot when the file is absent", () => {
		expect(readMutantSnapshot(join(dir, "nope.json"))).toEqual(emptySnapshot());
	});

	it("returns an empty snapshot when the file exists but reading it throws", () => {
		const path = join(dir, "mutation-manifest.json");
		writeFileSync(path, manifest({ m1: { status: "survived" } }));
		vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied");
		});
		expect(readMutantSnapshot(path)).toEqual(emptySnapshot());
	});
});

describe("diffSnapshots", () => {
	it("reports an unseen mutant as born", () => {
		const next = parseManifest(manifest({ m1: { status: "killed" } }));
		expect(diffSnapshots(emptySnapshot(), next)).toEqual([{ kind: "born", mutant: next.mutants[0] }]);
	});

	it("reports a status change as a flip carrying the previous status", () => {
		const prev = parseManifest(manifest({ m1: { status: "survived" } }));
		const next = parseManifest(manifest({ m1: { status: "killed" } }));
		expect(diffSnapshots(prev, next)).toEqual([{ kind: "flip", mutant: next.mutants[0], from: "survived" }]);
	});

	it("emits nothing when nothing changed", () => {
		const snap = parseManifest(manifest({ m1: { status: "killed" } }));
		expect(diffSnapshots(snap, snap)).toEqual([]);
	});

	it("does not report a disappearance", () => {
		const prev = parseManifest(manifest({ m1: { status: "killed" } }));
		expect(diffSnapshots(prev, emptySnapshot())).toEqual([]);
	});
});

describe("createMutantWatcher", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "viz-mutant-watch-"));
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("emits events when the manifest changes on disk", () => {
		const path = join(dir, "mutation-manifest.json");
		writeFileSync(path, manifest({ m1: { status: "survived" } }));
		const seen: MutantEvent[] = [];
		const watcher = createMutantWatcher(path, (e) => seen.push(e), 100);

		writeFileSync(path, manifest({ m1: { status: "killed" }, m2: { status: "killed" } }));
		vi.advanceTimersByTime(150);
		watcher.stop();

		expect(seen.map((e) => e.kind)).toEqual(["flip", "born"]);
	});

	it("emits nothing while the manifest is untouched", () => {
		const path = join(dir, "mutation-manifest.json");
		writeFileSync(path, manifest({ m1: { status: "killed" } }));
		const seen: MutantEvent[] = [];
		const watcher = createMutantWatcher(path, (e) => seen.push(e), 100);
		vi.advanceTimersByTime(500);
		watcher.stop();
		expect(seen).toEqual([]);
	});
});
