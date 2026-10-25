// Tests for the codebase_existing scanner — walks the working tree,
// runs registry inline detectors against each file, optionally records
// codebase_existing recurrence events for repeated patterns.

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recurrenceScanCommand } from "../../commands/recurrence.js";
import { nonNull } from "../../lib/non-null.js";
import type { DetectorFinding } from "../checks/endpoint-security.js";
import { loadRecurrenceEvents } from "../recurrence.js";
import {
	type ScanCodebaseFinding,
	scanCIFilesForRecurrences,
	scanCodebaseForRecurrences,
	scanFilesForDetector,
} from "../recurrence-scanner.js";

// Partial node:fs mock: every function is the REAL implementation except
// `lstatSync` / `readFileSync`, which can be steered (per-test, via the
// module-level control vars below) to throw or to report a "neither file
// nor directory" entry — exercising `walk()`'s two hard-to-reach branches
// (a TOCTOU-style lstat failure, and a socket/FIFO-shaped entry) and the
// unreadable-file skip path, without disturbing any other test's real
// filesystem usage.
let lstatThrowPath: string | null = null;
let lstatWeirdPath: string | null = null;
let readFileSyncThrowPath: string | null = null;
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
			const [path] = args;
			if (lstatThrowPath && path === lstatThrowPath) {
				throw new Error("simulated lstat failure (TOCTOU race)");
			}
			if (lstatWeirdPath && path === lstatWeirdPath) {
				const stats = nonNull(actual.lstatSync(...args));
				if (stats === undefined) return undefined;
				stats.isSymbolicLink = () => false;
				stats.isDirectory = () => false;
				stats.isFile = () => false;
				return stats;
			}
			// Passthrough to the real overload set.
			return actual.lstatSync(...args);
		},
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			const [path] = args;
			if (readFileSyncThrowPath && path === readFileSyncThrowPath) {
				throw new Error("EACCES: permission denied (simulated)");
			}
			// Passthrough to the real overload set.
			return actual.readFileSync(...args);
		},
	};
});

afterEach(() => {
	lstatThrowPath = null;
	lstatWeirdPath = null;
	readFileSyncThrowPath = null;
});

// Every real detector is preserved; content containing the sentinel marker
// gets one EXTRA synthetic check appended whose `fn()` throws — exercising
// "a single buggy detector must not break the whole scan" without needing
// to find (or fabricate) a real detector bug.
const THROWING_DETECTOR_MARKER = "__RECURRENCE_SCANNER_TEST_THROWING_DETECTOR__";
// Content containing this marker gets one synthetic check that reports NOT
// MEASURED through the real check-root context and returns no findings.
const UNMEASURED_DETECTOR_MARKER = "__RECURRENCE_SCANNER_TEST_UNMEASURED_DETECTOR__";
vi.mock("../check-registry/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../check-registry/index.js")>();
	const { reportNotMeasured } = await import("../checks/check-root.js");
	return {
		...actual,
		buildAgentSafetyChecks: (...args: Parameters<typeof actual.buildAgentSafetyChecks>) => {
			const [content] = args;
			const real = actual.buildAgentSafetyChecks(...args);
			if (content.includes(THROWING_DETECTOR_MARKER)) {
				return [
					...real,
					{
						name: "test_throwing_detector",
						severity: "warning" as const,
						fn: () => {
							if (content.includes("__THROW_PLAIN_VALUE__")) throw "plain detector failure";
							throw new Error("simulated buggy detector");
						},
					},
				];
			}
			if (content.includes(UNMEASURED_DETECTOR_MARKER)) {
				return [
					...real,
					{
						name: "test_unmeasured_detector",
						severity: "warning" as const,
						fn: () => {
							reportNotMeasured("test_unmeasured_detector", "simulated missing prerequisite");
							return [];
						},
					},
				];
			}
			return real;
		},
	};
});

describe("scanCodebaseForRecurrences", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-scan-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fixture(relPath: string, content: string): string {
		const abs = join(dir, relPath);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
		return abs;
	}

	it("returns an empty list when no source files match", () => {
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		expect(findings).toEqual([]);
	});

	it("flags eval() usage in a TS file under src/", () => {
		fixture("src/bad.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		const evalHit = findings.find((f: ScanCodebaseFinding) => f.check_id === "eval_usage");
		expect(evalHit).toBeDefined();
		expect(evalHit?.file).toBe("src/bad.ts");
	});

	it("does not record events by default (dry run)", () => {
		fixture("src/bad.ts", "export const x = eval('1+1');\n");
		scanCodebaseForRecurrences({ cwd: dir });
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("when recordEvents=true, appends a codebase_existing event per finding", () => {
		fixture("src/a.ts", "export const x = eval('1+1');\n");
		fixture("src/b.ts", "export const y = eval('2+2');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir, recordEvents: true });
		expect(findings.length).toBeGreaterThanOrEqual(2);
		const events = loadRecurrenceEvents(dir);
		const evalEvents = events.filter((e) => e.check_id === "eval_usage");
		expect(evalEvents.length).toBeGreaterThanOrEqual(2);
		expect(evalEvents.every((e) => e.kind === "codebase_existing")).toBe(true);
		const files = new Set(evalEvents.map((e) => e.file));
		expect(files.has("src/a.ts")).toBe(true);
		expect(files.has("src/b.ts")).toBe(true);
	});

	it("skips node_modules / dist / build / vendor subtrees", () => {
		fixture("node_modules/foo/index.ts", "eval('x');\n");
		fixture("dist/bundle.ts", "eval('x');\n");
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		const files = new Set<string>(findings.map((f: ScanCodebaseFinding) => f.file));
		expect(files.has("src/keeper.ts")).toBe(true);
		expect([...files].some((f) => f.includes("node_modules"))).toBe(false);
		expect([...files].some((f) => f.startsWith("dist/"))).toBe(false);
	});

	it("limits which file extensions it inspects (TS/JS family by default)", () => {
		fixture("src/secret.txt", "eval('not source code');\n");
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		expect(findings.some((f: ScanCodebaseFinding) => f.file === "src/secret.txt")).toBe(false);
		expect(findings.some((f: ScanCodebaseFinding) => f.file === "src/keeper.ts")).toBe(true);
	});

	it("respects an explicit roots option (custom directory list)", () => {
		fixture("src/in.ts", "export const x = eval('1+1');\n");
		fixture("lib/in.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir, roots: ["lib"] });
		const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
		expect(files.has("lib/in.ts")).toBe(true);
		expect(files.has("src/in.ts")).toBe(false);
	});

	it("does not follow symlinked subdirectories", () => {
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		const externalDir = mkdtempSync(join(tmpdir(), "interlinked-scan-ext-"));
		try {
			writeFileSync(join(externalDir, "outside.ts"), "eval('outside');\n");
			try {
				symlinkSync(externalDir, join(dir, "src", "linked"), "dir");
			} catch (_err) {
				// Some test envs (e.g., locked-down Windows runners) reject
				// symlink creation; the behavior under test only matters when
				// symlinks exist, so skipping is the right call.
				return;
			}
			const findings = scanCodebaseForRecurrences({ cwd: dir });
			const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
			expect(files.has("src/keeper.ts")).toBe(true);
			expect([...files].some((f) => f.includes("linked"))).toBe(false);
			expect([...files].some((f) => f.endsWith("outside.ts"))).toBe(false);
		} finally {
			rmSync(externalDir, { recursive: true, force: true });
		}
	});

	it("skips a file whose content is unreadable (permission error / race) rather than throwing", () => {
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		fixture("src/cursed.ts", "export const y = eval('2+2');\n");
		readFileSyncThrowPath = join(dir, "src", "cursed.ts");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
		expect(files.has("src/keeper.ts")).toBe(true);
		expect(files.has("src/cursed.ts")).toBe(false);
	});

	it("skips a directory entry that vanishes between readdir and lstat (TOCTOU) without crashing", () => {
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		fixture("src/gone.ts", "export const y = eval('2+2');\n");
		lstatThrowPath = join(dir, "src", "gone.ts");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
		expect(files.has("src/keeper.ts")).toBe(true);
		expect(files.has("src/gone.ts")).toBe(false);
	});

	it("skips a directory entry that is neither a file nor a directory (socket/FIFO-shaped)", () => {
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		fixture("src/weird.ts", "export const y = eval('2+2');\n");
		lstatWeirdPath = join(dir, "src", "weird.ts");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
		expect(files.has("src/keeper.ts")).toBe(true);
		expect(files.has("src/weird.ts")).toBe(false);
	});

	it("defaults to process.cwd() when no cwd option is given", () => {
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		try {
			const findings = scanCodebaseForRecurrences();
			const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
			expect(files.has("src/keeper.ts")).toBe(true);
		} finally {
			cwdSpy.mockRestore();
		}
	});

	it.each([
		["", "simulated buggy detector"],
		["__THROW_PLAIN_VALUE__", "plain detector failure"],
	])("isolates a misbehaving inline detector and reports its failure: %s", (marker, reason) => {
		fixture(
			"src/mixed.ts",
			`export const x = eval('1+1'); // ${THROWING_DETECTOR_MARKER} ${marker}\n`,
		);
		const unavailable: string[] = [];
		const findings = scanCodebaseForRecurrences({ cwd: dir, onNotMeasured: line => unavailable.push(line) });
		// The real eval_usage detector still ran and reported; the synthetic
		// throwing detector was skipped rather than aborting the whole file.
		expect(findings.some((f: ScanCodebaseFinding) => f.check_id === "eval_usage")).toBe(true);
		expect(
			findings.some((f: ScanCodebaseFinding) => f.check_id === "test_throwing_detector"),
		).toBe(false);
		expect(unavailable).toContain(
			`[interlinked:test_throwing_detector] NOT MEASURED: src/mixed.ts: detector failed: ${reason}`,
		);
	});

	// Regression (2026-10-21): the scanner handed detectors a path relative to
	// `cwd`, so `extraneous_deps` resolved the nearest package.json against the
	// PROCESS cwd. Scanning a foreign clone from this checkout read this repo's
	// manifest and flagged every dependency the clone declares.
	it("resolves package.json under the scan root, not the process cwd", () => {
		expect(process.cwd()).not.toBe(dir);
		fixture(
			"package.json",
			JSON.stringify({ name: "scan-root-fixture", dependencies: { "declared-dep-x": "1.0.0" } }),
		);
		fixture("src/uses-declared.ts", 'import { x } from "declared-dep-x";\nexport const y = x;\n');
		const clean = scanCodebaseForRecurrences({ cwd: dir, includeCI: false });
		expect(clean.filter((f) => f.check_id === "extraneous_deps")).toEqual([]);

		fixture("src/uses-undeclared.ts", 'import { z } from "undeclared-dep-y";\nexport const w = z;\n');
		const dirty = scanCodebaseForRecurrences({ cwd: dir, includeCI: false });
		const hits = dirty.filter((f) => f.check_id === "extraneous_deps");
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ file: "src/uses-undeclared.ts", line: 1 });
	});
});

// Regression (2026-10-21, round 3): `recurrence scan --cwd <dir>` from another
// process cwd let the graph-reading detectors read the PROCESS cwd. The
// `*AtCwd` registry wrappers defaulted to process.cwd(), so `dead_exports` and
// `untested_idempotent` read this checkout's git listing; and
// `conditional_empty_object_spread` resolved `typescript` from process.cwd(),
// so a tree without its own node_modules got a silent empty result. The scan
// now binds the root through `withCheckRoot`, and `typescript` resolves from
// the harness's own installation first.
describe("recurrence scan --cwd — the scan root, not the process cwd", () => {
	let dir: string;

	const SPREAD = "export const make = (flag: boolean) => ({ ...(flag ? { a: 1 } : {}) });\n";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-scan-root-"));
		const files: Record<string, string> = {
			"src/lib.ts": "export function usedFn(): number {\n\treturn 1;\n}\nexport function unusedFn(): number {\n\treturn 2;\n}\n",
			"src/main.ts": 'import { usedFn } from "./lib.js";\nconsole.log(usedFn());\n',
			"src/norm.ts": "export function normalizeName(name: string): string {\n\treturn name.trim().toLowerCase();\n}\n",
			"src/codec.ts":
				"export function encodeToken(s: string): string {\n\treturn btoa(s);\n}\nexport function decodeToken(s: string): string {\n\treturn atob(s);\n}\n",
			"src/cycle-a.ts": 'import { b } from "./cycle-b.js";\nexport const a = (): number => b() + 1;\n',
			"src/cycle-b.ts": 'import { a } from "./cycle-a.js";\nexport const b = (): number => a() - 1;\n',
			"src/spread.ts": SPREAD,
		};
		for (const [rel, content] of Object.entries(files)) {
			mkdirSync(join(dir, rel, ".."), { recursive: true });
			writeFileSync(join(dir, rel), content);
		}
		// A git work tree (no commits, no node_modules): the graph-reading
		// detectors list files with `git ls-files --others`.
		execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function scanJson(opts: { cwd?: string }): Promise<ScanCodebaseFinding[]> {
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			out.push(String(line));
		});
		try {
			await recurrenceScanCommand({ ...opts, json: true });
		} finally {
			log.mockRestore();
		}
		const parsed: unknown = JSON.parse(out.join("\n"));
		if (!Array.isArray(parsed)) throw new Error("scan --json did not print an array");
		return parsed as ScanCodebaseFinding[];
	}

	function countsByCheck(findings: ScanCodebaseFinding[]): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const f of findings) counts[f.check_id] = (counts[f.check_id] ?? 0) + 1;
		return counts;
	}

	it("P1: --cwd from another process cwd gives the same per-detector counts as a scan from inside the tree", async () => {
		expect(process.cwd()).not.toBe(dir);
		const fromOutside = countsByCheck(await scanJson({ cwd: dir }));

		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		let fromInside: Record<string, number>;
		try {
			fromInside = countsByCheck(await scanJson({}));
		} finally {
			cwdSpy.mockRestore();
		}

		expect(fromOutside).toEqual(fromInside);
		// The comparison is not vacuous: each graph- or package-reading detector
		// measured the fixture.
		// unusedFn, normalizeName, encodeToken, decodeToken, make: nothing imports them.
		expect(fromOutside.dead_exports).toBe(5);
		expect(fromOutside.untested_idempotent).toBe(1);
		expect(fromOutside.untested_inverse_pair).toBeGreaterThan(0);
		expect(fromOutside.circular_imports).toBeGreaterThan(0);
	});

	it("P2: conditional_empty_object_spread still fires in a tree without its own node_modules/typescript", async () => {
		const hits = (await scanJson({ cwd: dir })).filter(
			(f) => f.check_id === "conditional_empty_object_spread",
		);
		expect(hits).toEqual([expect.objectContaining({ file: "src/spread.ts", line: 1 })]);
	});

	it("N1: with no resolvable typescript, the detector returns no findings and reports NOT MEASURED", async () => {
		// Fresh copies of the detector and its context, loaded under a
		// `createRequire` that cannot resolve `typescript` from any base.
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			const createRequire = (base: string | URL) => {
				const real = actual.createRequire(base);
				return Object.assign((id: string): unknown => {
					if (id === "typescript") throw new Error("Cannot find module 'typescript' (simulated)");
					return real(id);
				}, real);
			};
			return { ...actual, createRequire, default: { ...actual, createRequire } };
		});
		vi.resetModules();
		try {
			const { detectConditionalEmptyObjectSpread } = await import("../checks/type-discipline.js");
			const { withCheckRoot } = await import("../checks/check-root.js");
			const run = withCheckRoot(dir, () => [
				...detectConditionalEmptyObjectSpread(SPREAD, join(dir, "src/spread.ts")),
				...detectConditionalEmptyObjectSpread(SPREAD, join(dir, "src/spread-2.ts")),
			]);
			expect(run.result).toEqual([]);
			expect(run.notMeasured).toHaveLength(1);
			expect(run.notMeasured[0]).toMatch(/^\[interlinked:conditional_empty_object_spread\] NOT MEASURED: /);
			expect(run.notMeasured[0]).toContain(dir);
		} finally {
			vi.doUnmock("node:module");
			vi.resetModules();
		}
	});

	it("P3: the scan hands each distinct NOT MEASURED line to onNotMeasured, once", () => {
		writeFileSync(join(dir, "src/unmeasured-1.ts"), `export const u1 = 1; // ${UNMEASURED_DETECTOR_MARKER}\n`);
		writeFileSync(join(dir, "src/unmeasured-2.ts"), `export const u2 = 2; // ${UNMEASURED_DETECTOR_MARKER}\n`);
		const lines: string[] = [];
		scanCodebaseForRecurrences({ cwd: dir, includeCI: false, onNotMeasured: (line) => lines.push(line) });
		expect(lines).toEqual([
			"[interlinked:test_unmeasured_detector] NOT MEASURED: simulated missing prerequisite",
		]);
	});

	it("N2: without onNotMeasured, the line goes to stderr and not into the --json stdout", async () => {
		writeFileSync(join(dir, "src/unmeasured.ts"), `export const u = 1; // ${UNMEASURED_DETECTOR_MARKER}\n`);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const findings = await scanJson({ cwd: dir });
		expect(findings.some((f) => f.check_id === "test_unmeasured_detector")).toBe(false);
		expect(stderr).toHaveBeenCalledWith(
			"[interlinked:test_unmeasured_detector] NOT MEASURED: simulated missing prerequisite\n",
		);
	});

	// Regression (2026-10-22, round 4): the type-discipline registry wrappers
	// (`checkDeadTypeExportsAtCwd`, `checkDuplicateTypeDeclarationAtCwd`) still
	// defaulted to process.cwd(), and `unknown_type_alias` resolved
	// `typescript` only from process.cwd() and cached the miss. Each fixture
	// type below separates the two roots: `UsedShape` is consumed only inside
	// the fixture, `CheckRegistration` is declared once in the fixture but
	// also in this checkout, and the fixture has no node_modules/typescript.
	const SHAPES = [
		"export interface UsedShape {\n\tid: number;\n}",
		"export interface DeadShape {\n\tid: number;\n}",
		"export interface CheckRegistration {\n\tid: string;\n}",
		"export interface TwinShape {\n\ta: number;\n}",
		"export type Opaque = unknown;",
	].join("\n");

	function writeTypeFixture(): void {
		writeFileSync(join(dir, "src/shapes.ts"), `${SHAPES}\n`);
		writeFileSync(join(dir, "src/twin.ts"), "export interface TwinShape {\n\tb: string;\n}\n");
		writeFileSync(
			join(dir, "src/consumer.ts"),
			'import type { UsedShape } from "./shapes.js";\nexport const show = (s: UsedShape): number => s.id;\n',
		);
	}

	const TYPE_CHECKS = ["dead_type_exports", "duplicate_type_declaration", "unknown_type_alias"];

	function typeHits(findings: ScanCodebaseFinding[]): string[] {
		return findings
			.filter((f) => TYPE_CHECKS.includes(f.check_id))
			.map((f) => `${f.check_id} ${f.file}:${f.line}`)
			.sort();
	}

	it("P4: the type-discipline detectors read the scan root — --cwd from another process cwd gives identical per-detector counts", async () => {
		writeTypeFixture();
		expect(process.cwd()).not.toBe(dir);
		const outsideFindings = await scanJson({ cwd: dir });

		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		let insideFindings: ScanCodebaseFinding[];
		try {
			insideFindings = await scanJson({});
		} finally {
			cwdSpy.mockRestore();
		}

		const outside = countsByCheck(outsideFindings);
		const inside = countsByCheck(insideFindings);
		for (const id of TYPE_CHECKS) expect([id, outside[id]]).toEqual([id, inside[id]]);
		expect(typeHits(outsideFindings)).toEqual(typeHits(insideFindings));
		// Not vacuous: each detector measured the fixture, and only the fixture.
		expect(typeHits(outsideFindings)).toEqual([
			"dead_type_exports src/shapes.ts:10",
			"dead_type_exports src/shapes.ts:13",
			"dead_type_exports src/shapes.ts:4",
			"dead_type_exports src/shapes.ts:7",
			"dead_type_exports src/twin.ts:1",
			"duplicate_type_declaration src/shapes.ts:10",
			"duplicate_type_declaration src/twin.ts:1",
			"unknown_type_alias src/shapes.ts:13",
		]);
	});

	it("N3: with no resolvable typescript, unknown_type_alias returns no findings and reports NOT MEASURED", async () => {
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			const createRequire = (base: string | URL) => {
				const real = actual.createRequire(base);
				return Object.assign((id: string): unknown => {
					if (id === "typescript") throw new Error("Cannot find module 'typescript' (simulated)");
					return real(id);
				}, real);
			};
			return { ...actual, createRequire, default: { ...actual, createRequire } };
		});
		vi.resetModules();
		try {
			const { detectUnknownTypeAlias } = await import("../checks/type-discipline-unknown-alias.js");
			const { withCheckRoot } = await import("../checks/check-root.js");
			const run = withCheckRoot(dir, () => [
				...detectUnknownTypeAlias(SHAPES, join(dir, "src/shapes.ts")),
				...detectUnknownTypeAlias(SHAPES, join(dir, "src/shapes-2.ts")),
			]);
			expect(run.result).toEqual([]);
			expect(run.notMeasured).toHaveLength(1);
			expect(run.notMeasured[0]).toMatch(/^\[interlinked:unknown_type_alias\] NOT MEASURED: /);
			expect(run.notMeasured[0]).toContain(dir);
		} finally {
			vi.doUnmock("node:module");
			vi.resetModules();
		}
	});
});

// ===========================================
// Phase D — scoped-scan API (scanFilesForDetector)
// ===========================================

describe("scanFilesForDetector", () => {
	/** Tiny synthetic detector — flags every line containing "BAD". */
	function badLineDetector(file: string, content: string): DetectorFinding[] {
		const out: DetectorFinding[] = [];
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			if (nonNull(lines[i]).includes("BAD")) {
				out.push({
					check_id: "bad_line",
					file,
					line: i + 1,
					message: `bad line ${i + 1}`,
				});
			}
		}
		return out;
	}

	it("returns an empty array when given no files", () => {
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: [],
			readFile: () => "",
		});
		expect(out).toEqual([]);
	});

	it("returns an empty array when the single file has zero detector hits", () => {
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: ["/abs/clean.ts"],
			readFile: () => "// nothing flagged here\nconst x = 1;\n",
		});
		expect(out).toEqual([]);
	});

	it("returns N findings from a single file with N detector hits", () => {
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: ["/abs/dirty.ts"],
			readFile: () => "ok\nBAD here\nok\nBAD again\n",
		});
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ check_id: "bad_line", file: "/abs/dirty.ts", line: 2 });
		expect(out[1]).toMatchObject({ check_id: "bad_line", file: "/abs/dirty.ts", line: 4 });
	});

	it("aggregates findings across multiple files with mixed content", () => {
		const contents: Record<string, string> = {
			"/abs/a.ts": "clean\nclean\n",
			"/abs/b.ts": "BAD line\n",
			"/abs/c.ts": "ok\nBAD\nBAD again\n",
		};
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: ["/abs/a.ts", "/abs/b.ts", "/abs/c.ts"],
			readFile: (p) => nonNull(contents[p]),
		});
		expect(out).toHaveLength(3);
		const files = out.map((f) => f.file);
		expect(files).toContain("/abs/b.ts");
		expect(files).toContain("/abs/c.ts");
		expect(files).not.toContain("/abs/a.ts");
	});

	it("logs to stderr and skips files that are unreadable (does not throw)", () => {
		const stderrWrites: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		try {
			const out = scanFilesForDetector({
				detector: badLineDetector,
				files: ["/abs/missing.ts", "/abs/exists.ts"],
				readFile: (p) => {
					if (p === "/abs/missing.ts") {
						throw new Error("ENOENT: no such file");
					}
					return "BAD line\n";
				},
			});
			// The exists.ts hit must come through; missing.ts must be skipped.
			expect(out).toHaveLength(1);
			expect(nonNull(out[0]).file).toBe("/abs/exists.ts");
			// And the failure must have been logged.
			expect(stderrWrites.some((s) => s.includes("missing.ts"))).toBe(true);
			expect(stderrWrites.some((s) => s.includes("ENOENT"))).toBe(true);
		} finally {
			process.stderr.write = origWrite;
		}
	});

	it("isolates a misbehaving detector — one file's throw doesn't break the batch", () => {
		const stderrWrites: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		try {
			const out = scanFilesForDetector({
				detector: (file, content) => {
					if (file === "/abs/blowup.ts") {
						throw new Error("detector bug");
					}
					return badLineDetector(file, content);
				},
				files: ["/abs/blowup.ts", "/abs/ok.ts"],
				readFile: () => "BAD line\n",
			});
			// The blowup is swallowed; ok.ts still produces a finding.
			expect(out).toHaveLength(1);
			expect(nonNull(out[0]).file).toBe("/abs/ok.ts");
			expect(stderrWrites.some((s) => s.includes("blowup.ts"))).toBe(true);
		} finally {
			process.stderr.write = origWrite;
		}
	});

	it("uses the real fs.readFileSync as the default reader when readFile is omitted", () => {
		const dir = mkdtempSync(join(tmpdir(), "interlinked-scan-detector-default-"));
		try {
			const filePath = join(dir, "dirty.ts");
			writeFileSync(filePath, "ok\nBAD here\n");
			const out = scanFilesForDetector({ detector: badLineDetector, files: [filePath] });
			expect(out).toHaveLength(1);
			expect(nonNull(out[0]).file).toBe(filePath);
			expect(nonNull(out[0]).line).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("logs a String(err) message when the read failure throws a non-Error value", () => {
		const stderrWrites: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		try {
			const out = scanFilesForDetector({
				detector: badLineDetector,
				files: ["/abs/weird-throw.ts"],
				readFile: () => {
					// Exercising the non-Error catch branch on purpose.
					throw "plain string failure";
				},
			});
			expect(out).toEqual([]);
			expect(stderrWrites.some((s) => s.includes("plain string failure"))).toBe(true);
		} finally {
			process.stderr.write = origWrite;
		}
	});

	it("logs a String(err) message when a detector throws a non-Error value", () => {
		const stderrWrites: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		try {
			const out = scanFilesForDetector({
				detector: () => {
					// Exercising the non-Error catch branch on purpose.
					throw { code: "WEIRD" };
				},
				files: ["/abs/weird-detector-throw.ts"],
				readFile: () => "content\n",
			});
			expect(out).toEqual([]);
			expect(stderrWrites.some((s) => s.includes("[object Object]"))).toBe(true);
		} finally {
			process.stderr.write = origWrite;
		}
	});
});

describe("scanCIFilesForRecurrences", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-ci-scan-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fixture(relPath: string, content: string): void {
		const abs = join(dir, relPath);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}

	it("flags a destructive workflow run: step", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(true);
		const hit = findings.find((f) => f.check_id === "builtin-rm-rf-root");
		expect(hit?.file).toBe(".github/workflows/ci.yml");
	});

	it("flags a destructive Dockerfile RUN", () => {
		fixture("Dockerfile", ["FROM node:20", "RUN rm -rf /etc"].join("\n"));
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(true);
	});

	it("flags a destructive Makefile recipe (force push)", () => {
		fixture("Makefile", ["deploy:", "\tgit push --force origin main"].join("\n"));
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.check_id === "builtin-git-force-push")).toBe(true);
	});

	it("does not flag a benign workflow step", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: npm ci && npm test"].join("\n"));
		expect(scanCIFilesForRecurrences(dir)).toEqual([]);
	});

	it("does not flag a quoted destructive mention inside a run step", () => {
		fixture(".github/workflows/ci.yml", ["steps:", '  - run: echo "rm -rf / is bad"'].join("\n"));
		expect(scanCIFilesForRecurrences(dir)).toEqual([]);
	});

	it("scanCodebaseForRecurrences includes CI findings by default", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(true);
	});

	it("scanCodebaseForRecurrences skips CI findings when includeCI is false", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		const findings = scanCodebaseForRecurrences({ cwd: dir, includeCI: false });
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(false);
	});

	it("skips a CI file that cannot be read (permission error / race) rather than throwing", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		fixture("Dockerfile", ["FROM node:20", "RUN rm -rf /etc"].join("\n"));
		readFileSyncThrowPath = join(dir, "Dockerfile");
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.file === ".github/workflows/ci.yml")).toBe(true);
		expect(findings.some((f) => f.file === "Dockerfile")).toBe(false);
	});

	it("defaults to process.cwd() when called with no argument", () => {
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		try {
			const findings = scanCIFilesForRecurrences();
			expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(true);
		} finally {
			cwdSpy.mockRestore();
		}
	});

	it("only evaluates rules whose trigger fires PreToolUse/both — a PostToolUse-only rule is excluded", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "guard-rules.json"),
			JSON.stringify({
				rules: [
					{
						id: "custom-post-only-rule",
						enabled: true,
						trigger: "PostToolUse",
						tool_match: ["Bash"],
						action: "block",
						patterns: [{ field: "command", regex: "custom-post-only-marker" }],
						reason: "test rule scoped to PostToolUse only",
						severity: "high",
					},
				],
			}),
		);
		fixture(
			".github/workflows/ci.yml",
			["steps:", "  - run: custom-post-only-marker"].join("\n"),
		);
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.check_id === "custom-post-only-rule")).toBe(false);
	});
});
