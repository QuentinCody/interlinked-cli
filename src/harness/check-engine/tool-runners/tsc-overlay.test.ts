// Regression test for runTscOverlay's sibling-overlay support: a transactional
// multi-file edit must resolve cross-file references against the proposed
// COMBINED state, not stale disk. This pins the fix that lets `interlinked
// multi-edit` land coordinated refactors (new exports / shared types) in one
// atomic batch instead of rejecting every transiently-broken single file.
//
// Also covers `getTscOverlayMode`'s real (non-override) config-resolution
// path — cache miss, `loadRules()` success, cache hit, and the defensive
// catch fallback — in its own describe block near the bottom. That block
// clears the mode override (every other test in this file pins one) and
// wraps two DEPENDENCY modules, not the SUT: `../../rules-loader.js` (so one
// test can make `loadRules` throw) and `./tsc-overlay-sidecar-client.js` (so
// the throw's fallback to the default "sidecar" mode can be observed without
// a real child-process spawn). Both wrappers call through to the real
// implementation by default, so every other test's behavior is unchanged.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithProjectCompilerLease } from "../../project-compiler-gate.js";
import { loadRules } from "../../rules-loader.js";
import {
	_setTscOverlayModeOverrideForTest,
	clearTscOverlayCache,
	runTscOverlay,
	runTscOverlayTyped,
} from "./tsc-overlay.js";
import { runOverlayViaSidecarTyped } from "./tsc-overlay-sidecar-client.js";

vi.mock("../../rules-loader.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../rules-loader.js")>();
	return { ...actual, loadRules: vi.fn(actual.loadRules) };
});
vi.mock("./tsc-overlay-sidecar-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tsc-overlay-sidecar-client.js")>();
	return { ...actual, runOverlayViaSidecarTyped: vi.fn(actual.runOverlayViaSidecarTyped) };
});

// This suite exercises the in-process LanguageService logic itself (sibling
// overlays, cross-file resolution) — pin "in-process" mode so it doesn't
// route through the sidecar transport (covered separately by
// tsc-overlay-sidecar-main.test.ts and tsc-overlay-sidecar-client.test.ts).
beforeEach(() => {
	_setTscOverlayModeOverrideForTest("in-process");
});
afterEach(() => {
	_setTscOverlayModeOverrideForTest(null);
});

const created: string[] = [];

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-sib-"));
	created.push(dir);
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
		clearTscOverlayCache(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

// `a.ts` imports `foo` from `./b.js`; on disk `b.ts` does NOT export `foo`, so
// the import is broken against disk — the exact shape of a coordinated refactor
// where the symbol's definition lives in a sibling batch member.
const A = "import { foo } from './b.js';\nexport const bar: number = foo;\n";
const B_ON_DISK = "export const baz = 1;\n";
const B_WITH_FOO = "export const foo = 1;\nexport const baz = 1;\n";

describe("runTscOverlayTyped — skipped vs checked-clean vs unavailable (review pass 18)", () => {
	// "Disabled" and "checked clean" must be different states: an operator who
	// turned the overlay off has verified NOTHING, and no consumer may
	// describe the result as tsc-verified.
	it("P: mode 'off' returns status 'skipped' with the disable reason — never an empty 'ok'", () => {
		_setTscOverlayModeOverrideForTest("off");
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const out = runTscOverlayTyped({
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
			projectRoot: dir,
		});
		expect(out.status).toBe("skipped");
	});

	it("P: a non-TS file returns 'skipped', not 'ok'", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const out = runTscOverlayTyped({
			filePath: join(dir, "notes.md"),
			content: "# notes\n",
			projectRoot: dir,
		});
		expect(out.status).toBe("skipped");
	});

	it("N: a real in-process run on a clean TS file returns 'ok' with zero findings", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const out = runTscOverlayTyped({
			filePath: join(dir, "a.ts"),
			content: "export const x = 2;\n",
			projectRoot: dir,
		});
		expect(out).toEqual({ status: "ok", findings: [] });
	});

	it("N: in-process mode reports unavailable while another compiler owns the project", async () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		let releaseBarrier: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		const owner = runWithProjectCompilerLease(dir, async () => {
			markStarted?.();
			await barrier;
		});
		await started;

		const out = runTscOverlayTyped({
			filePath: join(dir, "a.ts"),
			content: "export const x = 2;\n",
			projectRoot: dir,
		});
		expect(out).toEqual({
			status: "unavailable",
			reason: "in-process TypeScript overlay deferred because another compiler owns this project",
		});

		releaseBarrier?.();
		await owner;
	});
});

describe("runTscOverlay — sibling overlays (proposed combined state)", () => {
	it(
		"resolves a cross-file symbol provided by a sibling's PROPOSED content",
		() => {
			const dir = project({ "a.ts": A, "b.ts": B_ON_DISK });
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: A,
				siblings: [{ filePath: join(dir, "b.ts"), content: B_WITH_FOO }],
			});
			// The sibling supplies `foo`, so the import resolves — no missing-member error.
			expect(out.some((r) => r.ruleId === "TS2305")).toBe(false);
		},
		60_000,
	);

	it(
		"WITHOUT the sibling overlay, the same edit fails to resolve (the bug A fixes)",
		() => {
			const dir = project({ "a.ts": A, "b.ts": B_ON_DISK });
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: A,
			});
			// Disk `b.ts` has no `foo` → per-file-against-disk surfaces TS2305.
			expect(out.some((r) => r.ruleId === "TS2305")).toBe(true);
		},
		60_000,
	);

	it(
		"a sibling whose path equals the target is ignored (target overlay wins)",
		() => {
			const dir = project({ "a.ts": A, "b.ts": B_WITH_FOO });
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: A,
				// A self-referential sibling must not clobber the target's own overlay.
				siblings: [{ filePath: join(dir, "a.ts"), content: "export const wrong = 1;\n" }],
			});
			expect(out.some((r) => r.ruleId === "TS2305")).toBe(false);
		},
		60_000,
	);
});

describe("runTscOverlay — directory-enumeration host callbacks", () => {
	it(
		"exercises readDirectory/getDirectories via automatic @types discovery under node_modules",
		() => {
			// With no explicit `types` compiler option, TypeScript auto-discovers
			// ambient @types packages by enumerating `node_modules/@types` — this
			// is the one path (short of a `paths`/wildcard mapping) that drives the
			// LanguageServiceHost's readDirectory/getDirectories callbacks rather
			// than ts.sys directly.
			const dir = project({ "a.ts": "export const x = 1;\n" });
			mkdirSync(join(dir, "node_modules", "@types", "made-up-pkg"), { recursive: true });
			writeFileSync(
				join(dir, "node_modules", "@types", "made-up-pkg", "package.json"),
				JSON.stringify({ name: "@types/made-up-pkg", types: "index.d.ts" }),
			);
			writeFileSync(
				join(dir, "node_modules", "@types", "made-up-pkg", "index.d.ts"),
				"declare const madeUpGlobal: number;\n",
			);
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: "export const x = 1;\n",
			});
			expect(out).toEqual([]);
		},
		60_000,
	);
});

describe("runTscOverlay — typeRoots-driven directory enumeration", () => {
	it(
		"exercises readDirectory/getDirectories via an explicit typeRoots directory (distinct from node_modules/@types auto-discovery)",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-typeroots-"));
			created.push(dir);
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						module: "nodenext",
						moduleResolution: "nodenext",
						strict: true,
						noEmit: true,
						skipLibCheck: true,
						typeRoots: ["custom-types"],
					},
					include: ["*.ts"],
				}),
			);
			mkdirSync(join(dir, "custom-types", "made-up-pkg"), { recursive: true });
			writeFileSync(
				join(dir, "custom-types", "made-up-pkg", "package.json"),
				JSON.stringify({ name: "made-up-pkg", types: "index.d.ts" }),
			);
			writeFileSync(
				join(dir, "custom-types", "made-up-pkg", "index.d.ts"),
				"declare const customTypeRootGlobal: number;\n",
			);
			writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: "export const x = 1;\n",
			});
			expect(out).toEqual([]);
		},
		60_000,
	);
});

describe("runTscOverlay — explicit `files` entry referencing a path that never existed", () => {
	it(
		"getScriptVersion's mtime<=prevMtime fallback returns the default version (0) for a root file that was never queried before and never exists",
		() => {
			// tsconfig's `files` array is NOT existence-checked at parse time (unlike
			// `include` globs), so "missing.ts" is frozen into the LanguageService's
			// root file list even though it never exists on disk. On the very first
			// query for it, statSync throws (mtime stays 0) and prevMtime also
			// defaults to 0, so `mtime > prevMtime` is false — the version-bump
			// branch is skipped and getScriptVersion falls through to
			// `String(ctx.versions.get(fileName) ?? 0)` with no prior entry,
			// exercising the `?? 0` fallback.
			const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-missingfile-"));
			created.push(dir);
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
					files: ["a.ts", "missing.ts"],
				}),
			);
			writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "a.ts"),
				content: "export const x = 1;\n",
			});
			// Must not throw; a.ts itself is clean regardless of missing.ts's status.
			expect(out).toEqual([]);
		},
		60_000,
	);
});

describe("runTscOverlay — DiagnosticMessageChain (object messageText)", () => {
	it("flattens a chained messageText (e.g. 'No overload matches this call') via ts.flattenDiagnosticMessageText", () => {
		// `a.ts` must exist on disk (see the note on the pathological-AST test
		// above) so tsconfig's `include` glob matches at least one file.
		const dir = project({ "a.ts": "export const placeholder = 1;\n" });
		// An overload-resolution failure is one of the few diagnostics whose
		// `messageText` is a DiagnosticMessageChain object rather than a plain
		// string — this exercises the object arm of the ternary, not just the
		// (far more common) string arm every other test in this file hits.
		const content =
			"function f(a: number, b: number): void;\n" +
			"function f(a: string, b: string): void;\n" +
			'f(1, "two");\n';
		const out = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content });
		const overload = out.find((r) => r.ruleId === "TS2769");
		expect(overload?.message).toBe(
			"No overload matches this call.\n" +
				"  Overload 1 of 2, '(a: number, b: number): void', gave the following error.\n" +
				"    Argument of type 'string' is not assignable to parameter of type 'number'.\n" +
				"  Overload 2 of 2, '(a: string, b: string): void', gave the following error.\n" +
				"    Argument of type 'number' is not assignable to parameter of type 'string'.",
		);
	});
});

describe("runTscOverlay — a frozen root file disappears from disk between calls", () => {
	// The service's root file list is frozen at construction (see the comment
	// in getOrCreateService). If a file that was part of that frozen list is
	// later removed or replaced on disk, the host's getScriptVersion/
	// getScriptSnapshot are still queried for it on the *next* call — these
	// two tests drive both outcomes: fully gone (ENOENT) vs. replaced by a
	// directory of the same name (exists, but isn't readable as text).

	it("a fully-deleted root file: statSync throws (ENOENT) and existsSync is false", () => {
		const dir = project({ "a.ts": A, "b.ts": B_ON_DISK });
		// Warm call: freezes the root file list as [a.ts, b.ts].
		runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content: A });
		rmSync(join(dir, "b.ts"));
		const out = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content: A });
		// b.ts is gone, so the import can't resolve at all — still TS2307/similar,
		// not a crash.
		expect(out.some((r) => r.line > 0)).toBe(true);
	});

	it("a root file replaced by a same-named directory: existsSync is true but ts.sys.readFile returns undefined", () => {
		const dir = project({ "a.ts": A, "b.ts": B_ON_DISK });
		runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content: A });
		rmSync(join(dir, "b.ts"));
		mkdirSync(join(dir, "b.ts"));
		const out = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content: A });
		expect(out.some((r) => r.line > 0)).toBe(true);
	});
});

describe("runTscOverlay — readDirectory host callback (paths wildcard)", () => {
	it(
		"exercises readDirectory via a wildcard compilerOptions.paths mapping",
		() => {
			// A wildcarded `paths` entry resolves against the target directory by
			// enumerating it — the one resolution shape that reaches the
			// LanguageServiceHost's `readDirectory` (as opposed to the plain
			// fileExists/directoryExists probes most resolution strategies use).
			const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-pathsdir-"));
			created.push(dir);
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						module: "nodenext",
						moduleResolution: "nodenext",
						strict: true,
						noEmit: true,
						skipLibCheck: true,
						baseUrl: ".",
						paths: { "@lib/*": ["lib/*"] },
					},
					include: ["*.ts", "lib/**/*.ts"],
				}),
			);
			mkdirSync(join(dir, "lib"), { recursive: true });
			writeFileSync(join(dir, "lib", "widget.ts"), "export const widget = 1;\n");
			const content = 'import { widget } from "@lib/widget";\nexport const w = widget;\n';
			writeFileSync(join(dir, "a.ts"), content);
			const out = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content });
			expect(out).toEqual([]);
		},
		60_000,
	);
});

describe("runTscOverlay — clearTscOverlayCache() with no arguments", () => {
	it("clears every project's caches, not just one, when called with no projectRoot", () => {
		const dirA = project({ "a.ts": A, "b.ts": B_ON_DISK });
		const dirB = project({ "a.ts": A, "b.ts": B_ON_DISK });
		const before = runTscOverlay({ projectRoot: dirA, filePath: join(dirA, "a.ts"), content: A });
		expect(before.some((r) => r.ruleId === "TS2305")).toBe(true);

		clearTscOverlayCache();

		const after = runTscOverlay({ projectRoot: dirB, filePath: join(dirB, "a.ts"), content: A });
		expect(after.some((r) => r.ruleId === "TS2305")).toBe(true);
	});
});

describe("runTscOverlay — non-TypeScript extensions", () => {
	it("returns [] immediately for a file whose extension is not ts/tsx/mts/cts", () => {
		const dir = project({});
		const out = runTscOverlay({
			projectRoot: dir,
			filePath: join(dir, "README.md"),
			content: "# not typescript\n",
		});
		expect(out).toEqual([]);
	});
});

describe("runTscOverlay — service/typescript-loader caching", () => {
	it(
		"reuses the cached LanguageService on a second call, and reuses the cached " +
			"typescript module (but rebuilds the service) after a partial clearTscOverlayCache",
		() => {
			const dir = project({ "a.ts": A, "b.ts": B_ON_DISK });

			// First call: cold — builds both the typescript-module cache and the
			// per-project LanguageService cache from scratch.
			const call1 = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content: A });
			expect(call1.some((r) => r.ruleId === "TS2305")).toBe(true);

			// Second call, same project, nothing cleared: getOrCreateService's own
			// cache hits (service reused), and the non-overlay sibling file `b.ts`
			// is re-queried for its script version with an unchanged mtime.
			const call2 = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content: A });
			expect(call2).toEqual(call1);

			// Clear only the per-project service cache. The typescript-module cache
			// (keyed separately, by design) survives, so the next call exercises the
			// "typescript already resolved" fast path inside loadTypeScript while
			// still rebuilding a fresh LanguageService.
			clearTscOverlayCache(dir);
			const call3 = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content: A });
			expect(call3).toEqual(call1);
		},
		60_000,
	);
});

describe("runTscOverlay — overlay/sibling files not yet part of the project's file list", () => {
	it(
		"a target file and sibling that don't exist on disk are appended to the LS's script file list",
		() => {
			// Neither `new.ts` (the overlay target) nor `newsib.ts` (a sibling) is
			// written to disk, so neither is part of tsconfig's `include` glob at
			// LanguageService-construction time — this is the "Write of a brand-new
			// file" scenario the `extra.push` branches exist for. `existing.ts` is
			// required so the project has at least one on-disk match: with zero
			// matches, tsconfig parsing itself fails ("No inputs were found") and
			// the service is never built, which would trivially short-circuit this
			// scenario before the file-list logic under test ever runs.
			const dir = project({ "existing.ts": "export const e = 1;\n" });
			const out = runTscOverlay({
				projectRoot: dir,
				filePath: join(dir, "new.ts"),
				content: "export const q = 1;\n",
				siblings: [{ filePath: join(dir, "newsib.ts"), content: "export const s = 1;\n" }],
			});
			expect(out).toEqual([]);
		},
		60_000,
	);
});

describe("runTscOverlay — tsconfig resolution failures", () => {
	it("returns [] when no tsconfig.json exists in any ancestor directory up to the filesystem root", () => {
		const dir = mkdtempSync(join("/tmp", "tsc-overlay-findcfg-"));
		created.push(dir);
		// No tsconfig.json anywhere from `dir` up through `/tmp` and `/` — the
		// filesystem-root guard in findTsconfig (`parent === dir`) must fire
		// rather than looping forever or throwing.
		const out = runTscOverlay({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
		});
		expect(out).toEqual([]);
	});

	it("returns [] when the 5-ancestor search exhausts without finding tsconfig.json or the fs root", () => {
		// os.tmpdir() on macOS sits 6 hops below "/" (…/T/<dir>), so findTsconfig's
		// bounded 5-iteration loop exhausts (falls through to its final `return
		// null`) before it ever reaches the `parent === dir` root guard — a
		// distinct code path from the /tmp-rooted test above.
		const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-exhaust-"));
		created.push(dir);
		const out = runTscOverlay({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
		});
		expect(out).toEqual([]);
	});

	it("returns [] when tsconfig.json contains invalid JSON (ts.readConfigFile reports an error)", () => {
		const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-badjson-"));
		created.push(dir);
		writeFileSync(join(dir, "tsconfig.json"), "{ this is not valid json ");
		writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
		const out = runTscOverlay({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
		});
		expect(out).toEqual([]);
	});

	it("returns [] when tsconfig.json parses with config errors and matches zero files", () => {
		const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-emptymatch-"));
		created.push(dir);
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "es9999bogus" },
				include: ["nomatch/**/*.ts"],
			}),
		);
		const out = runTscOverlay({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
		});
		expect(out).toEqual([]);
	});
});

describe("getTscOverlayMode — real config resolution (mode override cleared)", () => {
	afterEach(() => {
		_setTscOverlayModeOverrideForTest(null);
		// mockClear only — NOT mockReset: the mocks were constructed as
		// `vi.fn(actual.impl)`, so their call-through default lives in that
		// wrapped implementation. mockReset would strip it, leaving later
		// tests calling an empty mock instead of the real dependency.
		vi.mocked(loadRules).mockClear();
		vi.mocked(runOverlayViaSidecarTyped).mockClear();
	});

	function offProject(): string {
		const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-mode-off-"));
		created.push(dir);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ tsc_overlay: { mode: "off" } }),
		);
		return dir;
	}

	it("resolves mode from the real guard-rules.local.json on a cache miss and reports it as skipped", () => {
		_setTscOverlayModeOverrideForTest(null);
		const dir = offProject();
		const out = runTscOverlayTyped({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
		});
		expect(out).toEqual({ status: "skipped", reason: "tsc overlay disabled by config" });
		expect(loadRules).toHaveBeenCalledTimes(1);
	});

	it("caches the resolved mode — a second call for the same project root does not re-read config", () => {
		_setTscOverlayModeOverrideForTest(null);
		const dir = offProject();
		const input = {
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
		};
		runTscOverlayTyped(input);
		vi.mocked(loadRules).mockClear();
		const second = runTscOverlayTyped(input);
		expect(second).toEqual({ status: "skipped", reason: "tsc overlay disabled by config" });
		expect(loadRules).not.toHaveBeenCalled();
	});

	it("falls back to the default 'sidecar' mode when loadRules throws, instead of propagating the error", () => {
		_setTscOverlayModeOverrideForTest(null);
		const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-mode-throw-"));
		created.push(dir);
		vi.mocked(loadRules).mockImplementationOnce(() => {
			throw new Error("simulated config read failure");
		});
		vi.mocked(runOverlayViaSidecarTyped).mockReturnValueOnce({ status: "ok", findings: [] });
		const out = runTscOverlayTyped({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: "export const x = 1;\n",
		});
		// The catch swallowed the throw and fell back to DEFAULT_MODE
		// ("sidecar") rather than propagating it or silently landing on "off" /
		// "in-process" — proven by dispatch reaching the sidecar transport.
		expect(runOverlayViaSidecarTyped).toHaveBeenCalledTimes(1);
		expect(out).toEqual({ status: "ok", findings: [] });
	});
});

describe("runTscOverlay — LanguageService internal throw", () => {
	it(
		"returns [] (rather than throwing) when the LS internals throw on a pathological AST",
		() => {
			// `a.ts` must exist on disk (with harmless placeholder content) so the
			// tsconfig `include` glob matches at least one file — with zero matches
			// TS reports "No inputs were found" and the service is never built,
			// which would short-circuit before the LS internals we're targeting
			// ever run.
			const dir = project({ "a.ts": "export const a = 1;\n" });
			// Deeply nested parenthesized expression: real TypeScript parser/checker
			// recursion blows the call stack on this shape (RangeError), exercising
			// the catch-and-swallow path — not a mocked throw.
			let deep = "1";
			for (let i = 0; i < 50_000; i++) deep = `(${deep})`;
			const content = `export const x = ${deep};\n`;
			const out = runTscOverlay({ projectRoot: dir, filePath: join(dir, "a.ts"), content });
			expect(out).toEqual([]);
		},
		60_000,
	);
});
