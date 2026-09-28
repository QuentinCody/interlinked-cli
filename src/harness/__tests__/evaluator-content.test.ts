import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/evaluator.js";

// These evaluator units use synthetic paths; real capture has isolated integration coverage.
vi.mock("../hook-observations.js", () => ({ recordHookObservations: vi.fn() }));

describe("evaluatePreToolUse — content checks", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	// This suite exercises A-series/strict-typing/diff-class content checks
	// against real `/tmp/*.ts` file paths with no per-test cwd isolation, so
	// `findProjectRoot` falls back to this repo's own cwd and every write
	// lands in the REAL (gitignored) `.interlinked/obligations.jsonl` ledger
	// — shared across every local test run. Accumulated debt/wander state
	// from prior runs then leaks into unrelated cases here as spurious
	// `transient_debt` blocks. Transient-debt behavior has its own dedicated
	// coverage in `evaluator/transient-debt-guard.test.ts`; bypass it here so
	// this suite stays isolated from that shared local state.
	const TRANSIENT_DEBT_BYPASS_ENV = "INTERLINKED_DISABLE_TRANSIENT_DEBT";
	let prevTransientDebtBypass: string | undefined;

	beforeAll(() => {
		prevTransientDebtBypass = process.env[TRANSIENT_DEBT_BYPASS_ENV];
		process.env[TRANSIENT_DEBT_BYPASS_ENV] = "1";
	});

	afterAll(() => {
		if (prevTransientDebtBypass === undefined) delete process.env[TRANSIENT_DEBT_BYPASS_ENV];
		else process.env[TRANSIENT_DEBT_BYPASS_ENV] = prevTransientDebtBypass;
	});

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		// Relax TDD enforce-mode for this non-TDD suite (see evaluator.test.ts).
		if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	// ===========================================
	// A-series: PreToolUse Content Checks
	// ===========================================

	describe("A-series content checks", () => {
		it("A1: blocks merge conflict markers", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content:
						"const x = 1;\n<<<<<<< HEAD\nconst y = 2;\n=======\nconst y = 3;\n>>>>>>> branch\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Merge conflict");
		});

		it("A1: allows files without conflict markers", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: "const x = 1;\nconst y = 2;\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("A2: blocks on eval() (pre_block registry phase)", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: "const result = eval(userInput);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe("eval_usage");
			expect(result.reason).toContain("eval_usage");
			// Introduced-only semantics (pre-block-gate.ts): a new file has no
			// baseline, so the finding is INTRODUCED; the message names the
			// auditable per-line escape instead of "fix ALL instances".
			expect(result.reason).toContain("INTRODUCES");
			expect(result.reason).toContain("interlinked-ignore: eval_usage");
		});

		it("A6: warns on mixed import/require", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: 'import { foo } from "./foo";\nconst bar = require("./bar");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("Mixed import/require"))).toBe(true);
		});

		it("A6: skips mixed import/require for .cjs files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.cjs",
					content: 'import { foo } from "./foo";\nconst bar = require("./bar");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			const hasWarning = result.warnings?.some((w) => w.includes("Mixed import/require"));
			expect(hasWarning).toBeFalsy();
		});

		it("A8: warns on SQL injection patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/query.ts",
					content: "db.exec(`SELECT * FROM users WHERE id = $" + "{userId}`);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("SQL injection"))).toBe(true);
		});

		it("A9: warns on wildcard CORS", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/server.ts",
					content: 'res.setHeader("Access-Control-Allow-Origin", "*");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("CORS"))).toBe(true);
		});

		it("A10: warns on regex DoS patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/validator.ts",
					content: "const re = /(a+)+$/;",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("ReDoS"))).toBe(true);
		});

		it("A11: warns on JSDoc containing premature */ from glob patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					// A premature `**/` JSDoc close always orphans the rest of the
					// line as invalid syntax (that's the defect A11 exists to
					// catch), so on a `.ts` path this now also trips a REAL
					// tsc-diff-overlay syntax-error block (2e7ec85 made the tsc
					// overlay run for new files instead of short-circuiting to
					// empty). Use `.js`: content-quality's A11 regex still scans
					// it (JS_TS_EXTENSIONS includes `.js`), but tsc-diff-overlay's
					// narrower TS_OVERLAY_EXT (ts/tsx/mts/cts only) skips it, so
					// the case isolates the A11 warning path as originally
					// intended.
					file_path: "/tmp/types.js",
					content: '/** Glob pattern (uses "dir/**", "**/*.ext") */\nglob: 1;',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("closed early"))).toBe(true);
		});

		it("A11: does not warn on normal JSDoc comments", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/types.ts",
					content: "/** This is a normal JSDoc comment */\nexport const x = 1;",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("closed early"))).toBeFalsy();
		});
	});

	// ===========================================
	// Phase B.4 — diff-class skip end-to-end
	// ===========================================
	// A comment-only Edit (quoted-string body change under spans.ts) must
	// still surface error-severity detectors (eval_usage stays a hard block)
	// while warning-severity detectors are skipped. This verifies the
	// classifier is wired through evaluateWriteContentGuards →
	// buildAgentSafetyChecks correctly.

	describe("Phase B.4 diff-class skip", () => {
		it("preserves the pre_block error-severity gate on a quoted-string Edit", () => {
			// Same eval(input) on both sides, only the surrounding string
			// literal changes. The diff is comment_only under spans.ts but
			// eval_usage (severity=error, phase=pre_block) MUST still block.
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/tmp/diff-class-skip-eval.ts",
					old_string: "const a = 'foo'; const x = eval(input);",
					new_string: "const a = 'bar'; const x = eval(input);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe("eval_usage");
		});

		it("does not block on a pure quoted-string change with no error-severity violations", () => {
			// Comment_only diff that does not touch any error-severity check.
			// The dispatch should allow the write — the entire pre_warn
			// warning bucket is skipped under the diff-class gate.
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/tmp/diff-class-skip-quoted.ts",
					// Syntactically valid TS (2e7ec85 made the tsc diff-overlay run
					// its real overlay for new files instead of short-circuiting to
					// empty; a bare shell-style fragment now surfaces a genuine
					// syntax-error block from tsc, not the diff-class skip this
					// case targets).
					old_string: "const greeting = 'hello';",
					new_string: "const greeting = 'world';",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	// ===========================================
	// Markdown-first web fetching
	// ===========================================

	describe("markdown-first web fetching", () => {
		it("warns on Playwright browser_navigate", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_navigate",
				tool_input: { url: "https://example.com/docs" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
			expect(result.warnings?.some((w) => w.includes("Accept: text/markdown"))).toBe(true);
		});

		it("warns on Chrome DevTools navigate_page", () => {
			const event = makeEvent({
				tool_name: "mcp__chrome-devtools__navigate_page",
				tool_input: { url: "https://blog.cloudflare.com/some-post/" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("does not warn on browser navigate without URL", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_navigate",
				tool_input: {},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on non-navigation browser tools", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_click",
				tool_input: { selector: "#btn" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("warns on curl without Accept: text/markdown", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl -sS https://docs.example.com/api-reference" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("warns on wget without Accept: text/markdown", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "wget https://example.com/page.html" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("does not warn when Accept: text/markdown is present", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: 'curl -sS -H "Accept: text/markdown" https://example.com/page',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl to localhost", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl http://localhost:8787/api/status" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on POST requests", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: "curl -X POST https://api.example.com/data",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with --data (API call)", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: 'curl --data \'{"key":"val"}\' https://api.example.com/endpoint',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with -o (binary download)", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: "curl -o output.tar.gz https://releases.example.com/v1.0.tar.gz",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with JSON content type", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command:
						'curl -H "Content-Type: application/json" https://api.example.com/graphql',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});
	});

	// ===========================================
	// Strict-typing pre-overlay (gated, default off)
	// ===========================================
	describe("strict-typing pre-overlay", () => {
		it("does not block when the flag is off (default)", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/strict-typing-default.ts",
					content: "const x = foo as any;\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			// May warn from other checks, but must NOT block on the strict-typing gate.
			if (result.decision === "block") {
				expect(result.rule_id).not.toBe("strict-typing-overlay");
			}
		});

		it("blocks new `as any` when the flag is enabled", () => {
			rules.quality_checks.strict_typing_block = {
				enabled: true,
				file_types: [".ts", ".tsx"],
				timeout_ms: 500,
				severity: "error",
			};
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/strict-typing-on.ts",
					content: "const x = foo as any;\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe("strict-typing-overlay");
			expect(result.reason).toContain("as_any");
		});

		it("blocks unjustified @ts-ignore when enabled, allows justified", () => {
			rules.quality_checks.strict_typing_block = {
				enabled: true,
				file_types: [".ts"],
				timeout_ms: 500,
				severity: "error",
			};
			const blocked = evaluatePreToolUse(
				makeEvent({
					tool_name: "Write",
					tool_input: {
						file_path: "/tmp/strict-typing-bad.ts",
						content: "// @ts-ignore\nconst x = foo();\n",
					},
				}),
				rules,
				session,
				reservations,
				cohort,
			);
			expect(blocked.decision).toBe("block");
			expect(blocked.rule_id).toBe("strict-typing-overlay");

			const allowed = evaluatePreToolUse(
				makeEvent({
					tool_name: "Write",
					tool_input: {
						file_path: "/tmp/strict-typing-ok.ts",
						content: "// @ts-ignore: third-party types are missing\nconst x = foo();\n",
					},
				}),
				rules,
				session,
				reservations,
				cohort,
			);
			if (allowed.decision === "block") {
				expect(allowed.rule_id).not.toBe("strict-typing-overlay");
			}
		});
	});
});
