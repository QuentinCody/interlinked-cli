import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { withProposedFiles } from "./checks/proposed-files.js";
import {
	type CheckerConfigSelection,
	configFingerprintOf,
	configGraphFor,
	selectCheckerConfig,
} from "./config-graph.js";

// Session review r5 (2026-09-06), finding 1: the batch gate disclosed a
// configuration rewrite by FILENAME (`tsconfig*.json`, `jsconfig.json`,
// `package.json`), so a batch that rewrote `base.json` — the target of the
// project's `extends` — was type-checked under the disk's options and reported
// clean while the materialized program was TS2322. The graph below is what the
// type checker actually READS for a file: the tsconfig that GOVERNS it (review
// r6, finding 2: selected the way `self_import` selects it, never the project
// root's config by default) plus every file its `extends` chain pulls in,
// resolved by TypeScript itself and read through the batch's proposed view.

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "config-graph-"));
	roots.push(root);
	return root;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

/** The graph for a (usually unwritten) file under `root`, with `root` as the project root. */
function graphOf(root: string, ...file: string[]): Set<string> {
	return new Set(configGraphFor(join(root, ...file), root));
}

describe("configGraphFor — positive (the files the checker reads)", () => {
	it("P1: the project's tsconfig and its custom-named `extends` target (the reviewer's base.json)", () => {
		const root = tempRoot();
		writeFileSync(join(root, "base.json"), json({ compilerOptions: { strictNullChecks: false } }));
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./base.json", include: ["*.ts"] }));
		expect(graphOf(root, "widget.ts")).toEqual(new Set([join(root, "tsconfig.json"), join(root, "base.json")]));
	});

	it("P2: a chained `extends` lists every link, in any directory", () => {
		const root = tempRoot();
		mkdirSync(join(root, "shared"), { recursive: true });
		writeFileSync(join(root, "shared", "compiler.json"), json({ compilerOptions: { strict: true } }));
		writeFileSync(join(root, "base.json"), json({ extends: "./shared/compiler.json" }));
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./base.json" }));
		expect(graphOf(root, "a.ts")).toEqual(
			new Set([join(root, "tsconfig.json"), join(root, "base.json"), join(root, "shared", "compiler.json")]),
		);
	});

	it("P3: an `extends` ARRAY lists every entry", () => {
		const root = tempRoot();
		writeFileSync(join(root, "a.json"), json({ compilerOptions: { strict: true } }));
		writeFileSync(join(root, "b.json"), json({ compilerOptions: { noEmit: true } }));
		writeFileSync(join(root, "tsconfig.json"), json({ extends: ["./a.json", "./b.json"] }));
		expect(graphOf(root, "a.ts")).toEqual(new Set([join(root, "tsconfig.json"), join(root, "a.json"), join(root, "b.json")]));
	});

	it("P4: reads the batch's PROPOSED view first — a base the batch introduces through a rewritten tsconfig is on the graph", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { strict: true } }));
		const view = new Map<string, string>([
			[join(root, "tsconfig.json"), json({ extends: "./new-base.json" })],
			[join(root, "new-base.json"), json({ compilerOptions: { strict: false } })],
		]);
		const graph = withProposedFiles(view, () => graphOf(root, "a.ts"));
		expect(graph).toEqual(new Set([join(root, "tsconfig.json"), join(root, "new-base.json")]));
	});

	it("P5: a tsconfig ABOVE the file governs it when its patterns claim the file", () => {
		const root = tempRoot();
		mkdirSync(join(root, "packages", "app"), { recursive: true });
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { strict: true } }));
		expect(new Set(configGraphFor(join(root, "packages", "app", "x.ts"), join(root, "packages", "app")))).toEqual(
			new Set([join(root, "tsconfig.json")]),
		);
	});

	it("P6: follows the project that CLAIMS the file — the sibling tsconfig.app.json and its base, not the root tsconfig (review r6, finding 2)", () => {
		const root = tempRoot();
		mkdirSync(join(root, "modules"), { recursive: true });
		writeFileSync(join(root, "build.ts"), "export const build = 1;\n");
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { strict: true }, files: ["build.ts"] }));
		writeFileSync(join(root, "app-base.json"), json({ compilerOptions: { moduleSuffixes: [".native", ""] } }));
		writeFileSync(join(root, "tsconfig.app.json"), json({ extends: "./app-base.json", include: ["modules"] }));
		expect(graphOf(root, "modules", "widget.ts")).toEqual(new Set([join(root, "tsconfig.app.json"), join(root, "app-base.json")]));
	});
});

describe("configGraphFor — negative (nothing invented)", () => {
	it("N1: no tsconfig within reach — an empty graph", () => {
		const root = tempRoot();
		mkdirSync(join(root, "a", "b", "c", "d", "e", "f"), { recursive: true });
		const deep = join(root, "a", "b", "c", "d", "e", "f");
		expect(configGraphFor(join(deep, "x.ts"), deep)).toEqual([]);
	});

	it("N2: an unparsable tsconfig is itself on the graph, and nothing throws", () => {
		const root = tempRoot();
		writeFileSync(join(root, "tsconfig.json"), "{ this is not json");
		expect(graphOf(root, "a.ts")).toEqual(new Set([join(root, "tsconfig.json")]));
	});

	it("N3: a JSON file beside the config that nothing extends is NOT on the graph", () => {
		const root = tempRoot();
		writeFileSync(join(root, "data.json"), json({ rows: [] }));
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { strict: true } }));
		expect(graphOf(root, "a.ts").has(join(root, "data.json"))).toBe(false);
	});

	it("N4: a file no project claims keeps the nearest config as its graph — the disclosure root, never a guessed program", () => {
		const root = tempRoot();
		mkdirSync(join(root, "lib"), { recursive: true });
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { strict: true }, include: ["src"] }));
		expect(graphOf(root, "lib", "orphan.ts")).toEqual(new Set([join(root, "tsconfig.json")]));
	});
});

// The selection the compiler phase and the graph share (review r6, finding 2).
describe("selectCheckerConfig — the one program every phase judges", () => {
	it("P7: the sibling project that claims the file is the checker's config", () => {
		const root = tempRoot();
		mkdirSync(join(root, "modules"), { recursive: true });
		writeFileSync(join(root, "build.ts"), "export const build = 1;\n");
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { strict: true }, files: ["build.ts"] }));
		writeFileSync(join(root, "tsconfig.app.json"), json({ compilerOptions: { strict: true }, include: ["modules"] }));
		const selection: CheckerConfigSelection = selectCheckerConfig(ts, join(root, "modules", "widget.ts"), root);
		expect(selection).toEqual({ kind: "config", configPath: join(root, "tsconfig.app.json") });
	});

	it("N5: a file no project claims is not_measured with the orphan reason and the nearest config as its disclosure root", () => {
		const root = tempRoot();
		mkdirSync(join(root, "lib"), { recursive: true });
		writeFileSync(join(root, "tsconfig.json"), json({ compilerOptions: { strict: true }, include: ["src"] }));
		expect(selectCheckerConfig(ts, join(root, "lib", "orphan.ts"), root)).toMatchObject({
			kind: "not_measured",
			reason: "project_orphan",
			configPath: join(root, "tsconfig.json"),
		});
	});

	it("N6: no tsconfig in reach is `none` — the overlay does not apply", () => {
		const root = tempRoot();
		mkdirSync(join(root, "a", "b", "c", "d", "e", "f"), { recursive: true });
		const deep = join(root, "a", "b", "c", "d", "e", "f");
		expect(selectCheckerConfig(ts, join(deep, "x.ts"), deep)).toEqual({ kind: "none" });
	});
});

// The identity a warm compiler service is checked against before reuse
// (review r7, finding 2): every file of the config's `extends` closure,
// stamped by mtime and size.
describe("configFingerprintOf — the configuration identity of a service", () => {
	it("P8: changes when an `extends` target changes on disk while the root config is untouched", () => {
		const root = tempRoot();
		writeFileSync(join(root, "base.json"), json({ compilerOptions: { strictNullChecks: false } }));
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./base.json" }));
		const before = configFingerprintOf(ts, join(root, "tsconfig.json"));
		writeFileSync(join(root, "base.json"), json({ compilerOptions: { strictNullChecks: true } }));
		expect(configFingerprintOf(ts, join(root, "tsconfig.json"))).not.toBe(before);
	});

	it("P9: a same-size rewrite of an `extends` target that preserves its timestamp still changes the fingerprint (review r8, finding 2)", () => {
		const root = tempRoot();
		const base = join(root, "base.json");
		writeFileSync(base, '{"compilerOptions":{"strictNullChecks":false}}');
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./base.json" }));
		const before = configFingerprintOf(ts, join(root, "tsconfig.json"));
		const stat = statSync(base);
		writeFileSync(base, '{"compilerOptions":{"strictNullChecks":true }}');
		utimesSync(base, stat.atime, stat.mtime);
		expect(statSync(base).size).toBe(stat.size);
		expect(configFingerprintOf(ts, join(root, "tsconfig.json"))).not.toBe(before);
	});

	it("N7: is stable across two lookups with nothing changed, and names every file of the closure", () => {
		const root = tempRoot();
		writeFileSync(join(root, "base.json"), json({ compilerOptions: { strict: true } }));
		writeFileSync(join(root, "tsconfig.json"), json({ extends: "./base.json" }));
		const first = configFingerprintOf(ts, join(root, "tsconfig.json"));
		expect(configFingerprintOf(ts, join(root, "tsconfig.json"))).toBe(first);
		expect(first).toContain(join(root, "tsconfig.json"));
		expect(first).toContain(join(root, "base.json"));
	});
});
