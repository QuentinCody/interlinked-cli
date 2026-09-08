// Tests for the shared content-quality gate consumed by Edit/Write hooks,
// the `interlinked write` CLI subcommand, and MultiEdit.
//
// The gate runs:
//   1. pre_block registry checks (deterministic agent-safety rules)
//   2. biome diff-overlay
//   3. tsc diff-overlay (TypeScript LanguageService)
//   4. (optional) pre_warn registry checks
//
// These tests focus on the shape of the `gateProposedContent` entry point:
// a clean batch, a failing batch, and a mixed-pass/fail batch. The
// per-tool semantics (what biome/tsc flag, how diff-overlay filters
// pre-existing findings) are already covered by `diff-overlay.test.ts`
// and `tsc-overlay.test.ts`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DiffOverlayResult,
	evaluateBiomeDiffOverlay as EvaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay as EvaluateTscDiffOverlay,
} from "../diff-overlay.js";

// Marker substring: ONLY paths containing this get the synthetic ruleId-less
// finding from the diff-overlay mock below; every other path delegates to the
// real biome/tsc overlay so the rest of the suite exercises real toolchains.
const RULEID_FALLBACK_MARKER = "__gate_ruleid_fallback_probe__";

// Marker substring: paths containing this get a `checkerUnavailable` tsc
// overlay result (the sidecar-never-ran shape) and a quiet biome result, so
// the gate's "unavailable is not clean" branch can be pinned deterministically.
const TSC_UNAVAILABLE_MARKER = "__gate_tsc_unavailable_probe__";
const TSC_UNAVAILABLE_REASON = "sidecar killed by signal SIGTERM (test)";

// Mock the diff-overlay module so we can drive the `f.ruleId ?? "biome"` /
// `f.ruleId ?? "tsc"` default-code fallbacks in content-gate. These fire only
// when a real biome/tsc finding has no ruleId — which the actual toolchains
// never emit (every diagnostic carries a code), so the only way to assert the
// gate's defaulting behavior is to inject a finding with `ruleId: undefined`.
// The factory delegates to the real implementation for all non-marker paths.
vi.mock("../diff-overlay.js", async () => {
	const actual = await vi.importActual<typeof import("../diff-overlay.js")>("../diff-overlay.js");
	const synthetic = (tool: "biome" | "tsc", file: string): DiffOverlayResult => ({
		newFindings: [
			{
				tool,
				severity: "error",
				file,
				line: 7,
				message: `synthetic ${tool} finding with no ruleId`,
				// ruleId deliberately omitted (exactOptionalPropertyTypes): drives
				// the `?? "${tool}"` default-code branch in the gate.
			},
		],
		elapsedMs: 1,
		exceededBudget: false,
	});
	// NB: the marker consts are referenced ONLY inside these wrap functions
	// (lazily, at call time) — the hoisted factory body itself must not touch
	// module-level consts, they are still in their temporal dead zone here.
	const wrapBiome: typeof EvaluateBiomeDiffOverlay = (filePath, proposed, root) => {
		if (filePath.includes(RULEID_FALLBACK_MARKER)) return synthetic("biome", filePath);
		if (filePath.includes(TSC_UNAVAILABLE_MARKER)) {
			return { newFindings: [], elapsedMs: 0, exceededBudget: false };
		}
		return actual.evaluateBiomeDiffOverlay(filePath, proposed, root);
	};
	// The wrapper forwards the SIBLING overlays too: dropping the fourth
	// argument would re-create review r4 finding 1 (a sibling the batch creates
	// is invisible to module resolution) inside this suite only.
	const wrapTsc: typeof EvaluateTscDiffOverlay = (filePath, proposed, root, siblings) => {
		if (filePath.includes(RULEID_FALLBACK_MARKER)) return synthetic("tsc", filePath);
		if (filePath.includes(TSC_UNAVAILABLE_MARKER)) {
			return {
				newFindings: [],
				proposedFindings: null,
				elapsedMs: 1,
				exceededBudget: false,
				checkerUnavailable: TSC_UNAVAILABLE_REASON,
			};
		}
		return actual.evaluateTscDiffOverlay(filePath, proposed, root, siblings);
	};
	return { ...actual, evaluateBiomeDiffOverlay: wrapBiome, evaluateTscDiffOverlay: wrapTsc };
});

import { runMultiEdit } from "../../commands/multi-edit.js";
import { nonNull } from "../../lib/non-null.js";
import { _setTscOverlayModeOverrideForTest } from "../check-engine/tool-runners/tsc-overlay.js";
import { TSC_CHECKER_UNAVAILABLE_CODE } from "../diff-overlay.js";
import { sweepStaleFixtureDirs } from "./fixture-hygiene.js";
import {
	formatGateResult,
	GATE_SEVERITY_ERROR,
	GATE_SEVERITY_WARNING,
	gateProposedContent,
	readOnDiskOrUndefined,
} from "../content-gate.js";

// NB: for this file CLI_ROOT resolves to the REPOSITORY ROOT (three levels up
// from `src/harness/__tests__`). It is only the parent used to keep the
// disposable project under the repository, where biome can discover the
// repository config. It sits outside `src` on purpose (session review r5):
// a fixture dir a killed run leaves behind used to land under `src`, inside
// the root tsconfig's `include`, so its deliberately invalid sources showed up
// in every project-wide type check and in the daemon's build-freshness probe
// until the 30-minute sweep. Root-level `_*_fixtures-*/` is gitignored.
const CLI_ROOT = resolve(import.meta.dirname, "../../..");
// Fixture files live in a UNIQUE per-process `mkdtempSync` dir, so no two test
// files (or parallel runs) ever write the same path — the parallel-safety
// invariant (the prior fixed `<CLI_ROOT>/lib/_content_gate_fixtures` path raced
// sibling overlay tests under `--file-parallelism`, flipping the gate's ok
// flag). The dir is rooted under CLI_ROOT (not os.tmpdir()) because the biome
// branch of the gate needs it there: the check-engine rewrites overlay findings
// to a projectRoot-relative path then filters to that file, so a fixture
// OUTSIDE projectRoot is silently dropped to zero findings. Under projectRoot,
// (a) tsc finds tsconfig.json by walking up and applies
// strict/exactOptionalPropertyTypes to the overlaid file, and (b) biome
// resolves biome.json from `cwd: projectRoot`. The `_…fixtures-` name is
// skipped by the strip-brace corpus walk. The fixtures are not `*.test.ts` and
// not in a `__tests__/` dir, so the registry detectors (pre_block / pre_warn)
// still run on them.
sweepStaleFixtureDirs(CLI_ROOT);
const FIXTURE_DIR = mkdtempSync(resolve(CLI_ROOT, "_content_gate_fixtures-"));
const FIXTURE_TSCONFIG = resolve(FIXTURE_DIR, "tsconfig.json");
const CLEAN_FIXTURE = resolve(FIXTURE_DIR, "_gate_clean.ts");
const BIOME_FIXTURE = resolve(FIXTURE_DIR, "_gate_biome.ts");
const MIXED_FIXTURE_OK = resolve(FIXTURE_DIR, "_gate_mixed_ok.ts");
const MIXED_FIXTURE_BAD = resolve(FIXTURE_DIR, "_gate_mixed_bad.ts");
// Fixtures that exercise the registry phases (pre_block / pre_warn) and the
// tsc diff-overlay severity split. These are NOT *.test.ts and do NOT live in
// a __tests__/ dir, so the registry detectors (which skip strict test files)
// DO run against their content — that's the whole point.
const PRE_BLOCK_FIXTURE = resolve(FIXTURE_DIR, "_gate_preblock.ts");
const PRE_WARN_FIXTURE = resolve(FIXTURE_DIR, "_gate_prewarn.ts");
const TSC_FIXTURE = resolve(FIXTURE_DIR, "_gate_tsc.ts");
// Path carries the mock marker so the diff-overlay mock injects a ruleId-less
// finding. Must exist on disk so the gate enters its `if (existsSync(path))`
// overlay branches.
const RULEID_FALLBACK_FIXTURE = resolve(FIXTURE_DIR, `${RULEID_FALLBACK_MARKER}.ts`);

const CLEAN_CONTENT = `// clean gate fixture
export function identity<T>(x: T): T {
	return x;
}
`;

// Content that trips a deterministic pre_block registry check (eval_usage).
// We write this to disk AND propose it unchanged so the biome/tsc diff-overlays
// short-circuit to empty (proposed === on-disk) and ONLY the pre_block phase —
// which runs on the proposed content regardless of disk state — produces a
// failure. That isolates the pre_block branch from toolchain noise.
const PRE_BLOCK_CONTENT = `// pre_block gate fixture
export function run(src: string): unknown {
	return eval(src);
}
`;

// Content that trips a deterministic pre_warn registry check (floating_promises):
// a bare \`fetch(...)\` at statement position inside a function body, with no
// await / return / void / .catch(). fetch is in the builtin async-id allowlist.
const PRE_WARN_CONTENT = `// pre_warn gate fixture
export async function ping(): Promise<void> {
	fetch("https://example.test/health");
}
`;

// Fixture lifecycle. `beforeAll` primes biome once — cold `npx biome` is
// slow, so a throwaway run stabilises timing for the real assertions.
// `beforeEach` then re-materialises all four fixtures before every test:
// the dir is a private per-process tmp dir, so per-test rewrites keep every
// case hermetic (and resilient if a case mutates a fixture in place).
beforeAll(() => {
	// Pin the real tsc overlay to IN-PROCESS mode: the default sidecar
	// transport spawns a cold child per call (slow, and under suite load it
	// times out — now surfacing as a checkerUnavailable warning row that
	// would perturb the exact-failures assertions below). The sidecar
	// unavailable branch itself is pinned via TSC_UNAVAILABLE_MARKER and in
	// tsc-overlay-sidecar-client.test.ts / multi-edit-sidecar-unavailable.test.ts.
	_setTscOverlayModeOverrideForTest("in-process");
	mkdirSync(FIXTURE_DIR, { recursive: true });
	// Use the unique fixture directory as a real, tiny strict TS project. The
	// compiler admission key is the project root, so this keeps parallel test
	// workers from contending for the repository's production compiler lease.
	// A local config also prevents the LanguageService from indexing the whole
	// CLI merely to diagnose these two one-file overlay contracts.
	writeFileSync(
		FIXTURE_TSCONFIG,
		JSON.stringify({
			compilerOptions: {
				exactOptionalPropertyTypes: true,
				module: "ESNext",
				moduleResolution: "Bundler",
				skipLibCheck: true,
				strict: true,
				target: "ES2022",
			},
			include: ["*.ts", "*.mts"],
		}),
	);
	writeFileSync(CLEAN_FIXTURE, CLEAN_CONTENT);
	gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
		projectRoot: FIXTURE_DIR,
	});
});
beforeEach(() => {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(CLEAN_FIXTURE, CLEAN_CONTENT);
	writeFileSync(BIOME_FIXTURE, CLEAN_CONTENT);
	writeFileSync(MIXED_FIXTURE_OK, CLEAN_CONTENT);
	writeFileSync(MIXED_FIXTURE_BAD, CLEAN_CONTENT);
	// Registry-phase fixtures: write the trigger content to disk so the
	// diff-overlay short-circuit (proposed === on-disk) keeps biome/tsc quiet.
	writeFileSync(PRE_BLOCK_FIXTURE, PRE_BLOCK_CONTENT);
	writeFileSync(PRE_WARN_FIXTURE, PRE_WARN_CONTENT);
	// tsc fixture starts clean on disk; proposed content introduces the error.
	writeFileSync(TSC_FIXTURE, CLEAN_CONTENT);
	// Marker fixture must exist so the gate calls the (mocked) diff-overlays.
	writeFileSync(RULEID_FALLBACK_FIXTURE, CLEAN_CONTENT);
});

afterAll(() => {
	_setTscOverlayModeOverrideForTest(null);
	// Remove the whole fixture subdir — cleaner than per-file rmSync and
	// leaves no stray state if the test is aborted mid-run.
	try {
		rmSync(FIXTURE_DIR, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

describe("gateProposedContent", () => {
	it("clean batch: returns ok with no failures", () => {
		// Propose identical content — no new findings possible.
		const result = gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
			projectRoot: FIXTURE_DIR,
		});
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
		expect(typeof result.elapsedMs).toBe("number");
	});

	// Retry on rare flake: under parallel load biome can exceed the per-file
	// overlay budget on cold start. Warm-up in beforeAll covers most cases;
	// retry covers the occasional tail.
	it("biome failure: double-equals trips noSelfCompare/noDoubleEquals", { retry: 2 }, () => {
		// Add a snippet that biome will flag as a new finding.
		const bad = `${CLEAN_CONTENT}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = gateProposedContent([{ path: BIOME_FIXTURE, content: bad }], {
			projectRoot: FIXTURE_DIR,
		});
		expect(result.ok).toBe(false);
		const biomeFails = result.failures.filter((f) => f.tool === "biome");
		expect(biomeFails.length).toBeGreaterThan(0);
		expect(nonNull(biomeFails[0]).severity).toBe(GATE_SEVERITY_ERROR);
		const codes = biomeFails.map((f) => f.code).join(",");
		expect(codes).toMatch(/noSelfCompare|noDoubleEquals/);
	});

	it("mixed batch: one clean + one failing → batch fails, clean file surfaces no failures", { retry: 2 }, () => {
		const bad = `${CLEAN_CONTENT}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = gateProposedContent(
			[
				{ path: MIXED_FIXTURE_OK, content: CLEAN_CONTENT }, // clean
				{ path: MIXED_FIXTURE_BAD, content: bad }, // failing
			],
			{ projectRoot: FIXTURE_DIR },
		);
		expect(result.ok).toBe(false);
		// Failures are all attributed to the bad fixture, not the clean one.
		const pathsWithFailures = new Set(result.failures.map((f) => f.path));
		expect(pathsWithFailures.has(MIXED_FIXTURE_BAD)).toBe(true);
		expect(pathsWithFailures.has(MIXED_FIXTURE_OK)).toBe(false);
	});

	it("clean new-file write uses an empty biome/tsc baseline", () => {
		// A clean new file has no proposed diagnostics even though both overlays run.
		const nonExistent = resolve(FIXTURE_DIR, "_gate_does_not_exist.ts");
		const result = gateProposedContent([{ path: nonExistent, content: CLEAN_CONTENT }], {
			projectRoot: FIXTURE_DIR,
		});
		expect(result.ok).toBe(true);
		expect(result.failures.filter((f) => f.tool === "biome")).toEqual([]);
		expect(result.failures.filter((f) => f.tool === "tsc")).toEqual([]);
	});

	it("blocks an implicit-any parameter in a new .mts scratch-style file", () => {
		const nonExistent = resolve(FIXTURE_DIR, "_gate_implicit_any.mts");
		const proposed = "export const lengthOf = (line) => line.length;\n";
		const result = gateProposedContent([{ path: nonExistent, content: proposed }], {
			projectRoot: FIXTURE_DIR,
		});
		expect(result.ok).toBe(false);
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tool: "tsc", code: "TS7006", severity: "error" }),
			]),
		);
	});

	it("empty batch: trivially ok", () => {
		const result = gateProposedContent([], { projectRoot: FIXTURE_DIR });
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});

	// ─── checker-unavailable: "unavailable is not clean" ───
	// The mocked tsc diff-overlay returns `checkerUnavailable` for marker
	// paths — the shape the sidecar client produces on spawn failure /
	// timeout / cooldown. The gate must SURFACE it, never swallow it.

	// kind: policy — positive (must fire)
	it("P: tsc checker unavailable surfaces as a visible warning by default (advisory path)", () => {
		const marker = resolve(FIXTURE_DIR, `${TSC_UNAVAILABLE_MARKER}.ts`);
		const result = gateProposedContent([{ path: marker, content: CLEAN_CONTENT }], {
			projectRoot: FIXTURE_DIR,
		});
		// Advisory default: a warning, not a transaction-killer — but never silent.
		expect(result.ok).toBe(true);
		const rows = result.failures.filter((f) => f.code === TSC_CHECKER_UNAVAILABLE_CODE);
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).severity).toBe(GATE_SEVERITY_WARNING);
		expect(nonNull(rows[0]).tool).toBe("tsc");
		expect(nonNull(rows[0]).message).toContain(TSC_UNAVAILABLE_REASON);
	});

	// kind: policy — positive (must fire)
	it("P: tscUnavailableSeverity=error makes an unavailable checker abort the batch (transactional path)", () => {
		const marker = resolve(FIXTURE_DIR, `${TSC_UNAVAILABLE_MARKER}.ts`);
		const result = gateProposedContent([{ path: marker, content: CLEAN_CONTENT }], {
			projectRoot: FIXTURE_DIR,
			tscUnavailableSeverity: GATE_SEVERITY_ERROR,
		});
		expect(result.ok).toBe(false);
		const rows = result.failures.filter((f) => f.code === TSC_CHECKER_UNAVAILABLE_CODE);
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).severity).toBe(GATE_SEVERITY_ERROR);
	});

	// kind: policy — negative (must not fire)
	it("N: an available checker produces no tsc-overlay-unavailable row", () => {
		const result = gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
			projectRoot: FIXTURE_DIR,
			tscUnavailableSeverity: GATE_SEVERITY_ERROR,
		});
		expect(result.failures.filter((f) => f.code === TSC_CHECKER_UNAVAILABLE_CODE)).toEqual([]);
	});

	it("pre_block failure: an INTRODUCED eval() trips the registry as an error", () => {
		// Disk carries one eval; the proposal adds a SECOND, distinct one. Only
		// the introduced line is a transaction-killer (introduced-only
		// semantics, pre-block-gate.ts); the pre-existing one rides along as a
		// warning. The introduced line is line 5 of the proposal.
		const proposed = `${PRE_BLOCK_CONTENT}const risky = eval(process.argv[2] ?? "");\n`;
		const result = gateProposedContent([{ path: PRE_BLOCK_FIXTURE, content: proposed }], {
			projectRoot: FIXTURE_DIR,
		});
		expect(result.ok).toBe(false);
		const preBlock = result.failures.filter((f) => f.tool === "pre_block");
		const evalFail = preBlock.find((f) => f.code === "eval_usage" && f.severity === "error");
		expect(evalFail).toBeDefined();
		const finding = nonNull(evalFail);
		// The error names ONLY the introduced line, not the pre-existing L3.
		expect(finding.line).toBe(5);
		expect(finding.message).toMatch(/introduces 1 violation\(s\) at L5/);
		// hint = registry fix_instruction + the suppression escape.
		expect(typeof finding.hint).toBe("string");
		expect(nonNull(finding.hint)).toContain("interlinked-ignore: eval_usage");
		// The pre-existing on-disk instance surfaces as a non-blocking warning.
		const preexisting = preBlock.find((f) => f.severity === GATE_SEVERITY_WARNING);
		expect(preexisting?.message).toMatch(/pre-existing violation\(s\) at L3/);
	});

	it("pre_block pre-existing-only: rewriting the file unchanged WARNS but does not block", () => {
		// Disk content === proposed content: the eval() is pre-existing, so the
		// introduced-only gate must not brick the file (the bio-orchestrator
		// wall — one legacy finding blocking every unrelated future edit).
		const result = gateProposedContent(
			[{ path: PRE_BLOCK_FIXTURE, content: PRE_BLOCK_CONTENT }],
			{ projectRoot: FIXTURE_DIR },
		);
		expect(result.ok).toBe(true);
		const preBlock = result.failures.filter((f) => f.tool === "pre_block");
		expect(preBlock).toHaveLength(1);
		expect(preBlock[0]?.severity).toBe(GATE_SEVERITY_WARNING);
		expect(preBlock[0]?.message).toContain("pre-existing");
	});

	it("pre_block suppression: an inline interlinked-ignore directive exempts an introduced line", () => {
		const proposed =
			`${PRE_BLOCK_CONTENT}// interlinked-ignore: eval_usage — sandboxed REPL, input is vetted\n` +
			`const vetted = eval(process.argv[3] ?? "");\n`;
		const result = gateProposedContent([{ path: PRE_BLOCK_FIXTURE, content: proposed }], {
			projectRoot: FIXTURE_DIR,
		});
		// The introduced eval is suppressed; the pre-existing one still warns.
		expect(result.failures.filter((f) => f.tool === "pre_block" && f.severity === "error")).toEqual(
			[],
		);
		expect(result.ok).toBe(true);
	});

	it("batch view: a sibling CREATED in the same batch is visible to self_import — exporter-first batch is not refused (session review r3, finding 3)", () => {
		// On disk: a project whose moduleSuffixes make `./widget.js` resolve to
		// widget.native.ts FIRST, and an importer that does not yet import it.
		const project = resolve(FIXTURE_DIR, "_gate_batch_view");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			resolve(project, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""] }, include: ["*.ts"] }),
		);
		const importer = resolve(project, "widget.ts");
		const sibling = resolve(project, "widget.native.ts");
		writeFileSync(importer, "export const before = 1;\n");
		const importing = 'export { x } from "./widget.js";\n';
		// The batch creates the sibling and re-points the importer at it. Before
		// the proposed-files view, resolution saw the old disk (no sibling) and
		// called the import a self-import; the materialized batch has zero
		// TypeScript diagnostics and resolves to widget.native.ts.
		const withSibling = gateProposedContent(
			[
				{ path: sibling, content: "export const x = 1;\n" },
				{ path: importer, content: importing },
			],
			{ projectRoot: project },
		);
		expect(withSibling.failures.filter((f) => f.code === "self_import")).toEqual([]);
		// Review r4, finding 1: the WHOLE gate must pass — the type checker
		// receives the created sibling as an overlay, so no TS2303 either.
		expect(withSibling.failures.filter((f) => f.severity === "error")).toEqual([]);
		expect(withSibling.ok).toBe(true);
		// Control: the same importer edit WITHOUT the sibling in the batch really
		// is a self-import (widget.native.ts does not exist anywhere).
		const alone = gateProposedContent([{ path: importer, content: importing }], { projectRoot: project });
		expect(alone.failures.some((f) => f.code === "self_import" && f.severity === "error")).toBe(true);
	});

	it("batch view: a batch that REWRITES tsconfig is judged against the proposed config, with the disk as the baseline (review r4, finding 2)", () => {
		// On disk: suffix config, importer AND sibling — the re-export is valid
		// today. The batch drops the suffix (unchanged importer bytes), which makes
		// the same re-export a self-import; the materialized batch is TS2303.
		const project = resolve(FIXTURE_DIR, "_gate_config_batch");
		mkdirSync(project, { recursive: true });
		const configPath = resolve(project, "tsconfig.json");
		const suffixed = JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""] }, include: ["*.ts"] });
		const plain = JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [""] }, include: ["*.ts"] });
		writeFileSync(configPath, suffixed);
		const importer = resolve(project, "widget.ts");
		const importing = 'export { x } from "./widget.js";\n';
		writeFileSync(importer, importing);
		writeFileSync(resolve(project, "widget.native.ts"), "export const x = 1;\n");
		const dropSuffix = gateProposedContent(
			[
				{ path: configPath, content: plain },
				{ path: importer, content: importing },
			],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(dropSuffix.ok).toBe(false);
		// The self-import is INTRODUCED by the batch (the disk baseline, judged
		// under the disk config, has none) — an error, not a "pre-existing" warning.
		const selfImport = dropSuffix.failures.filter((f) => f.code === "self_import");
		expect(selfImport.map((f) => f.severity)).toEqual(["error"]);
		// And the type checker discloses that it could not judge the proposed config.
		expect(dropSuffix.failures.some((f) => f.tool === "tsc" && f.message.includes("cannot see the proposed configuration"))).toBe(true);
		// The other direction: the disk has NO suffix (so the re-export IS a
		// self-import today), and the batch adds the suffix. Under the proposed
		// config the re-export names the sibling: no self_import error.
		writeFileSync(configPath, plain);
		const addSuffix = gateProposedContent(
			[
				{ path: configPath, content: suffixed },
				{ path: importer, content: importing },
			],
			{ projectRoot: project },
		);
		expect(addSuffix.failures.filter((f) => f.code === "self_import" && f.severity === "error")).toEqual([]);
	});

	// Session review r5 (2026-09-06), finding 1: the configuration disclosure
	// keyed on FILENAMES, so a batch that rewrote `base.json` — the target of
	// the project's `extends` — was judged under the disk's options and reported
	// clean while the materialized program was TS2322. The gate now derives the
	// configuration from the project's actual graph. Both spellings of the base
	// must behave the same: the boundary is the graph, not the name.
	const R5_OPTIONS = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true };

	/** The reviewer's r5 project shape: a tsconfig extending `baseName`, and a
	 *  batch that rewrites the base while touching a source. The source stays
	 *  valid under every configuration — the disclosure is about the rewrite,
	 *  not about a diagnostic, and this fixture lives under the repository's
	 *  own `src` (the reviewer's probe holds the TS2322 materialization). */
	function gateExtendsRewrite(baseName: string): ReturnType<typeof gateProposedContent> & { base: string; source: string } {
		const project = resolve(FIXTURE_DIR, `_gate_extends_${baseName.replace(/[^a-z]/g, "_")}`);
		mkdirSync(project, { recursive: true });
		const base = resolve(project, baseName);
		writeFileSync(base, JSON.stringify({ compilerOptions: { ...R5_OPTIONS, strictNullChecks: false } }));
		writeFileSync(resolve(project, "tsconfig.json"), JSON.stringify({ extends: `./${baseName}`, include: ["*.ts"] }));
		const source = resolve(project, "widget.ts");
		writeFileSync(source, "export const value = 1;\n");
		const result = gateProposedContent(
			[
				{ path: base, content: JSON.stringify({ compilerOptions: { ...R5_OPTIONS, strictNullChecks: true } }) },
				{ path: source, content: "export const value = 1;\nexport const additional = 1;\n" },
			],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		return { ...result, base, source };
	}

	it("batch view: rewriting a CUSTOM-named `extends` target is disclosed as a configuration the checker cannot see (review r5, finding 1)", () => {
		const result = gateExtendsRewrite("base.json");
		expect(result.ok).toBe(false);
		const rows = result.failures.filter((f) => f.path === result.source && f.tool === "tsc" && f.code === TSC_CHECKER_UNAVAILABLE_CODE);
		expect(rows.map((f) => f.severity)).toEqual([GATE_SEVERITY_ERROR]);
		expect(nonNull(rows[0]).message).toContain(`${result.base} is rewritten by this batch`);
	});

	it("batch view: the recognized-name control (`tsconfig.base.json`) is disclosed the same way (review r5, finding 1)", () => {
		const result = gateExtendsRewrite("tsconfig.base.json");
		expect(result.ok).toBe(false);
		const rows = result.failures.filter((f) => f.path === result.source && f.tool === "tsc" && f.code === TSC_CHECKER_UNAVAILABLE_CODE);
		expect(rows.map((f) => f.severity)).toEqual([GATE_SEVERITY_ERROR]);
	});

	// Session review r5 (2026-09-06), finding 2: the tsc overlay returned before
	// running whenever the target's proposed bytes equalled its disk bytes, so a
	// consumer submitted UNCHANGED beside a changed exporter was never judged
	// against the proposed tree. An unchanged member is still a member: it is
	// re-checked whenever a sibling differs from the disk, and only skipped when
	// nothing around it changed either.
	const R5_CONSUMER = 'import { value } from "./value.js";\nexport const count: number = value;\n';

	function siblingProject(name: string): { project: string; exporter: string; consumer: string } {
		const project = resolve(FIXTURE_DIR, name);
		mkdirSync(project, { recursive: true });
		writeFileSync(resolve(project, "tsconfig.json"), JSON.stringify({ compilerOptions: R5_OPTIONS, include: ["*.ts"] }));
		const exporter = resolve(project, "value.ts");
		const consumer = resolve(project, "consumer.ts");
		writeFileSync(exporter, "export const value = 1;\n");
		writeFileSync(consumer, R5_CONSUMER);
		return { project, exporter, consumer };
	}

	it("batch view: an UNCHANGED member is re-checked against the changed sibling that breaks it (review r5, finding 2)", () => {
		const { project, exporter, consumer } = siblingProject("_gate_sibling_unchanged");
		const result = gateProposedContent(
			[
				{ path: exporter, content: 'export const value = "changed";\n' },
				{ path: consumer, content: R5_CONSUMER },
			],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result.ok).toBe(false);
		expect(result.failures.filter((f) => f.path === consumer && f.tool === "tsc").map((f) => f.code)).toEqual(["TS2322"]);
	});

	it("batch view: the changed-consumer control reports the same TS2322 (review r5, finding 2)", () => {
		const { project, exporter, consumer } = siblingProject("_gate_sibling_changed");
		const result = gateProposedContent(
			[
				{ path: exporter, content: 'export const value = "changed";\n' },
				{ path: consumer, content: `${R5_CONSUMER}export const additional = 1;\n` },
			],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result.ok).toBe(false);
		expect(result.failures.filter((f) => f.path === consumer && f.tool === "tsc").map((f) => f.code)).toEqual(["TS2322"]);
	});

	// Session review r6 (2026-09-06), finding 2: the compiler phase took the
	// tsconfig nearest the project root and forced the target into that
	// program, while `self_import` selected the sibling project that claims
	// the file. The complete gate now judges one program per file.
	function independentProject(name: string): { project: string; importer: string } {
		const project = resolve(FIXTURE_DIR, name);
		mkdirSync(resolve(project, "modules"), { recursive: true });
		writeFileSync(resolve(project, "tsconfig.json"), JSON.stringify({ compilerOptions: R5_OPTIONS, files: ["build.ts"] }));
		writeFileSync(resolve(project, "build.ts"), "export const build = 1;\n");
		writeFileSync(
			resolve(project, "tsconfig.app.json"),
			JSON.stringify({ compilerOptions: { ...R5_OPTIONS, moduleSuffixes: [".native", ""] }, include: ["modules"] }),
		);
		const importer = resolve(project, "modules", "widget.ts");
		writeFileSync(importer, "export const before = 1;\n");
		writeFileSync(resolve(project, "modules", "widget.native.ts"), "export const value = 1;\n");
		return { project, importer };
	}

	it("batch view: the complete gate judges a file under the sibling project that claims it — the suffix re-export passes (review r6, finding 2)", () => {
		const { project, importer } = independentProject("_gate_independent_ok");
		const result = gateProposedContent(
			[{ path: importer, content: 'export { value } from "./widget.js";\n' }],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result).toMatchObject({ ok: true, failures: [] });
	});

	it("batch view: control — an invalid import under that same project is rejected with TS2322 (review r6, finding 2)", () => {
		const { project, importer } = independentProject("_gate_independent_bad");
		const result = gateProposedContent(
			[{ path: importer, content: 'import { value } from "./widget.js";\nexport const s: string = value;\n' }],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result.ok).toBe(false);
		expect(result.failures.filter((f) => f.tool === "tsc").map((f) => f.code)).toEqual(["TS2322"]);
	});

	// Session review r6 (2026-09-06), finding 3: a config member whose proposed
	// bytes equal the disk was still reported as a configuration rewrite, so a
	// valid source edit beside an unchanged tsconfig was refused as unmeasured.
	function unchangedConfigProject(name: string): { project: string; config: string; configContent: string; source: string } {
		const project = resolve(FIXTURE_DIR, name);
		mkdirSync(project, { recursive: true });
		const config = resolve(project, "tsconfig.json");
		const configContent = JSON.stringify({ compilerOptions: R5_OPTIONS, include: ["*.ts"] });
		writeFileSync(config, configContent);
		const source = resolve(project, "value.ts");
		writeFileSync(source, "export const value = 1;\n");
		return { project, config, configContent, source };
	}

	it("batch view: a config member whose bytes equal the disk is NOT a configuration rewrite (review r6, finding 3)", () => {
		const { project, config, configContent, source } = unchangedConfigProject("_gate_unchanged_config");
		const result = gateProposedContent(
			[
				{ path: source, content: "export const value = 2;\n" },
				{ path: config, content: configContent },
			],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result).toMatchObject({ ok: true, failures: [] });
	});

	it("multi-edit: a valid manifest with an unchanged tsconfig member passes the real command and writes only its changed source (review r6, finding 3)", () => {
		const { project, config, configContent, source } = unchangedConfigProject("_gate_unchanged_config_cmd");
		const result = runMultiEdit(
			[
				{ path: source, edits: [{ old_string: "export const value = 1;", new_string: "export const value = 2;" }] },
				{ path: config, edits: [{ old_string: configContent, new_string: configContent }] },
			],
			{ projectRoot: project },
		);
		expect(result).toMatchObject({ ok: true, file_changes_applied: [source] });
		expect(readFileSync(source, "utf-8")).toBe("export const value = 2;\n");
		expect(readFileSync(config, "utf-8")).toBe(configContent);
	});

	// Session review r7 (2026-09-06), finding 1: a configured project with no
	// source on disk yet built no compiler service, so its FIRST proposed
	// source was reported clean without a diagnostic ever being requested.
	function emptyConfiguredProject(name: string, seeded: boolean): { project: string; source: string } {
		const project = resolve(FIXTURE_DIR, name);
		mkdirSync(project, { recursive: true });
		writeFileSync(resolve(project, "tsconfig.json"), JSON.stringify({ compilerOptions: R5_OPTIONS, include: ["*.ts"] }));
		if (seeded) writeFileSync(resolve(project, "seed.ts"), "export const seed = 1;\n");
		return { project, source: resolve(project, "widget.ts") };
	}

	it("batch view: the FIRST source written into an empty configured project is judged — TS2322 (review r7, finding 1)", () => {
		const { project, source } = emptyConfiguredProject("_gate_first_source", false);
		const result = gateProposedContent(
			[{ path: source, content: 'export const count: number = "wrong";\n' }],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result.ok).toBe(false);
		expect(result.failures.filter((f) => f.tool === "tsc").map((f) => f.code)).toEqual(["TS2322"]);
	});

	it("batch view: the seeded-project control reports the same TS2322 (review r7, finding 1)", () => {
		const { project, source } = emptyConfiguredProject("_gate_first_source_seeded", true);
		const result = gateProposedContent(
			[{ path: source, content: 'export const count: number = "wrong";\n' }],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result.ok).toBe(false);
		expect(result.failures.filter((f) => f.tool === "tsc").map((f) => f.code)).toEqual(["TS2322"]);
	});

	// Session review r7 (2026-09-06), finding 2: the in-process compiler service
	// was reused by its config path alone, so an `extends` target rewritten on
	// disk between two gate calls left the second judged under the old options.
	it("batch view: an inherited config tightened on disk between two gate calls governs the second (review r7, finding 2)", () => {
		const project = resolve(FIXTURE_DIR, "_gate_inherited_tightened");
		mkdirSync(project, { recursive: true });
		const base = resolve(project, "base.json");
		writeFileSync(base, JSON.stringify({ compilerOptions: { ...R5_OPTIONS, strict: true, strictNullChecks: false } }));
		writeFileSync(resolve(project, "tsconfig.json"), JSON.stringify({ extends: "./base.json", include: ["*.ts"] }));
		writeFileSync(resolve(project, "seed.ts"), "export const seed = 1;\n");
		const batch = [{ path: resolve(project, "widget.ts"), content: "export const value: string = null;\n" }];
		const warm = gateProposedContent(batch, { projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR });
		expect(warm).toMatchObject({ ok: true, failures: [] });
		writeFileSync(base, JSON.stringify({ compilerOptions: { ...R5_OPTIONS, strict: true, strictNullChecks: true } }));
		const tightened = gateProposedContent(batch, { projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR });
		expect(tightened.ok).toBe(false);
		expect(tightened.failures.filter((f) => f.tool === "tsc").map((f) => f.code)).toEqual(["TS2322"]);
	});

	// Session review r8 (2026-09-06), finding 1: the in-process compiler
	// service froze its root file list at construction, so a declaration file
	// added on disk between two gate calls never joined the program.
	it("batch view: a declaration file added on disk between two gate calls is seen by the second (review r8, finding 1)", () => {
		const project = resolve(FIXTURE_DIR, "_gate_declaration_added");
		mkdirSync(project, { recursive: true });
		writeFileSync(resolve(project, "tsconfig.json"), JSON.stringify({ compilerOptions: R5_OPTIONS, include: ["*.ts"] }));
		writeFileSync(resolve(project, "seed.ts"), "export const seed = 1;\n");
		const batch = [{ path: resolve(project, "widget.ts"), content: "export const v: number = MY_GLOBAL;\n" }];
		const before = gateProposedContent(batch, { projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR });
		// "Cannot find name" is TS2304, or TS2552 when the compiler offers a spelling suggestion.
		expect(before.failures.filter((f) => f.tool === "tsc").map((f) => f.code)).toEqual([expect.stringMatching(/^TS(?:2304|2552)$/)]);
		writeFileSync(resolve(project, "env.d.ts"), "declare const MY_GLOBAL: number;\n");
		const after = gateProposedContent(batch, { projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR });
		expect(after).toMatchObject({ ok: true, failures: [] });
	});

	it("batch view: members whose siblings are ALL unchanged keep the unchanged-text shortcut — clean and no findings", () => {
		const { project, exporter, consumer } = siblingProject("_gate_sibling_all_unchanged");
		const result = gateProposedContent(
			[
				{ path: exporter, content: "export const value = 1;\n" },
				{ path: consumer, content: R5_CONSUMER },
			],
			{ projectRoot: project, tscUnavailableSeverity: GATE_SEVERITY_ERROR },
		);
		expect(result).toMatchObject({ ok: true, failures: [] });
	});

	it("projectRoot omitted: falls back to findProjectRoot/cwd and still gates", () => {
		// No projectRoot option → the gate computes it per-entry. The fixture
		// lives under the CLI tree, so findProjectRoot resolves a real root; an
		// INTRODUCED eval() still blocks. Exercises the
		// `opts.projectRoot ?? findProjectRoot(...) ?? cwd` fallback chain.
		const result = gateProposedContent([
			{ path: PRE_BLOCK_FIXTURE, content: `${PRE_BLOCK_CONTENT}const x = eval(input);\n` },
		]);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.tool === "pre_block" && f.code === "eval_usage")).toBe(
			true,
		);
	});

	it("projectRoot omitted + path outside the project: falls all the way through to cwd", () => {
		// A path OUTSIDE the harness cwd makes findProjectRoot() return null
		// (it clamps every result to within cwd), so the gate reaches the final
		// `?? process.cwd()` leg. JavaScript keeps this root-resolution test out
		// of the TypeScript compiler lane while still exercising the registry.
		const outsidePath = resolve(tmpdir(), "_interlinked_gate_outside_probe.js");
		const result = gateProposedContent([{ path: outsidePath, content: PRE_BLOCK_CONTENT }]);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.tool === "pre_block" && f.code === "eval_usage")).toBe(
			true,
		);
		expect(result.failures.filter((f) => f.tool === "tsc")).toEqual([]);
	});

	it("tsc diff-overlay: a new blocking type error (TS2322) surfaces as an error", () => {
		// On-disk is clean; proposed introduces a string→number assignment.
		const proposed = `${CLEAN_CONTENT}\nconst _bad: number = "not a number";\n`;
		const result = gateProposedContent([{ path: TSC_FIXTURE, content: proposed }], {
			projectRoot: FIXTURE_DIR,
		});
		expect(result.ok).toBe(false);
		const tscFails = result.failures.filter((f) => f.tool === "tsc");
		expect(tscFails.length).toBeGreaterThan(0);
		const ts2322 = tscFails.find((f) => f.code === "TS2322");
		expect(ts2322).toBeDefined();
		const finding = nonNull(ts2322);
		expect(finding.severity).toBe(GATE_SEVERITY_ERROR);
		expect(finding.line).toBeGreaterThan(0);
		expect(finding.message.length).toBeGreaterThan(0);
	});

	it("tsc diff-overlay: a new warn-only type error (possibly-undefined) is a warning, not a blocker", () => {
		// strictNullChecks (strict:true) makes dereferencing a `T | undefined`
		// parameter a TS18048/TS2532-class diagnostic, which the gate demotes to
		// a warning. With ONLY that finding, the batch stays ok=true.
		const proposed = `${CLEAN_CONTENT}\nexport function deref(x: string | undefined): number {\n\treturn x.length;\n}\n`;
		const result = gateProposedContent([{ path: TSC_FIXTURE, content: proposed }], {
			projectRoot: FIXTURE_DIR,
		});
		const tscFails = result.failures.filter((f) => f.tool === "tsc");
		expect(tscFails.length).toBeGreaterThan(0);
		// Every tsc finding from this edit is the demote-to-warning kind.
		expect(tscFails.every((f) => f.severity === GATE_SEVERITY_WARNING)).toBe(true);
		// A warning-only batch is still "ok" (no blocking failures).
		const onlyTscFindings = result.failures.every((f) => f.tool === "tsc");
		if (onlyTscFindings) {
			expect(result.ok).toBe(true);
		}
		// The demoted code is one of the recognized possibly-null/undefined codes.
		const codes = tscFails.map((f) => f.code);
		expect(codes.some((c) => /^TS(2531|2532|18047|18048)$/.test(c))).toBe(true);
	});

	it("pre_warn skipped by default: floating-promise content produces no pre_warn failure", () => {
		// Default skipPreWarn=true → the pre_warn phase is not run even when the
		// content would trip floating_promises. Disk === proposed keeps biome/tsc
		// quiet, so the batch is clean.
		const result = gateProposedContent(
			[{ path: PRE_WARN_FIXTURE, content: PRE_WARN_CONTENT }],
			{ projectRoot: FIXTURE_DIR },
		);
		expect(result.failures.filter((f) => f.tool === "pre_warn")).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("pre_warn enabled: floating-promise content surfaces a pre_warn warning (non-blocking)", () => {
		const result = gateProposedContent(
			[{ path: PRE_WARN_FIXTURE, content: PRE_WARN_CONTENT }],
			{ projectRoot: FIXTURE_DIR, skipPreWarn: false },
		);
		const preWarn = result.failures.filter((f) => f.tool === "pre_warn");
		expect(preWarn.length).toBeGreaterThan(0);
		const floating = preWarn.find((f) => f.code === "floating_promises");
		expect(floating).toBeDefined();
		const finding = nonNull(floating);
		expect(finding.severity).toBe(GATE_SEVERITY_WARNING);
		// 3rd line carries the bare fetch() call.
		expect(finding.line).toBe(3);
		expect(finding.message).toMatch(/violation\(s\) at L3/);
		expect(typeof finding.hint).toBe("string");
		// pre_warn is informational: a warning-only batch is still ok.
		const onlyWarnings = result.failures.every((f) => f.severity === GATE_SEVERITY_WARNING);
		if (onlyWarnings) {
			expect(result.ok).toBe(true);
		}
	});

	it("pre_warn enabled on clean content: pre_warn phase runs but finds nothing", () => {
		// skipPreWarn=false on content with NO pre_warn triggers exercises the
		// pre_warn loop's empty-matches continue path without producing failures.
		const result = gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
			projectRoot: FIXTURE_DIR,
			skipPreWarn: false,
		});
		expect(result.ok).toBe(true);
		expect(result.failures.filter((f) => f.tool === "pre_warn")).toEqual([]);
	});

	it("ruleId-less overlay findings default to the tool name as the code", () => {
		// The diff-overlay mock injects biome+tsc findings with no ruleId for the
		// marker path. The gate must substitute the tool name via `?? "biome"` /
		// `?? "tsc"`. (Real biome/tsc always emit a code; this is the defensive
		// default path.)
		const proposed = `${CLEAN_CONTENT}\nexport const marker = 1;\n`;
		const result = gateProposedContent(
			[{ path: RULEID_FALLBACK_FIXTURE, content: proposed }],
			{ projectRoot: FIXTURE_DIR },
		);
		const biomeFail = result.failures.find((f) => f.tool === "biome");
		const tscFail = result.failures.find((f) => f.tool === "tsc");
		expect(biomeFail).toBeDefined();
		expect(tscFail).toBeDefined();
		// Default code === tool name when the finding carries no ruleId.
		expect((nonNull(biomeFail)).code).toBe("biome");
		expect((nonNull(tscFail)).code).toBe("tsc");
		// The synthetic findings carry their line/column/message through verbatim.
		expect((nonNull(biomeFail)).line).toBe(7);
		// A ruleId-less tsc finding is treated as blocking (not warn-only), so the
		// batch fails.
		expect((nonNull(tscFail)).severity).toBe(GATE_SEVERITY_ERROR);
		expect(result.ok).toBe(false);
	});
});

describe("formatGateResult", () => {
	it("renders 'clean' for an ok result with no failures", () => {
		const out = formatGateResult({ ok: true, failures: [], elapsedMs: 1 });
		expect(out).toMatch(/clean/);
	});

	it("renders per-file sections with tool + rule code + line", () => {
		const out = formatGateResult({
			ok: false,
			elapsedMs: 12,
			failures: [
				{
					path: "src/foo.ts",
					tool: "tsc",
					code: "TS2304",
					line: 14,
					message: "Cannot find name 'TOKEN'",
					severity: GATE_SEVERITY_ERROR,
				},
				{
					path: "src/foo.ts",
					tool: "biome",
					code: "noUnusedImports",
					line: 4,
					message: "helper is declared but never used",
					severity: GATE_SEVERITY_WARNING,
				},
			],
		});
		expect(out).toContain("src/foo.ts");
		expect(out).toContain("TS2304");
		expect(out).toContain("noUnusedImports");
		expect(out).toContain("tsc:");
		expect(out).toContain("biome:");
		// Warning prefix for non-blocking severity.
		expect(out).toContain("warn:");
		// Blocking failure carries NO warn: prefix on its own line.
		const tscLine = out.split("\n").find((l) => l.includes("TS2304")) ?? "";
		expect(tscLine).not.toContain("warn:");
		// Header reports the blocking/warning split and file count.
		expect(out).toMatch(/1 blocking failure\(s\), 1 warning\(s\) across 1 file\(s\)/);
		// Per-file location rendering for a known line.
		expect(out).toContain("line 14");
	});

	it("renders 'global' for a failure with no line (line 0)", () => {
		// A pre_block failure whose first match has line 0 (unknown location)
		// renders as "global" rather than "line N".
		const out = formatGateResult({
			ok: false,
			elapsedMs: 5,
			failures: [
				{
					path: "src/bar.ts",
					tool: "pre_block",
					code: "eval_usage",
					line: 0,
					message: "1 violation(s)",
					severity: GATE_SEVERITY_ERROR,
				},
			],
		});
		expect(out).toContain("global");
		expect(out).not.toContain("line 0");
		expect(out).toContain("pre_block:");
		expect(out).toContain("eval_usage");
	});

	it("groups multiple failures across distinct files into separate sections", () => {
		const out = formatGateResult({
			ok: false,
			elapsedMs: 7,
			failures: [
				{
					path: "src/a.ts",
					tool: "tsc",
					code: "TS2322",
					line: 1,
					message: "bad",
					severity: GATE_SEVERITY_ERROR,
				},
				{
					path: "src/b.ts",
					tool: "biome",
					code: "noDoubleEquals",
					line: 2,
					message: "use ===",
					severity: GATE_SEVERITY_ERROR,
				},
			],
		});
		expect(out).toContain("src/a.ts");
		expect(out).toContain("src/b.ts");
		expect(out).toMatch(/2 blocking failure\(s\), 0 warning\(s\) across 2 file\(s\)/);
	});

	it("renders 'clean' when result has no failures even if ok flag is false-y guarded", () => {
		// ok=true && failures empty → the early clean branch (distinct from the
		// failure-rendering branch). Includes the elapsedMs in the message.
		const out = formatGateResult({ ok: true, failures: [], elapsedMs: 42 });
		expect(out).toContain("clean");
		expect(out).toContain("42ms");
	});
});

describe("readOnDiskOrUndefined", () => {
	it("returns undefined for a missing path", () => {
		expect(readOnDiskOrUndefined(resolve(FIXTURE_DIR, "_missing.ts"))).toBeUndefined();
	});
	it("returns content for an existing path", () => {
		const result = readOnDiskOrUndefined(CLEAN_FIXTURE);
		expect(result).toBe(CLEAN_CONTENT);
	});
	it("returns undefined when the path exists but cannot be read as a file (directory)", () => {
		// FIXTURE_DIR exists (existsSync true) but readFileSync throws EISDIR,
		// driving the catch path that swallows the error and returns undefined.
		expect(readOnDiskOrUndefined(FIXTURE_DIR)).toBeUndefined();
	});
});
