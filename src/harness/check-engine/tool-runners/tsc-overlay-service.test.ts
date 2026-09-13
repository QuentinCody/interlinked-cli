// Smoke coverage for the extracted LS-construction module. Full behavioral
// coverage (sibling overlays, cross-file resolution, missing-typescript
// degrade) lives in tsc-overlay.test.ts / tsc-overlay.no-typescript.test.ts,
// which exercise the same code through the dispatcher in "in-process" mode.

import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { DiskRead } from "./tsc-overlay-identity.js";
import {
	buildLanguageServiceHost,
	clearOverlayServiceCache,
	diagnosticSeverity,
	OVERLAY_EXT,
	runOverlayCheckInProcess,
	runOverlayCheckInProcessTyped,
} from "./tsc-overlay-service.js";

const created: string[] = [];

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-service-"));
	created.push(dir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
			},
			include: ["*.ts"],
		}),
	);
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		clearOverlayServiceCache(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("tsc-overlay-service", () => {
	it("resolves proposed siblings in directories that do not yet exist on disk", () => {
		const dir = project({});
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
			compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true },
			include: ["**/*.ts"],
		}));
		const out = runOverlayCheckInProcess({
			projectRoot: dir,
			filePath: join(dir, "new/a.ts"),
			content: 'import { value } from "../deps/b.js"; export const x: number = value;',
			siblings: [{ filePath: join(dir, "deps/b.ts"), content: 'export const value = "text";' }],
		});
		expect(out.some((r) => r.ruleId === "TS2322")).toBe(true);
		expect(out.some((r) => r.ruleId === "TS2307")).toBe(false);
	});

	// kind: public-api — positive (must fire)
	it("P1: OVERLAY_EXT matches .ts/.tsx/.mts/.cts", () => {
		expect(OVERLAY_EXT.test("a.ts")).toBe(true);
		expect(OVERLAY_EXT.test("a.tsx")).toBe(true);
		expect(OVERLAY_EXT.test("a.mts")).toBe(true);
		expect(OVERLAY_EXT.test("a.cts")).toBe(true);
	});

	// kind: public-api — negative (must not fire)
	it("N1: OVERLAY_EXT rejects non-TS extensions", () => {
		expect(OVERLAY_EXT.test("a.js")).toBe(false);
		expect(OVERLAY_EXT.test("a.md")).toBe(false);
	});

	// kind: public-api — positive (must fire)
	it("P2: runOverlayCheckInProcess finds a real type error in overlaid content", () => {
		const dir = project({ "a.ts": "export const x: number = 1;\n" });
		const out = runOverlayCheckInProcess({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: 'export const x: number = "not a number";\n',
		});
		expect(out.some((r) => r.ruleId === "TS2322")).toBe(true);
	});

	// kind: public-api — negative (must not fire)
	it("N2: runOverlayCheckInProcess returns [] for non-TS-overlayable files", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const out = runOverlayCheckInProcess({
			projectRoot: dir,
			filePath: join(dir, "a.md"),
			content: "# hi\n",
		});
		expect(out).toEqual([]);
	});

	it("clearOverlayServiceCache(projectRoot) and clearOverlayServiceCache() both run without throwing", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		runOverlayCheckInProcess({ projectRoot: dir, filePath: join(dir, "a.ts"), content: "export const x = 1;\n" });
		expect(() => clearOverlayServiceCache(dir)).not.toThrow();
		expect(() => clearOverlayServiceCache()).not.toThrow();
	});
});

// Session review r6 (2026-09-06), finding 2: the compiler took the tsconfig
// nearest the PROJECT ROOT and forced the target into that program, while
// `self_import` selected the project that CLAIMS the file. The two now agree:
// one service per governing config, and a file no single project claims is
// NOT MEASURED rather than judged under the wrong options.
describe("runOverlayCheckInProcessTyped — the governing project (review r6, finding 2)", () => {
	const OPTIONS = { module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: true };

	/** The reviewer's solution: a root tsconfig that claims only `build.ts` and
	 *  an independent `tsconfig.app.json` (never referenced) that claims
	 *  `modules/` under `moduleSuffixes`. */
	function solution(): string {
		const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-service-r6-"));
		created.push(dir);
		mkdirSync(join(dir, "modules"), { recursive: true });
		writeFileSync(join(dir, "build.ts"), "export const build = 1;\n");
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: OPTIONS, files: ["build.ts"] }));
		writeFileSync(
			join(dir, "tsconfig.app.json"),
			JSON.stringify({ compilerOptions: { ...OPTIONS, moduleSuffixes: [".native", ""] }, include: ["modules"] }),
		);
		writeFileSync(join(dir, "modules", "widget.native.ts"), "export const value = 1;\n");
		return dir;
	}

	it("P6: judges a file under the sibling project that claims it — the suffix re-export is not circular", () => {
		const dir = solution();
		const run = runOverlayCheckInProcessTyped({
			projectRoot: dir,
			filePath: join(dir, "modules", "widget.ts"),
			content: 'export { value } from "./widget.js";\n',
		});
		expect(run).toEqual({ status: "ok", findings: [] });
	});

	it("N6: control — a real type error under that same project is still found", () => {
		const dir = solution();
		const run = runOverlayCheckInProcessTyped({
			projectRoot: dir,
			filePath: join(dir, "modules", "widget.ts"),
			content: 'import { value } from "./widget.js";\nexport const s: string = value;\n',
		});
		expect(run).toMatchObject({ status: "ok", findings: [expect.objectContaining({ ruleId: "TS2322" })] });
	});

	it("N7: a file no project claims is NOT MEASURED, never forced into the root program", () => {
		const dir = solution();
		const run = runOverlayCheckInProcessTyped({
			projectRoot: dir,
			filePath: join(dir, "orphan.ts"),
			content: "export const orphan: number = 1;\n",
		});
		expect(run).toMatchObject({ status: "not_measured", reason: expect.stringContaining("project_orphan") });
	});

	it("N8: a file two sibling projects claim is NOT MEASURED (project_ambiguous)", () => {
		const dir = solution();
		writeFileSync(join(dir, "tsconfig.other.json"), JSON.stringify({ compilerOptions: OPTIONS, include: ["modules"] }));
		const run = runOverlayCheckInProcessTyped({
			projectRoot: dir,
			filePath: join(dir, "modules", "widget.ts"),
			content: "export const x = 2;\n",
		});
		expect(run).toMatchObject({ status: "not_measured", reason: expect.stringContaining("project_ambiguous") });
	});
});

// Session review r7 (2026-09-06): (1) a configured project with NO source on
// disk yet built no service (the disk parse listed no inputs), so the first
// proposed source was answered "ok, no findings" — unmeasured, reported clean;
// (2) a warm service was reused by its config path alone, so an `extends`
// target rewritten on disk left the service judging under the old options.
describe("runOverlayCheckInProcessTyped — construction and reuse (review r7)", () => {
	const OPTIONS = { module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: true };

	/** A tsconfig extending `base.json`; `baseOptions` overlays the strict defaults. */
	function inherited(baseOptions: Record<string, unknown>): { dir: string; base: string } {
		const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-service-r7-"));
		created.push(dir);
		const base = join(dir, "base.json");
		writeFileSync(base, JSON.stringify({ compilerOptions: { ...OPTIONS, ...baseOptions } }));
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./base.json", include: ["*.ts"] }));
		return { dir, base };
	}

	const NULL_STRING = "export const value: string = null;\n";
	const TS2322 = { status: "ok", findings: [expect.objectContaining({ ruleId: "TS2322" })] };

	it("P9: an EMPTY configured project — the config claims the target, nothing on disk yet — still measures the first proposed source", () => {
		const { dir } = inherited({});
		const run = runOverlayCheckInProcessTyped({
			projectRoot: dir,
			filePath: join(dir, "widget.ts"),
			content: 'export const count: number = "wrong";\n',
		});
		expect(run).toMatchObject(TS2322);
	});

	it("P10: a warm service is rebuilt when an inherited config TIGHTENS on disk — the same bytes now fail", () => {
		const { dir, base } = inherited({ strictNullChecks: false });
		writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
		const input = { projectRoot: dir, filePath: join(dir, "widget.ts"), content: NULL_STRING };
		expect(runOverlayCheckInProcessTyped(input)).toEqual({ status: "ok", findings: [] });
		writeFileSync(base, JSON.stringify({ compilerOptions: { ...OPTIONS, strictNullChecks: true } }));
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(TS2322);
	});

	it("P11: a warm service is rebuilt when an inherited config LOOSENS on disk — the same bytes now pass", () => {
		const { dir, base } = inherited({ strictNullChecks: true });
		writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
		const input = { projectRoot: dir, filePath: join(dir, "widget.ts"), content: NULL_STRING };
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(TS2322);
		writeFileSync(base, JSON.stringify({ compilerOptions: { ...OPTIONS, strictNullChecks: false } }));
		expect(runOverlayCheckInProcessTyped(input)).toEqual({ status: "ok", findings: [] });
	});

	// Session review r8 (2026-09-06), both in the in-process mode: (1) the root
	// file list was frozen at construction, so a declaration file added or
	// removed on disk never joined or left the warm service's program; (2) the
	// configuration fingerprint was mtime + size, so a same-size rewrite that
	// preserved its timestamp kept the stale options. Roots are re-enumerated
	// on every reuse; the fingerprint is the files' content.
	const USES_GLOBAL = "export const v: number = MY_GLOBAL;\n";
	const TS2304 = { status: "ok", findings: [expect.objectContaining({ ruleId: "TS2304" })] };

	it("P12: a declaration file ADDED on disk joins the warm service's program (review r8, finding 1)", () => {
		const { dir } = inherited({});
		writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
		const input = { projectRoot: dir, filePath: join(dir, "widget.ts"), content: USES_GLOBAL };
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(TS2304);
		writeFileSync(join(dir, "env.d.ts"), "declare const MY_GLOBAL: number;\n");
		expect(runOverlayCheckInProcessTyped(input)).toEqual({ status: "ok", findings: [] });
	});

	it("P13: a declaration file REMOVED on disk leaves the warm service's program (review r8, finding 1)", () => {
		const { dir } = inherited({});
		writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
		writeFileSync(join(dir, "env.d.ts"), "declare const MY_GLOBAL: number;\n");
		const input = { projectRoot: dir, filePath: join(dir, "widget.ts"), content: USES_GLOBAL };
		expect(runOverlayCheckInProcessTyped(input)).toEqual({ status: "ok", findings: [] });
		rmSync(join(dir, "env.d.ts"));
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(TS2304);
	});

	// Session review r9 (2026-09-06), both in the in-process mode: (1) clearing
	// the primary overlay FROZE its snapshot version, so a proposal that never
	// reached disk stayed the file's content for every later check; (2) a
	// dependency's snapshot refreshed only when its mtime INCREASED, so a
	// rewrite that preserved or lowered the timestamp stayed stale.
	const NUMBER_EXPORT = "export const value = 1;\n";
	const STRING_EXPORT = 'export const value = "changed";\n';
	const CONSUMER = 'import { value } from "./value.js";\nexport const count: number = value;\n';

	function pair(exporter: string): { dir: string; exporterPath: string; consumerPath: string } {
		const { dir } = inherited({});
		const exporterPath = join(dir, "value.ts");
		const consumerPath = join(dir, "consumer.ts");
		writeFileSync(exporterPath, exporter);
		writeFileSync(consumerPath, CONSUMER);
		return { dir, exporterPath, consumerPath };
	}

	// Both cases warm the service on the CONSUMER first, so the dependency's
	// snapshot exists before the rejected proposal — without that warmup the
	// first consumer check reads the dependency fresh and the regression never
	// shows (review r10, finding 2).
	it("P15: a REJECTED proposal for a dependency does not make later valid code fail (review r9, finding 1)", () => {
		const { dir, exporterPath, consumerPath } = pair(NUMBER_EXPORT);
		const consumer = { projectRoot: dir, filePath: consumerPath, content: CONSUMER };
		expect(runOverlayCheckInProcessTyped(consumer)).toEqual({ status: "ok", findings: [] });
		expect(runOverlayCheckInProcessTyped({ projectRoot: dir, filePath: exporterPath, content: STRING_EXPORT })).toEqual({ status: "ok", findings: [] });
		expect(runOverlayCheckInProcessTyped(consumer)).toEqual({ status: "ok", findings: [] });
	});

	it("P16: a REJECTED repair of a dependency does not make later invalid code pass (review r9, finding 1)", () => {
		const { dir, exporterPath, consumerPath } = pair(STRING_EXPORT);
		const consumer = { projectRoot: dir, filePath: consumerPath, content: CONSUMER };
		expect(runOverlayCheckInProcessTyped(consumer)).toMatchObject(TS2322);
		expect(runOverlayCheckInProcessTyped({ projectRoot: dir, filePath: exporterPath, content: NUMBER_EXPORT })).toEqual({ status: "ok", findings: [] });
		expect(runOverlayCheckInProcessTyped(consumer)).toMatchObject(TS2322);
	});

	it("P17: a dependency rewritten on disk with its timestamp PRESERVED is seen by the next check (review r9, finding 2)", () => {
		const { dir, exporterPath, consumerPath } = pair(NUMBER_EXPORT);
		const input = { projectRoot: dir, filePath: consumerPath, content: CONSUMER };
		expect(runOverlayCheckInProcessTyped(input)).toEqual({ status: "ok", findings: [] });
		const stat = statSync(exporterPath);
		writeFileSync(exporterPath, STRING_EXPORT);
		utimesSync(exporterPath, stat.atime, stat.mtime);
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(TS2322);
	});

	it("P18: a dependency rewritten on disk with an OLDER timestamp is seen by the next check (review r9, finding 2)", () => {
		const { dir, exporterPath, consumerPath } = pair(NUMBER_EXPORT);
		const input = { projectRoot: dir, filePath: consumerPath, content: CONSUMER };
		expect(runOverlayCheckInProcessTyped(input)).toEqual({ status: "ok", findings: [] });
		writeFileSync(exporterPath, STRING_EXPORT);
		const older = new Date("2020-01-01T00:00:00Z");
		utimesSync(exporterPath, older, older);
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(TS2322);
	});

	it("P14: a same-size config rewrite that preserves its timestamp still rebuilds the warm service (review r8, finding 2)", () => {
		const { dir, base } = inherited({ strictNullChecks: false });
		writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
		const input = { projectRoot: dir, filePath: join(dir, "widget.ts"), content: NULL_STRING };
		expect(runOverlayCheckInProcessTyped(input)).toEqual({ status: "ok", findings: [] });
		const lenient = JSON.stringify({ compilerOptions: { ...OPTIONS, strictNullChecks: false } });
		const stat = statSync(base);
		writeFileSync(base, lenient.replace('"strictNullChecks":false}', '"strictNullChecks":true }'));
		utimesSync(base, stat.atime, stat.mtime);
		expect(statSync(base).size).toBe(stat.size);
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(TS2322);
	});
});

describe("UTF-16 dependency identity (review r12)", () => {
	const surrogates = [["high", "\ud800"], ["low", "\udc00"]] as const;
	const typeError = { status: "ok", findings: [expect.objectContaining({ ruleId: "TS2322" })] };
	const clean = { status: "ok", findings: [] };

	function fixture(literal: string) {
		const content = `import { value } from "./value.js";\nexport const result: ${JSON.stringify(literal)} = value;\n`;
		const dir = project({ "consumer.ts": content, "value.ts": "" });
		const exporter = join(dir, "value.ts");
		return {
			input: { projectRoot: dir, filePath: join(dir, "consumer.ts"), content },
			replace: (character: string) => {
				const text = `export const value = "${character}" as const;\n`;
				writeFileSync(exporter, Buffer.from(`\ufeff${text}`, "utf16le"));
				expect(ts.sys.readFile(exporter)).toBe(text);
			},
		};
	}

	it.each(surrogates)("detects an invalid assignment after replacing a %s surrogate", (_name, literal) => {
		const { input, replace } = fixture(literal);
		replace(literal);
		expect(runOverlayCheckInProcessTyped(input)).toEqual(clean);
		replace("\ufffd");
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(typeError);
		clearOverlayServiceCache(input.projectRoot);
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(typeError);
	});

	it.each(surrogates)("accepts a repaired assignment after restoring a %s surrogate", (_name, literal) => {
		const { input, replace } = fixture(literal);
		replace("\ufffd");
		expect(runOverlayCheckInProcessTyped(input)).toMatchObject(typeError);
		replace(literal);
		expect(runOverlayCheckInProcessTyped(input)).toEqual(clean);
		clearOverlayServiceCache(input.projectRoot);
		expect(runOverlayCheckInProcessTyped(input)).toEqual(clean);
	});
});

// Session review r10 (2026-09-06), finding 1: a write through a shared memory
// mapping changes a file's bytes before any timestamp moves (POSIX permits the
// delay until flush), so mtime, ctime and size are not identity. The host now
// versions a root file by its CONTENT (one read per file per run — the run
// memo is cleared here the way overlayDiagnostics clears it at run start).
describe("buildLanguageServiceHost — a root file's version follows its bytes (review r10)", () => {
	function hostFor(dir: string): { host: import("typescript").LanguageServiceHost; runReads: Map<string, DiskRead> } {
		const ctx = {
			ts,
			service: null,
			projectRoot: dir,
			configFingerprint: "",
			tsconfigPath: join(dir, "tsconfig.json"),
			tsconfigDir: dir,
			rootFileNames: ["a.ts"],
			overlay: null,
			siblings: new Map<string, string>(),
			versions: new Map<string, number>(),
			identities: new Map<string, string>(),
			runReads: new Map<string, DiskRead>(),
		};
		return { host: buildLanguageServiceHost(ctx, ts, dir, {}), runReads: ctx.runReads };
	}

	it("P19: rewritten bytes with the timestamps restored still bump the version", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const { host, runReads } = hostFor(dir);
		const file = join(dir, "a.ts");
		const first = host.getScriptVersion(file);
		const stat = statSync(file);
		writeFileSync(file, "export const x = 2;\n");
		utimesSync(file, stat.atime, stat.mtime);
		runReads.clear();
		expect(host.getScriptVersion(file)).not.toBe(first);
	});

	it("N9: a touch that moves every timestamp but changes no byte keeps the version", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const { host, runReads } = hostFor(dir);
		const file = join(dir, "a.ts");
		const first = host.getScriptVersion(file);
		const later = new Date("2030-01-01T00:00:00Z");
		utimesSync(file, later, later);
		runReads.clear();
		expect(host.getScriptVersion(file)).toBe(first);
	});
});

// ===========================================================================
// diagnosticSeverity — pure category mapper. buildOverlayResults only ever
// exercises the Error branch through a real overlaid type error (see P2
// above); these fixtures drive the Warning and "neither" branches directly,
// since no genuine tsc diagnostic in this project's config is emitted as a
// Warning or Suggestion.
// ===========================================================================

describe("diagnosticSeverity", () => {
	function fakeDiagnostic(category: import("typescript").DiagnosticCategory): import("typescript").Diagnostic {
		// SAFETY: diagnosticSeverity reads only `.category` — a minimal fixture
		// with the rest of Diagnostic's fields omitted is sound for this test.
		return { category } as unknown as import("typescript").Diagnostic;
	}

	// kind: category-mapping — positive (must fire)
	it("P3: maps a Warning-category diagnostic to 'warning'", () => {
		expect(diagnosticSeverity(ts, fakeDiagnostic(ts.DiagnosticCategory.Warning))).toBe("warning");
	});

	// kind: category-mapping — negative (must not fire)
	it("N3: maps a Suggestion-category diagnostic (neither Error nor Warning) to null", () => {
		expect(diagnosticSeverity(ts, fakeDiagnostic(ts.DiagnosticCategory.Suggestion))).toBeNull();
	});
});

// ===========================================================================
// buildLanguageServiceHost — the assembled LanguageServiceHost object.
// getOrCreateService only ever hands this to `ts.createLanguageService`,
// which invokes `.readDirectory` itself only via completions or project
// references (neither of which runOverlayCheckInProcess exercises) — calling
// the built host's own `readDirectory` hook directly is the only way to prove
// that specific wiring (including its private `hostReadDirectory` delegate,
// which has no importer outside this module) without depending on that
// unrelated internal TS path.
// ===========================================================================

describe("buildLanguageServiceHost", () => {
	// kind: host-wiring — positive (must fire)
	it("P5: the built host's readDirectory hook forwards the include glob to the real directory listing", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		writeFileSync(join(dir, "notes.txt"), "not typescript\n");
		const ctx = {
			ts,
			service: null,
			projectRoot: dir,
			configFingerprint: "",
			tsconfigPath: join(dir, "tsconfig.json"),
			tsconfigDir: dir,
			rootFileNames: ["a.ts"],
			overlay: null,
			siblings: new Map<string, string>(),
			versions: new Map<string, number>(),
			identities: new Map<string, string>(),
			runReads: new Map<string, DiskRead>(),
		};
		const host = buildLanguageServiceHost(ctx, ts, dir, {});

		// No `extensions` filter passed — an empty result, or notes.txt present,
		// can only happen if the `include` glob arg was dropped/ignored rather
		// than forwarded (verified: ts.sys.readDirectory(dir, undefined,
		// undefined, undefined) returns BOTH files; only adding `include` back
		// excludes notes.txt).
		const files = host.readDirectory?.(dir, undefined, undefined, ["*.ts"]) ?? [];

		expect(files.some((f: string) => f.endsWith("a.ts"))).toBe(true);
		expect(files.some((f: string) => f.endsWith("notes.txt"))).toBe(false);
	});
});
