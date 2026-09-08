import { wireAbsentOptional, parseWire, wireObject, wireOptional, wireString } from "../../lib/value-validation.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoverageObligation } from "../coverage-obligation-ledger.js";
import {
	classifyBrowserToolName,
	classifyVerificationCommand,
	countCodeFilesEdited,
	countDocFactSourcesEdited,
	countUiFilesEdited,
	countVerifyCommands,
	formatBisectNotResetWarning,
	formatDeferredCoverageWarning,
	formatDocMarkerDriftWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnresolvedRedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
	isCodeFile,
	isDocFactSourceFile,
	isUiFile,
	readDeferredCoverageObligations,
	STUB_INTRODUCED_CAP,
	scanForStubs,
} from "../verification-stop-checks.js";

describe("classifyVerificationCommand", () => {
	it("classifies typechecker invocations", () => {
		expect(classifyVerificationCommand("tsc --noEmit")).toBe("typecheck");
		expect(classifyVerificationCommand("npx tsc -p tsconfig.json")).toBe("typecheck");
		expect(classifyVerificationCommand("ttsc")).toBe("typecheck");
	});

	it("classifies test runners across ecosystems", () => {
		expect(classifyVerificationCommand("bun run test")).toBe("test");
		expect(classifyVerificationCommand("npm test")).toBe("test");
		expect(classifyVerificationCommand("npx vitest run")).toBe("test");
		expect(classifyVerificationCommand("pytest -xvs tests/")).toBe("test");
		expect(classifyVerificationCommand("cargo test")).toBe("test");
		expect(classifyVerificationCommand("cargo nextest run")).toBe("test");
		expect(classifyVerificationCommand("go test ./...")).toBe("test");
	});

	it("classifies linters and biome/clippy as lint", () => {
		expect(classifyVerificationCommand("npx biome check")).toBe("lint");
		expect(classifyVerificationCommand("eslint .")).toBe("lint");
		expect(classifyVerificationCommand("oxlint src/")).toBe("lint");
		expect(classifyVerificationCommand("ruff check .")).toBe("lint");
		expect(classifyVerificationCommand("cargo clippy")).toBe("lint");
		expect(classifyVerificationCommand("cargo check")).toBe("lint");
	});

	it("classifies project builds", () => {
		expect(classifyVerificationCommand("npm run build")).toBe("build");
		expect(classifyVerificationCommand("bun run build")).toBe("build");
		expect(classifyVerificationCommand("cargo build --release")).toBe("build");
		expect(classifyVerificationCommand("go build ./...")).toBe("build");
		// `tsc --build` is intentionally classified as typecheck rather than
		// build: tsc is foremost a typechecker, and both signals satisfy the
		// correctness gate in the unverified-code check, so the user-visible
		// behavior is identical. The first-match-wins regex order documents
		// the priority.
		expect(classifyVerificationCommand("tsc --build")).toBe("typecheck");
	});

	it("classifies dev-server starters", () => {
		expect(classifyVerificationCommand("wrangler dev")).toBe("dev-server");
		expect(classifyVerificationCommand("npm run dev")).toBe("dev-server");
		expect(classifyVerificationCommand("bun run dev")).toBe("dev-server");
		expect(classifyVerificationCommand("vite")).toBe("dev-server");
		expect(classifyVerificationCommand("next dev")).toBe("dev-server");
	});

	it("classifies Python dev servers as dev-server", () => {
		expect(classifyVerificationCommand("python -m http.server 8000")).toBe("dev-server");
		expect(classifyVerificationCommand("python3 -m http.server")).toBe("dev-server");
		expect(classifyVerificationCommand("uvicorn main:app --reload")).toBe("dev-server");
		expect(classifyVerificationCommand("flask run")).toBe("dev-server");
	});

	it("classifies browser-automation CLIs as browser interaction", () => {
		expect(classifyVerificationCommand("uvx rodney screenshot")).toBe("browser");
		expect(classifyVerificationCommand("rodney --help")).toBe("browser");
		expect(classifyVerificationCommand("agent-browser snapshot")).toBe("browser");
		expect(classifyVerificationCommand("npx playwright test")).toBe("browser");
		expect(classifyVerificationCommand("playwright codegen")).toBe("browser");
	});

	it("returns null for unrelated commands", () => {
		expect(classifyVerificationCommand("git status")).toBeNull();
		expect(classifyVerificationCommand("ls -la")).toBeNull();
		expect(classifyVerificationCommand("npm install lodash")).toBeNull();
		// Watch mode of typechecker is also a verification signal — `tsc --watch`
		// matches the typecheck regex (does not require --noEmit/--build).
		// Commands that merely mention "tsc" as a path component, however, must
		// not: e.g. /opt/tsconfig-helper.sh — guarded by the word-boundary anchor.
		expect(classifyVerificationCommand("./tsconfig-helper.sh")).toBeNull();
	});

	it("classifies `interlinked verify` as verify-suite (not typecheck)", () => {
		// The suite signal must win over any individual-tool signal because
		// verify spawns tsc, biome, lint, etc. internally — the suite is
		// strictly more informative than any one of them.
		expect(classifyVerificationCommand("interlinked verify")).toBe("verify-suite");
		expect(classifyVerificationCommand("interlinked verify --json")).toBe("verify-suite");
		expect(classifyVerificationCommand("npx interlinked verify")).toBe("verify-suite");
	});

	it("classifies dev-mode verify invocations as verify-suite", () => {
		// During development, verify is invoked through tsx or via the
		// dist/index.js binary rather than the installed `interlinked` bin.
		// Both should still register as a verify-suite signal.
		expect(classifyVerificationCommand("node dist/index.js verify")).toBe("verify-suite");
		expect(classifyVerificationCommand("npx tsx src/index.ts verify")).toBe("verify-suite");
	});
});

describe("countVerifyCommands", () => {
	it("counts each correctness-grade command as a raw invocation (not distinct kinds)", () => {
		// Two tsc runs + one test + one suite = 4, even though the distinct-signal
		// Set would collapse the two tsc runs to a single `typecheck` kind — the
		// cadence ratio needs the raw count, which is exactly what this returns.
		expect(
			countVerifyCommands([
				"tsc --noEmit",
				"tsc -p tsconfig.json",
				"npx vitest run",
				"interlinked verify",
			]),
		).toBe(4);
	});

	it("excludes dev-server / browser signals and unrelated commands", () => {
		expect(
			countVerifyCommands([
				"npm run dev", // dev-server — proves a page loaded, not correctness
				"npx playwright test", // browser — likewise excluded
				"git status", // unrelated
				"ls -la", // unrelated
			]),
		).toBe(0);
	});

	it("returns 0 for an empty command list", () => {
		expect(countVerifyCommands([])).toBe(0);
	});
});

describe("classifyBrowserToolName", () => {
	it("classifies chrome-devtools MCP tools as browser interaction", () => {
		expect(classifyBrowserToolName("mcp__chrome-devtools__navigate_page")).toBe("browser");
		expect(classifyBrowserToolName("mcp__chrome-devtools__take_screenshot")).toBe("browser");
	});

	it("classifies playwright browser_* MCP tools as browser interaction", () => {
		expect(classifyBrowserToolName("mcp__playwright__browser_navigate")).toBe("browser");
		expect(classifyBrowserToolName("mcp__playwright__browser_click")).toBe("browser");
	});

	it("returns null for unrelated tools", () => {
		expect(classifyBrowserToolName(undefined)).toBeNull();
		expect(classifyBrowserToolName("Bash")).toBeNull();
		expect(classifyBrowserToolName("Write")).toBeNull();
		expect(classifyBrowserToolName("mcp__some-other-server__do_thing")).toBeNull();
	});
});

describe("isUiFile / isCodeFile", () => {
	it("isUiFile matches the component-framework + markup/style extensions", () => {
		expect(isUiFile("src/App.tsx")).toBe(true);
		expect(isUiFile("components/Button.jsx")).toBe(true);
		expect(isUiFile("pages/Index.vue")).toBe(true);
		expect(isUiFile("routes/_index.svelte")).toBe(true);
		expect(isUiFile("layouts/Default.astro")).toBe(true);
		expect(isUiFile("public/index.html")).toBe(true);
		expect(isUiFile("styles/main.css")).toBe(true);
		expect(isUiFile("styles/main.scss")).toBe(true);
	});

	it("isUiFile does NOT match plain ts/js or back-end files", () => {
		expect(isUiFile("src/server.ts")).toBe(false);
		expect(isUiFile("src/util.js")).toBe(false);
		expect(isUiFile("src/api.py")).toBe(false);
	});

	it("isCodeFile matches source code across languages", () => {
		expect(isCodeFile("src/index.ts")).toBe(true);
		expect(isCodeFile("src/index.tsx")).toBe(true);
		expect(isCodeFile("server.py")).toBe(true);
		expect(isCodeFile("main.rs")).toBe(true);
		expect(isCodeFile("main.go")).toBe(true);
		expect(isCodeFile("script.sh")).toBe(true);
	});

	it("isCodeFile excludes doc/markdown/plan files", () => {
		expect(isCodeFile("README.md")).toBe(false);
		expect(isCodeFile("docs/intro.mdx")).toBe(false);
		expect(isCodeFile("CLAUDE.md")).toBe(false);
		expect(isCodeFile("plans/q3.yaml")).toBe(false);
	});

	it("isCodeFile excludes config/data files", () => {
		expect(isCodeFile("package.json")).toBe(false);
		expect(isCodeFile("bun.lock")).toBe(false);
		expect(isCodeFile("Cargo.toml")).toBe(false);
	});
});

describe("scanForStubs", () => {
	it("matches TODO with delimiter", () => {
		const stubs = scanForStubs("// TODO: implement this");
		expect(stubs).toHaveLength(1);
		expect(stubs[0]?.kind).toBe("TODO");
		expect(stubs[0]?.snippet).toContain("TODO: implement this");
	});

	it("matches FIXME", () => {
		const stubs = scanForStubs("function foo() { /* FIXME — broken */ }");
		expect(stubs.map((s) => s.kind)).toContain("FIXME");
	});

	it("matches not-implemented throw forms", () => {
		const stubs = scanForStubs('function bar() { throw new Error("not implemented"); }');
		expect(stubs.map((s) => s.kind)).toContain("not-implemented-throw");
	});

	it("matches throw new Error('TODO ...') variants", () => {
		const stubs = scanForStubs(`throw new TypeError("TODO: handle stripe webhook")`);
		expect(stubs.map((s) => s.kind)).toContain("not-implemented-throw");
	});

	it("matches disabled tests (.skip and xit / xdescribe)", () => {
		expect(scanForStubs("it.skip('flaky', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
		expect(scanForStubs("test.skip('TODO', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
		expect(scanForStubs("describe.skip('legacy', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
		expect(scanForStubs("xit('was broken', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
	});

	it("returns at most one match per kind even when multiple appear", () => {
		const content = "// TODO: one\n// TODO: two\n// FIXME: three";
		const stubs = scanForStubs(content);
		const kinds = stubs.map((s) => s.kind);
		expect(kinds.filter((k) => k === "TODO")).toHaveLength(1);
		expect(kinds.filter((k) => k === "FIXME")).toHaveLength(1);
	});

	it("does NOT match TODO embedded inside identifiers", () => {
		const stubs = scanForStubs("const KOMODOItem = 1;\nfunction MyTODOList() {}");
		expect(stubs.map((s) => s.kind)).not.toContain("TODO");
	});

	it("returns empty array for empty / non-string input", () => {
		expect(scanForStubs("")).toEqual([]);
		expect(scanForStubs("just a plain line")).toEqual([]);
		// @ts-expect-error — null is not a string, but the function should
		// guard against it rather than throw on hostile callers.
		expect(scanForStubs(null)).toEqual([]);
	});

	it("truncates long lines to ~120 chars in the snippet", () => {
		const content = "// TODO: " + "a".repeat(300);
		const stubs = scanForStubs(content);
		expect(stubs[0]?.snippet.length).toBeLessThanOrEqual(120);
		expect(stubs[0]?.snippet.endsWith("...")).toBe(true);
	});

	it("exports a non-trivial cap constant", () => {
		expect(STUB_INTRODUCED_CAP).toBeGreaterThanOrEqual(10);
	});
});

describe("formatUnverifiedCodeWarning (verify-to-edit cadence)", () => {
	// Calibrated against docs/design/fable-corpus-extraction.md §A: the best
	// released models sustain ~0.5–1.0 verify commands per code edit, so the
	// nudge fires only well below that (ratio < 0.1) once a non-trivial number
	// of code files were touched — not on a raw "any edits, no verify" trigger.

	// --- no-fire cases ---

	it("returns null when no code files were edited", () => {
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 0,
				verifyCommandCount: 0,
				verificationObserved: new Set(),
			}),
		).toBeNull();
	});

	it("returns null below the minimum code-file count, even with zero verification", () => {
		// The old raw `> 0` trigger fired here; the calibrated nudge stays quiet
		// on a one/two/four-file touch-up — too little signal to judge cadence.
		for (const codeFilesEdited of [1, 2, 4]) {
			expect(
				formatUnverifiedCodeWarning({
					codeFilesEdited,
					verifyCommandCount: 0,
					verificationObserved: new Set(["dev-server"]),
				}),
			).toBeNull();
		}
	});

	it("returns null when the verify-to-edit ratio meets the floor", () => {
		// 1 verify command over 5 files = 0.20, at/above the 0.1 floor.
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 5,
				verifyCommandCount: 1,
				verificationObserved: new Set(["typecheck"]),
			}),
		).toBeNull();
	});

	it("returns null when the full verify suite ran, regardless of a sub-floor ratio", () => {
		// One `interlinked verify` over 30 files is 0.03 raw, but the suite is the
		// canonical CI mirror — categorical verification — so it satisfies.
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 30,
				verifyCommandCount: 1,
				verificationObserved: new Set(["verify-suite"]),
			}),
		).toBeNull();
	});

	// --- fire cases ---

	it("fires at exactly the minimum file count with zero verification", () => {
		const msg = formatUnverifiedCodeWarning({
			codeFilesEdited: 5,
			verifyCommandCount: 0,
			verificationObserved: new Set(),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/5 code file edit\(s\)/);
		expect(msg).toMatch(/no tsc \/ test \/ lint \/ build invocation observed/);
		expect(msg).toMatch(/cadence of 0\.00/);
		expect(msg).toMatch(/0\.5.*1\.0/); // cites the empirical best-model floor
		expect(msg).toMatch(/Don't claim done on unverified work/);
	});

	it("fires when verification is an order of magnitude below the floor", () => {
		// 1 verify command over 20 files = 0.05.
		const msg = formatUnverifiedCodeWarning({
			codeFilesEdited: 20,
			verifyCommandCount: 1,
			verificationObserved: new Set(["typecheck"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/only 1 verification command\(s\) observed/);
		expect(msg).toMatch(/cadence of 0\.05/);
	});

	it("fires on a large unverified session where only the dev server was touched", () => {
		// Hitting only the dev server doesn't prove the code typechecks or tests
		// pass — the case this nudge exists to catch, now gated on edit volume.
		const msg = formatUnverifiedCodeWarning({
			codeFilesEdited: 12,
			verifyCommandCount: 0,
			verificationObserved: new Set(["dev-server"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/12 code file edit\(s\)/);
	});

	// --- durable-signal flooring (message must never contradict the truth) ---

	it("does NOT report 'no invocation' when the durable signal set proves verifiers ran", () => {
		// A long session ran tsc + tests, but their invocations scrolled out of the
		// bounded commands_run ring so verifyCommandCount is 0. The durable
		// verification_observed set proves they ran — the message must not claim zero.
		const msg = formatUnverifiedCodeWarning({
			codeFilesEdited: 25,
			verifyCommandCount: 0,
			verificationObserved: new Set(["typecheck", "test"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).not.toMatch(/no tsc \/ test \/ lint \/ build invocation observed/);
		// Numerator floored by the 2 durable correctness kinds → ratio 2/25 = 0.08.
		expect(msg).toMatch(/only 2 verification command\(s\) observed/);
		expect(msg).toMatch(/cadence of 0\.08/);
	});

	it("still reports 'no invocation' when the durable set shows no correctness signal", () => {
		const msg = formatUnverifiedCodeWarning({
			codeFilesEdited: 25,
			verifyCommandCount: 0,
			verificationObserved: new Set(["dev-server"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/no tsc \/ test \/ lint \/ build invocation observed/);
	});
});

describe("formatVerifyNotRunWarning", () => {
	it("returns null when no code files were edited (nothing to verify)", () => {
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 0,
				verificationObserved: new Set(["typecheck"]),
			}),
		).toBeNull();
	});

	it("returns null when verify-suite was observed (covered)", () => {
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 5,
				verificationObserved: new Set(["verify-suite"]),
			}),
		).toBeNull();
	});

	it("returns null when NO correctness signals were observed (avoids double-nudge)", () => {
		// formatUnverifiedCodeWarning carries the message in this case;
		// formatVerifyNotRunWarning stays silent to avoid stacking nudges.
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 5,
				verificationObserved: new Set(),
			}),
		).toBeNull();
	});

	it("fires when individual correctness tools ran but not the suite", () => {
		const msg = formatVerifyNotRunWarning({
			codeFilesEdited: 5,
			verificationObserved: new Set(["typecheck", "test"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/5 code file edit\(s\)/);
		expect(msg).toMatch(/interlinked verify/);
	});

	it("fires even on a single correctness signal (e.g., just tsc)", () => {
		// A solo tsc run is verified-enough for warn_unverified_code (one
		// correctness signal satisfies it), but still triggers the verify-
		// not-run nudge because the suite catches what tsc misses (docs,
		// secrets, SAST, dep-audit).
		const msg = formatVerifyNotRunWarning({
			codeFilesEdited: 1,
			verificationObserved: new Set(["typecheck"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/docs:check/);
	});
});

describe("formatUiNotInteractedWarning", () => {
	it("returns null when no UI files were edited", () => {
		expect(
			formatUiNotInteractedWarning({
				uiFilesEdited: 0,
				verificationObserved: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when a dev server was started", () => {
		expect(
			formatUiNotInteractedWarning({
				uiFilesEdited: 2,
				verificationObserved: new Set(["dev-server"]),
			}),
		).toBeNull();
	});

	it("returns null when a browser MCP tool was used", () => {
		expect(
			formatUiNotInteractedWarning({
				uiFilesEdited: 2,
				verificationObserved: new Set(["browser"]),
			}),
		).toBeNull();
	});

	it("warns when only typecheck/test/build/lint were seen but no browser/dev-server", () => {
		// Type-checking is not feature-checking.
		const msg = formatUiNotInteractedWarning({
			uiFilesEdited: 1,
			verificationObserved: new Set(["typecheck", "test"]),
		});
		expect(msg).toMatch(/UI file edit\(s\)/);
		expect(msg).toMatch(/Type-checking is not feature-checking/);
	});
});

describe("formatStubsIntroducedWarning", () => {
	it("returns null when no stubs were tracked", () => {
		expect(formatStubsIntroducedWarning({ stubs: [] })).toBeNull();
	});

	it("includes file basenames and kinds for the first few stubs", () => {
		const msg = formatStubsIntroducedWarning({
			stubs: [
				{ file: "/repo/src/foo.ts", kind: "TODO", snippet: "// TODO: implement" },
				{ file: "/repo/src/bar.ts", kind: "FIXME", snippet: "// FIXME broken" },
			],
		});
		expect(msg).toMatch(/2 stub \/ TODO \/ disabled-test addition\(s\)/);
		expect(msg).toContain("foo.ts");
		expect(msg).toContain("bar.ts");
		expect(msg).toContain("[TODO]");
		expect(msg).toContain("[FIXME]");
	});

	it("truncates to maxShown and adds an 'and N more' suffix", () => {
		const stubs = Array.from({ length: 12 }, (_, i) => ({
			file: `src/file-${i}.ts`,
			kind: "TODO",
			snippet: `// TODO ${i}`,
		}));
		const msg = formatStubsIntroducedWarning({ stubs, maxShown: 5 });
		expect(msg).toContain("...and 7 more");
		// Only the first 5 file basenames should be shown
		expect(msg).toContain("file-0.ts");
		expect(msg).toContain("file-4.ts");
		expect(msg).not.toContain("file-5.ts");
	});
});

describe("countCodeFilesEdited / countUiFilesEdited", () => {
	it("counts code files written, excluding docs", () => {
		const set = new Set([
			"src/foo.ts",
			"src/bar.py",
			"README.md",
			"docs/intro.mdx",
			"package.json",
		]);
		expect(countCodeFilesEdited(set)).toBe(2);
	});

	it("counts UI files written", () => {
		const set = new Set([
			"src/Button.tsx",
			"src/util.ts",
			"src/page.svelte",
			"src/server.py",
			"styles/main.css",
		]);
		expect(countUiFilesEdited(set)).toBe(3);
	});

	it("dedupes raw + absolute forms of the same file", () => {
		// session-state.ts stores both forms when the resolved abs differs from raw.
		// The counter should treat them as one file.
		const set = new Set(["src/foo.ts", "/Users/me/proj/src/foo.ts"]);
		expect(countCodeFilesEdited(set)).toBe(1);
	});

	it("returns 0 on an empty set", () => {
		expect(countCodeFilesEdited(new Set())).toBe(0);
		expect(countUiFilesEdited(new Set())).toBe(0);
	});
});

describe("formatTddRegressionWarning", () => {
	it("returns null when there are no regressions", () => {
		expect(formatTddRegressionWarning({ regressions: [] })).toBeNull();
	});

	it("warns with the file basename and count for a regression", () => {
		const msg = formatTddRegressionWarning({
			regressions: [{ sourceFile: "/repo/src/parser.ts" }],
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/1 test regression\(s\)/);
		expect(msg).toContain("parser.ts");
		expect(msg).toMatch(/green→red/);
	});

	it("truncates to maxShown and adds an 'and N more' suffix", () => {
		const regressions = Array.from({ length: 9 }, (_, i) => ({
			sourceFile: `src/mod-${i}.ts`,
		}));
		const msg = formatTddRegressionWarning({ regressions, maxShown: 5 });
		expect(msg).toContain("...and 4 more");
		expect(msg).toContain("mod-0.ts");
		expect(msg).not.toContain("mod-5.ts");
	});
});

describe("formatBisectNotResetWarning", () => {
	it("returns null when no bisect command ran", () => {
		expect(
			formatBisectNotResetWarning({ commandsRun: ["git status", "npm test"] }),
		).toBeNull();
	});

	it("returns null when a reset followed the last bisect step", () => {
		expect(
			formatBisectNotResetWarning({
				commandsRun: ["git bisect start", "git bisect bad", "git bisect reset"],
			}),
		).toBeNull();
	});

	it("warns when a bisect was started but never reset", () => {
		const msg = formatBisectNotResetWarning({
			commandsRun: ["git bisect start HEAD HEAD~10", "git bisect good"],
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/unfinished git bisect/);
		expect(msg).toMatch(/git bisect reset/);
	});

	it("warns when a new bisect starts after a prior reset", () => {
		const msg = formatBisectNotResetWarning({
			commandsRun: ["git bisect start", "git bisect reset", "git bisect start"],
		});
		expect(msg).not.toBeNull();
	});
});

describe("isDocFactSourceFile / countDocFactSourcesEdited", () => {
	it("matches the gen-marker source files (rule families, runner registry, modes)", () => {
		expect(isDocFactSourceFile("src/harness/rules/builtin-rules-database.ts")).toBe(true);
		expect(isDocFactSourceFile("src/harness/rules/builtin-rules-processes.ts")).toBe(true);
		expect(isDocFactSourceFile("src/lib/hooks.ts")).toBe(true);
		expect(isDocFactSourceFile("src/harness/modes.ts")).toBe(true);
	});

	it("matches an absolute path to a rule family (files_written stores the abs form)", () => {
		expect(
			isDocFactSourceFile("/Users/me/interlinked-cli/src/harness/rules/builtin-rules-railway.ts"),
		).toBe(true);
	});

	it("does NOT match unrelated source, test mirrors, or package.json", () => {
		// Plain source that feeds no gen-marker counter.
		expect(isDocFactSourceFile("src/harness/evaluator/pre-tool.ts")).toBe(false);
		// A test file beside the rules — editing it cannot change the rule count.
		expect(isDocFactSourceFile("src/harness/rules/__tests__/merge.test.ts")).toBe(false);
		// package.json (node-min) is deliberately excluded — it over-fires.
		expect(isDocFactSourceFile("package.json")).toBe(false);
		// Substring, not path-anchored: `(?:^|/)` requires start-or-slash before src.
		expect(isDocFactSourceFile("notsrc/harness/modes.ts")).toBe(false);
	});

	it("counts distinct doc-fact sources, deduping raw + absolute forms", () => {
		const set = new Set([
			"src/harness/rules/builtin-rules-database.ts",
			"/abs/proj/src/harness/rules/builtin-rules-database.ts",
			"src/lib/hooks.ts",
			"src/harness/evaluator/pre-tool.ts", // not a doc-fact source
		]);
		expect(countDocFactSourcesEdited(set)).toBe(2);
	});

	it("returns 0 when no doc-fact source was edited", () => {
		expect(countDocFactSourcesEdited(new Set(["src/foo.ts", "README.md"]))).toBe(0);
	});
});

describe("formatDocMarkerDriftWarning", () => {
	it("returns null when no doc-fact source was edited", () => {
		expect(formatDocMarkerDriftWarning({ docSourcesEdited: 0, commandsRun: [] })).toBeNull();
	});

	it("warns when a rule family was edited and docs were not regenerated", () => {
		const msg = formatDocMarkerDriftWarning({
			docSourcesEdited: 1,
			commandsRun: ["npm test", "git add -A"],
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/1 edit\(s\)/);
		expect(msg).toMatch(/docs:build/);
		expect(msg).toMatch(/gen:/);
	});

	it("suppresses once docs:build ran this session", () => {
		expect(
			formatDocMarkerDriftWarning({ docSourcesEdited: 2, commandsRun: ["npm run docs:build"] }),
		).toBeNull();
	});

	it("suppresses once docs:check ran this session", () => {
		expect(
			formatDocMarkerDriftWarning({ docSourcesEdited: 2, commandsRun: ["npm run docs:check"] }),
		).toBeNull();
	});

	it("suppresses when `interlinked verify` ran (it aggregates docs:check)", () => {
		expect(
			formatDocMarkerDriftWarning({
				docSourcesEdited: 1,
				commandsRun: ["interlinked verify --json"],
			}),
		).toBeNull();
	});

	it("suppresses on a direct check-docs.mjs invocation", () => {
		expect(
			formatDocMarkerDriftWarning({
				docSourcesEdited: 1,
				commandsRun: ["node scripts/check-docs.mjs --build"],
			}),
		).toBeNull();
	});
});

describe("formatUnresolvedRedWarning", () => {
	// Negative: both lists empty. This is also the shape the lifecycle wrapper
	// produces for a red-then-green check (cleared) and a regression-only
	// session (filtered to checkTddRegression), so it covers those cases.
	it("returns null when both lists are empty", () => {
		expect(formatUnresolvedRedWarning({ redChecks: [], redTests: [] })).toBeNull();
	});

	it("fires for a red non-test check (typecheck) and names the kind + detail", () => {
		const msg = formatUnresolvedRedWarning({
			redChecks: [{ kind: "typecheck", detail: "tsc --noEmit" }],
			redTests: [],
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("[interlinked:verify-before-stop]");
		expect(msg).toContain("typecheck");
		expect(msg).toContain("tsc --noEmit");
		expect(msg).toMatch(/1 check\/test that went red/);
	});

	it("fires for a red whole-suite test run (kind test-suite + command detail) — backlog 3A", () => {
		const msg = formatUnresolvedRedWarning({
			redChecks: [{ kind: "test-suite", detail: "npx vitest run" }],
			redTests: [],
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("- test-suite (npx vitest run)");
		expect(msg).toMatch(/1 check\/test that went red/);
	});

	it("fires for a red check with no detail (kind only, no empty parens)", () => {
		const msg = formatUnresolvedRedWarning({ redChecks: [{ kind: "build" }], redTests: [] });
		expect(msg).not.toBeNull();
		expect(msg).toContain("- build");
		expect(msg).not.toContain("build ()");
	});

	it("fires for a stayed-red test, listing it by basename with a test: prefix", () => {
		const msg = formatUnresolvedRedWarning({
			redChecks: [],
			redTests: [{ sourceFile: "/repo/src/foo.ts" }],
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("test: foo.ts");
		expect(msg).not.toContain("/repo/src/");
	});

	it("combines red checks and red tests into one total", () => {
		const msg = formatUnresolvedRedWarning({
			redChecks: [{ kind: "lint" }],
			redTests: [{ sourceFile: "/a/bar.ts" }],
		});
		expect(msg).toMatch(/2 check\/test that went red/);
		expect(msg).toContain("- lint");
		expect(msg).toContain("test: bar.ts");
	});

	it("grants the deliberately-left-red case in its wording (reflection, not a block)", () => {
		const msg = formatUnresolvedRedWarning({ redChecks: [{ kind: "typecheck" }], redTests: [] });
		expect(msg).toMatch(/meant to leave it red/i);
		expect(msg).toMatch(/intentional/i);
		expect(msg).not.toMatch(/\bBLOCKED\b/);
	});

	it("caps the list at maxShown and appends an ...and N more suffix", () => {
		const redChecks = [{ kind: "typecheck" }, { kind: "build" }, { kind: "lint" }];
		const redTests = [
			{ sourceFile: "/a/t1.ts" },
			{ sourceFile: "/a/t2.ts" },
			{ sourceFile: "/a/t3.ts" },
		];
		const msg = formatUnresolvedRedWarning({ redChecks, redTests, maxShown: 2 });
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/6 check\/test that went red/);
		expect(msg).toContain("...and 4 more");
	});

	it("omits the ...and N more suffix when at or under maxShown", () => {
		const msg = formatUnresolvedRedWarning({
			redChecks: [{ kind: "lint" }],
			redTests: [{ sourceFile: "/a/x.ts" }],
			maxShown: 5,
		});
		expect(msg).not.toBeNull();
		expect(msg).not.toContain("more");
	});
});

// ===========================================================================
// formatDeferredCoverageWarning (pure formatter)
// ===========================================================================
describe("formatDeferredCoverageWarning", () => {
	function obligation(file: string): CoverageObligation {
		return {
			kind: "coverage",
			file,
			reason: "budget_exceeded",
			estimated_suite_ms: 30_000,
			budget_ms: 25_000,
			session_id: "s1",
			timestamp: "2026-06-07T00:00:00.000Z",
		};
	}

	it("returns null when there are no obligations", () => {
		expect(formatDeferredCoverageWarning({ obligations: [] })).toBeNull();
	});

	it("fires for a single deferred obligation, naming the file by basename", () => {
		const msg = formatDeferredCoverageWarning({
			obligations: [obligation("src/harness/foo.ts")],
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("[interlinked:verify-before-stop]");
		expect(msg).toContain("1 deferred coverage check(s)");
		expect(msg).toContain("- foo.ts");
		// Listed by basename only, not the full repo-relative path.
		expect(msg).not.toContain("src/harness/foo.ts");
	});

	it("names the commit gate + run-the-suite relief valves and the 'never enforced' framing", () => {
		const msg = formatDeferredCoverageWarning({
			obligations: [obligation("a.ts")],
		});
		expect(msg).toContain("never enforced");
		expect(msg).toMatch(/commit gate/i);
		// The run-the-suite relief is now REAL (finding 2026-06): a green coverage
		// run discharges what its report measures — the wording says so.
		expect(msg).toMatch(/full suite with coverage/i);
		expect(msg).toMatch(/discharges/i);
	});

	it("is reflection-only — no BLOCK / BLOCKED wording", () => {
		const msg = formatDeferredCoverageWarning({
			obligations: [obligation("a.ts"), obligation("b.ts")],
		});
		expect(msg).not.toBeNull();
		// Reflection nudge, never a block (Stop is reflection-only).
		expect(msg).not.toMatch(/\bBLOCK(?:ED)?\b/);
		expect(msg).toMatch(/reminder, not a block/i);
	});

	it("caps the list at maxShown and appends an ...and N more suffix", () => {
		const obligations = ["a.ts", "b.ts", "c.ts", "d.ts"].map(obligation);
		const msg = formatDeferredCoverageWarning({ obligations, maxShown: 2 });
		expect(msg).not.toBeNull();
		expect(msg).toContain("4 deferred coverage check(s)");
		expect(msg).toContain("...and 2 more");
		// Only the first two are listed.
		expect(msg).toContain("- a.ts");
		expect(msg).toContain("- b.ts");
		expect(msg).not.toContain("- c.ts");
	});

	it("omits the ...and N more suffix when at or under maxShown", () => {
		const msg = formatDeferredCoverageWarning({
			obligations: [obligation("a.ts")],
			maxShown: 5,
		});
		expect(msg).not.toBeNull();
		expect(msg).not.toContain("more");
	});
});

// ===========================================================================
// readDeferredCoverageObligations (total/never-throws JSONL reader)
// ===========================================================================
describe("readDeferredCoverageObligations", () => {
	let root: string;

	function row(over: Partial<CoverageObligation> & { session_id: string; file: string }): string {
		const full: CoverageObligation = {
			kind: "coverage",
			reason: "budget_exceeded",
			estimated_suite_ms: 30_000,
			budget_ms: 25_000,
			timestamp: "2026-06-07T00:00:00.000Z",
			...over,
		};
		return JSON.stringify(full);
	}

	/** Obligations for MISSING files are reconciled away (a deleted file can
	 *  never be covered, and one nagged a session forever — 2026-07-28), so
	 *  every fixture obligation needs its file to actually exist. */
	function touchFiles(files: string[]): void {
		for (const f of files) {
			mkdirSync(join(root, dirname(f)), { recursive: true });
			writeFileSync(join(root, f), "export {};\n");
		}
	}

	function writeLedger(lines: string[]): void {
		// Every file an obligation names must exist, or the reconciliation filter
		// (deleted ⇒ dropped) removes it before the assertion under test runs.
		for (const line of lines) {
			try {
				const f = (parseWire(JSON.parse(line), wireObject({ "file": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value")).file;
				if (f) touchFiles([f]);
			} catch (err) {
				// Torn-line fixtures are deliberate inputs to the malformed-JSONL test.
				void err;
			}
		}
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "coverage-obligations.jsonl"), `${lines.join("\n")}\n`, "utf-8");
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-defcov-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns [] when the ledger file is absent (missing → no obligations)", () => {
		expect(readDeferredCoverageObligations(root, "s1")).toEqual([]);
	});

	it("returns the obligations recorded for the requested session", () => {
		writeLedger([
			row({ session_id: "s1", file: "src/a.ts" }),
			row({ session_id: "s1", file: "src/b.ts" }),
		]);
		const out = readDeferredCoverageObligations(root, "s1");
		expect(out.map((o) => o.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("excludes obligations from OTHER sessions (filter by session_id)", () => {
		writeLedger([
			row({ session_id: "s1", file: "src/mine.ts" }),
			row({ session_id: "other", file: "src/theirs.ts" }),
		]);
		const out = readDeferredCoverageObligations(root, "s1");
		expect(out.map((o) => o.file)).toEqual(["src/mine.ts"]);
	});

	it("dedupes by file — the same file deferred 3x is one obligation", () => {
		writeLedger([
			row({ session_id: "s1", file: "src/dup.ts" }),
			row({ session_id: "s1", file: "src/dup.ts" }),
			row({ session_id: "s1", file: "src/dup.ts" }),
		]);
		const out = readDeferredCoverageObligations(root, "s1");
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("src/dup.ts");
	});

	// DISCHARGE CONTRACT (finding 12). A satisfied obligation must stop being unmet,
	// else the Stop check warns "never enforced" forever.
	function discharge(session_id: string, file: string, timestamp = "2026-06-07T01:00:00.000Z"): string {
		return JSON.stringify({ kind: "coverage_discharge", file, session_id, timestamp });
	}

	it("nets a DISCHARGE against an earlier obligation — a satisfied file is no longer unmet", () => {
		writeLedger([
			row({ session_id: "s1", file: "src/a.ts" }),
			row({ session_id: "s1", file: "src/b.ts" }),
			discharge("s1", "src/a.ts"), // a.ts satisfied by a commit-time coverage run
		]);
		expect(readDeferredCoverageObligations(root, "s1").map((o) => o.file)).toEqual(["src/b.ts"]);
	});

	it("a re-edit AFTER a discharge re-opens the obligation (chronological net)", () => {
		writeLedger([
			row({ session_id: "s1", file: "src/a.ts" }),
			discharge("s1", "src/a.ts"),
			row({ session_id: "s1", file: "src/a.ts" }), // re-edited after the discharge
		]);
		expect(readDeferredCoverageObligations(root, "s1").map((o) => o.file)).toEqual(["src/a.ts"]);
	});

	it("honors a discharge from ANOTHER session (a measurement is a fact about the FILE)", () => {
		// Reversed 2026-06: the commit gate / an observed coverage run may discharge
		// under a different session id than the one that deferred — session-filtering
		// discharges kept the Stop warning alive after the promised relief happened.
		writeLedger([
			row({ session_id: "s1", file: "src/a.ts" }),
			discharge("other", "src/a.ts"),
		]);
		expect(readDeferredCoverageObligations(root, "s1")).toEqual([]);
	});

	it("drops an obligation whose file was deleted — it can never be discharged", () => {
		// Live failure this pins: a created-then-deleted file kept the deferred-
		// coverage advisory alive for a whole session (and fed the Stop loop).
		writeLedger([row({ session_id: "s1", file: "src/gone.ts" }), row({ session_id: "s1", file: "src/kept.ts" })]);
		rmSync(join(root, "src/gone.ts"));
		const files = readDeferredCoverageObligations(root, "s1").map((o) => o.file);
		expect(files).toEqual(["src/kept.ts"]);
	});

	it("still scopes OBLIGATIONS to the requested session", () => {
		writeLedger([row({ session_id: "someone-else", file: "src/a.ts" })]);
		expect(readDeferredCoverageObligations(root, "s1")).toEqual([]);
	});

	it("skips non-coverage rows and torn/malformed JSONL lines without throwing", () => {
		writeLedger([
			row({ session_id: "s1", file: "src/ok.ts" }),
			'{"kind":"other","file":"src/x.ts","session_id":"s1"}', // wrong kind
			"{not valid json", // torn mid-write line
			"", // blank
		]);
		const out = readDeferredCoverageObligations(root, "s1");
		expect(out.map((o) => o.file)).toEqual(["src/ok.ts"]);
	});

	it("returns [] when no row matches the session (all other-session)", () => {
		writeLedger([row({ session_id: "other", file: "src/a.ts" })]);
		expect(readDeferredCoverageObligations(root, "s1")).toEqual([]);
	});
});
