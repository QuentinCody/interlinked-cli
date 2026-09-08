import { makeGuardRules } from "./__tests__/fixtures.js";
// Tests for the scratchpad write policy guard: tmp-secrets block +
// authored-code placement (block/warn/off) for the host session scratchpad.
// The triad path shape mirrors filesystem-guards.test.ts.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	buildScratchpadCodeReason,
	buildScratchpadSteerWarning,
	evaluateScratchpadWriteGuard,
	scratchpadCodeWriteMode,
} from "./scratchpad-write-guard.js";

// Split so the secret material never sits contiguous in the working tree.
const SECRET_LINE = `const key = '${"AKIA" + "IOSFODNN7EXAMPLE"}';\n`;

const ROOT = "/Users/dev/project";
const SESSION_ID = "e1ef5ba4-0000-4000-8000-000000000001";
const OTHER_SESSION = "ffffffff-1111-4111-8111-000000000002";

const scratchpadPath = (sessionId: string, ...tail: string[]): string =>
	join(tmpdir(), "claude-501", "-Users-dev-project", sessionId, "scratchpad", ...tail);

const makeEvent = (overrides: Partial<HarnessEvent> = {}): HarnessEvent =>
	// SAFETY: the guard only reads the event fields set here; a full
	// HarnessEvent fixture would restate every unrelated optional field.
	({
		hook_event: "PreToolUse",
		session_id: SESSION_ID,
		agent_source: "claude",
		tool_name: "Write",
		tool_input: {},
		timestamp: "2026-07-09T00:00:00Z",
		cwd: ROOT,
		...overrides,
		// SAFETY: guard reads only the fields set above.
	});

// SAFETY: the guard touches only `scratchpad_guard`; an empty object IS the
// "config absent" production shape the defaults must handle.
const RULES = ({ ...makeGuardRules(), } satisfies GuardRulesConfig);
const rulesWithMode = (mode: "block" | "warn" | "off"): GuardRulesConfig =>
	// SAFETY: same single-field access pattern as RULES above.
	({ ...makeGuardRules(),  scratchpad_guard: { code_write_mode: mode } } satisfies GuardRulesConfig);

const run = (
	filePath: string,
	opts: { content?: string; rules?: GuardRulesConfig; sessionId?: string; tool?: string } = {},
) => {
	const warnings: string[] = [];
	const decision = evaluateScratchpadWriteGuard(
		makeEvent({ session_id: opts.sessionId ?? SESSION_ID }),
		opts.tool ?? "Write",
		{ file_path: filePath, content: opts.content ?? "export {};\n" },
		opts.rules ?? RULES,
		warnings,
	);
	return { decision, warnings };
};

afterEach(() => {
	delete process.env.INTERLINKED_DISABLE_SCRATCH_GUARD;
});

describe("evaluateScratchpadWriteGuard — authored-code placement", () => {
	// test-contract: public-api — default `code_write_mode` ("block") must
	// redirect an authored-code write in the session scratchpad, naming the
	// rule id and pointing the reason at scratch/.
	it("blocks a .ts write into this session's scratchpad by default (redirect to scratch/)", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "probe.ts"));
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-scratchpad-code-write");
		expect(decision?.reason).toContain("scratch/");
	});

	// test-contract: boundary — the code-extension classifier must cover
	// non-.ts code extensions (.mts, .sh), not just the canonical .ts case.
	it("blocks other code extensions (.mts, .sh) the same way", () => {
		expect(run(scratchpadPath(SESSION_ID, "probe.mts")).decision?.decision).toBe("block");
		expect(run(scratchpadPath(SESSION_ID, "run.sh")).decision?.decision).toBe("block");
	});

	// test-contract: public-api — `code_write_mode: "warn"` must downgrade the
	// block to an allow plus a `[interlinked:scratch]`-tagged warning.
	it("warn mode softens to a [interlinked:scratch] steer and allows", () => {
		const { decision, warnings } = run(scratchpadPath(SESSION_ID, "probe.ts"), {
			rules: rulesWithMode("warn"),
		});
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.startsWith("[interlinked:scratch]"))).toBe(true);
	});

	// test-contract: public-api — buildScratchpadCodeReason must surface the
	// `interlinked scratch init` hint when the target repo has no scratch/.
	it("mentions `interlinked scratch init` while <repo>/scratch is missing", () => {
		expect(
			buildScratchpadCodeReason({ target: "x.ts", projectRoot: "/nonexistent/repo/root" }),
		).toContain("interlinked scratch init");
	});

	// test-contract: public-api — scratchpadCodeWriteMode must fall back to
	// "block" when config is absent, and honor an explicit mode otherwise.
	it("defaults to block mode when config is absent", () => {
		expect(scratchpadCodeWriteMode(RULES)).toBe("block");
		expect(scratchpadCodeWriteMode(rulesWithMode("off"))).toBe("off");
	});

	// test-contract: full-body assertion — kills every StringLiteral chunk in
	// buildScratchpadCodeReason (each `+`-joined segment mutated to "")
	it("block reason carries every message segment verbatim", () => {
		const reason = buildScratchpadCodeReason({ target: "x.ts", projectRoot: "/nonexistent/repo/root" });
		expect(reason).toContain("is an agent-authored code file aimed at the ephemeral session");
		expect(reason).toContain(
			"scratchpad — it would be ungated, invisible to search, and purged by the OS. Put",
		);
		expect(reason).toContain(
			"session/agent scripts in <repo>/scratch/ instead: gitignored but quality-gated,",
		);
		expect(reason).toContain(
			"non-code bulk. Config: scratchpad_guard.code_write_mode; one-command bypass:",
		);
		expect(reason).toContain(
			"The scratchpad remains the right place for downloads, package extractions, and",
		);
		expect(reason).toContain("INTERLINKED_DISABLE_SCRATCH_GUARD=1.");
	});

	// test-contract: full-body assertion — kills every StringLiteral chunk in
	// buildScratchpadSteerWarning
	it("warn-mode reason carries every message segment verbatim", () => {
		const warning = buildScratchpadSteerWarning({ target: "x.ts", projectRoot: "/nonexistent/repo/root" });
		expect(warning).toContain(
			"session scratchpad. Session/agent scripts belong in <repo>/scratch/ — gitignored",
		);
		expect(warning).toContain("but quality-gated and rg-searchable (see scratch/README.md).");
	});

	// test-contract: kills the StringLiteral mutant turning the "scratch" probe
	// in scratchInitHint into "" (which would find `projectRoot` itself, always
	// present, and suppress the hint)
	it("shows the scratch-init hint when the project root exists but scratch/ does not", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "scratch-guard-hint-"));
		try {
			expect(existsSync(join(projectRoot, "scratch"))).toBe(false);
			expect(buildScratchpadCodeReason({ target: "x.ts", projectRoot })).toContain(
				"interlinked scratch init",
			);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	// test-contract: kills the severity/category StringLiteral mutants on the
	// placement block decision object
	it("placement block carries the exact severity and category", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "probe.ts"));
		expect(decision?.severity).toBe("medium");
		expect(decision?.category).toBe("harness-integrity");
	});

	// test-contract: kills `!rawPath` -> `false` (evaluateScratchpadWriteGuard):
	// with no file_path/path at all, the guard must bail out before any
	// ledger write or ephemeral-steer warning is produced.
	it("returns null with no side effects when file_path/path is absent", () => {
		const scratchDir = scratchpadPath(SESSION_ID);
		const warnings: string[] = [];
		const decision = evaluateScratchpadWriteGuard(
			makeEvent({ cwd: scratchDir }),
			"Write",
			{},
			RULES,
			warnings,
		);
		expect(decision).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	// test-contract: kills `!ephemeral && !isRepoScratchPath(...)` -> `false`.
	// If the outer gate stopped exiting early for ordinary in-repo files, the
	// patch-applier detector (which itself does not check `ephemeral`) would
	// fire on a plain in-repo path it must never see.
	it("never runs applier/secrets detection on an ordinary in-repo path", () => {
		const applier = 'writeFileSync("src/harness/obligations.ts", patched);';
		const { decision } = run(join(ROOT, "src", "real.ts"), { content: applier });
		expect(decision).toBeNull();
	});

	// test-contract: kills both isRepoScratchPath StringLiteral mutants — one
	// collapses the prefix to "" (matches everything), the other drops just
	// the "scratch" segment (matches everything under the project root). Both
	// would misroute this ordinary in-repo file into the scratch/ policy path
	// and let the applier detector fire on it.
	it("does not treat an arbitrary in-repo directory as the scratch/ probe dir", () => {
		const applier = 'writeFileSync("src/harness/obligations.ts", patched);';
		const { decision } = run(join(ROOT, "other-dir", "thing.ts"), { content: applier });
		expect(decision).toBeNull();
	});

	// test-contract: kills `!ephemeral` -> `false` inside decideEphemeralWrite.
	// A non-ephemeral scratch/ write must return null WITHOUT ever reaching
	// pushEphemeralSteer — if the early return were skipped, a manifest-shaped
	// filename here would pick up an ephemeral-steer warning it must not get.
	it("does not steer a non-code write in the scratch/ probe dir", () => {
		const { decision, warnings } = run(join(ROOT, "scratch", "results.json"));
		expect(decision).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	// --- negative cases: legitimate patterns that must NOT fire ---

	// test-contract: boundary — a non-code scratchpad write (the sanctioned
	// downloads/outputs use) must never block, regardless of extension.
	it("never BLOCKS a non-code scratchpad write (downloads / outputs)", () => {
		for (const name of ["results.json", "report.md", "bundle.tgz", "LICENSE"]) {
			expect(run(scratchpadPath(SESSION_ID, name)).decision).toBeNull();
		}
	});

	// test-contract: invariant — Record-and-warn policy (operator decision
	// 2026-08-04): the placement gate only ever inspected CODE extensions, so
	// the single largest ephemeral class in the corpus — `.json`
	// gate-workaround manifests — passed with no warning and no trace. Bulk
	// downloads stay silent; they are the sanctioned use.
	it("steers manifest-ish and unclassified ephemeral writes without blocking", () => {
		for (const name of ["results.json", "LICENSE"]) {
			const { decision, warnings } = run(scratchpadPath(SESSION_ID, name));
			expect(decision).toBeNull();
			expect(warnings.join("\n")).toContain("[interlinked:ephemeral]");
		}
	});

	// test-contract: boundary — captured external-agent output (review/audit
	// markdown) must be steered toward .interlinked/agent-output/, not blocked.
	it("steers captured external-agent output toward .interlinked/", () => {
		const { decision, warnings } = run(scratchpadPath(SESSION_ID, "codex-review-2-result.md"));
		expect(decision).toBeNull();
		expect(warnings.join("\n")).toContain(".interlinked/agent-output/");
	});

	// test-contract: kills the three remaining StringLiteral chunks in the
	// agent-output branch of pushEphemeralSteer
	it("agent-output steer carries every message segment verbatim", () => {
		const { warnings } = run(scratchpadPath(SESSION_ID, "codex-review-2-result.md"));
		const msg = warnings.join("\n");
		expect(msg).toContain("looks like captured output from an external");
		expect(msg).toContain(
			"agent/review run, written to the ephemeral scratchpad. That tree is purged by the",
		);
		expect(msg).toContain(
			"OS and only best-effort archived (the SessionEnd sweep is capped and CAN truncate).",
		);
	});

	// test-contract: kills the three StringLiteral chunks in the manifest/other
	// branch of pushEphemeralSteer
	it("manifest/other steer carries every message segment verbatim", () => {
		const { warnings } = run(scratchpadPath(SESSION_ID, "results.json"));
		const msg = warnings.join("\n");
		expect(msg).toContain(
			".interlinked/ephemeral-writes.jsonl). If this is a manifest staged to route an",
		);
		expect(msg).toContain(
			"edit around a gate, pipe it on stdin instead of persisting it — and if a gate is",
		);
		expect(msg).toContain("forcing the detour, that gate is the bug worth reporting.");
	});

	// test-contract: boundary — genuine bulk-download extensions (.tgz, .png)
	// must produce neither a block decision nor any warning.
	it("stays silent on bulk downloads — the scratchpad's sanctioned use", () => {
		for (const name of ["bundle.tgz", "shot.png"]) {
			const { decision, warnings } = run(scratchpadPath(SESSION_ID, name));
			expect(decision).toBeNull();
			expect(warnings).toHaveLength(0);
		}
	});

	// test-contract: security — the applier guard spans BOTH staging grounds:
	// the ephemeral scratchpad and the durable in-repo probe dir. Recovered
	// artifact it generalises: `plm/apply.mjs` + rN.anchor.txt/rN.new.txt
	// (2026-07 scratchpad archive).
	it("blocks a hand-rolled patch applier in the scratchpad", () => {
		const applier = 'writeFileSync("src/harness/obligations.ts", patched);';
		const { decision } = run(scratchpadPath(SESSION_ID, "apply.mjs"), { content: applier });
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-patch-applier");
		// test-contract: kills the "high"/"harness-integrity" StringLiteral mutants
		expect(decision?.severity).toBe("high");
		expect(decision?.category).toBe("harness-integrity");
	});

	// test-contract: security — the SAME applier detector must also fire when
	// the applier script is staged in the in-repo scratch/ probe dir, not just
	// the ephemeral scratchpad.
	it("blocks the same applier staged in the in-repo scratch/ probe dir", () => {
		const applier = 'appendFileSync("src/lib/config.ts", chunk);';
		const { decision } = run(join(ROOT, "scratch", "apply.mjs"), { content: applier });
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-patch-applier");
	});

	// test-contract: boundary — an ordinary (non-applier) script staged in
	// scratch/ must not be caught by the applier detector.
	it("leaves an ordinary scratch/ probe alone", () => {
		const probe = 'const s = readFileSync("src/harness/server.ts", "utf-8");\nconsole.log(s);';
		expect(run(join(ROOT, "scratch", "probe.mjs"), { content: probe }).decision).toBeNull();
	});

	// test-contract: boundary — a code write to an ordinary in-repo path (not
	// an ephemeral temp path) is outside this guard's scope entirely.
	it("ignores code writes inside the repo (not an ephemeral temp path)", () => {
		const { decision, warnings } = run(join(ROOT, "src", "real.ts"));
		expect(decision).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	// test-contract: boundary — a DIFFERENT session's scratchpad is not this
	// session's placement concern; the confinement guard owns that surface.
	it("leaves a DIFFERENT session's scratchpad to the confinement guard", () => {
		expect(run(scratchpadPath(OTHER_SESSION, "x.ts")).decision).toBeNull();
	});

	// test-contract: boundary — a temp path outside the session scratchpad
	// shape is left to the separate confinement guard, not this placement gate.
	it("leaves non-scratchpad temp paths to the confinement guard", () => {
		expect(run(join(tmpdir(), "loose-probe.ts")).decision).toBeNull();
	});

	// test-contract: public-api — `code_write_mode: "off"` must disable the
	// placement gate entirely: no block, no warning.
	it("mode off disables the placement gate", () => {
		const { decision, warnings } = run(scratchpadPath(SESSION_ID, "probe.ts"), {
			rules: rulesWithMode("off"),
		});
		expect(decision).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	// test-contract: public-api — the INTERLINKED_DISABLE_SCRATCH_GUARD escape
	// hatch must suppress the placement block for one command.
	it("honors the INTERLINKED_DISABLE_SCRATCH_GUARD escape hatch", () => {
		process.env.INTERLINKED_DISABLE_SCRATCH_GUARD = "1";
		expect(run(scratchpadPath(SESSION_ID, "probe.ts")).decision).toBeNull();
	});

	// test-contract: boundary — the guard is scoped to write-shaped tools; a
	// non-write tool (Read) must never trigger it even at the same path.
	it("ignores non-write tools", () => {
		expect(
			run(scratchpadPath(SESSION_ID, "probe.ts"), { tool: "Read" }).decision,
		).toBeNull();
	});
});

describe("evaluateScratchpadWriteGuard — tmp-secrets scan", () => {
	// AWS's canonical documentation example key — not a live credential. Split
	// so the contiguous key material exists only at test runtime, never in the
	// working tree (session_secret_persistence would rightly flag it).
	const AWS_KEY_LINE = `const key = '${"AKIA" + "IOSFODNN7EXAMPLE"}';\n`;

	// test-contract: security — secret material written into the session
	// scratchpad must block unconditionally, regardless of extension.
	it("blocks secret material written to the session scratchpad (any extension)", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "creds.json"), {
			content: AWS_KEY_LINE,
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});

	// test-contract: security — the tmp-secrets scan covers ANY ephemeral temp
	// path, not only the session-scratchpad shape.
	it("blocks secret material on non-scratchpad temp paths too", () => {
		const { decision } = run(join(tmpdir(), "staging.txt"), { content: AWS_KEY_LINE });
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});

	// test-contract: invariant — when a write is both authored code AND
	// carries a secret, the secrets verdict must win over the placement
	// verdict (both would otherwise independently justify a block).
	it("secrets verdict outranks the placement verdict for code files", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "leak.ts"), {
			content: AWS_KEY_LINE,
		});
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});

	// test-contract: boundary — the tmp-secrets scan is scoped to ephemeral
	// paths; an in-repo write with the same secret content is left to the
	// separate protected-files/secrets-in-content checks.
	it("the secrets scan ignores in-repo writes (protected-files globs own those)", () => {
		const { decision } = run(join(ROOT, "src", "config.ts"), { content: AWS_KEY_LINE });
		expect(decision).toBeNull();
	});

	// test-contract: security — the escape hatch that suppresses the
	// code-placement block must NOT also suppress the tmp-secrets block.
	it("the escape hatch does NOT disable the secrets scan", () => {
		process.env.INTERLINKED_DISABLE_SCRATCH_GUARD = "1";
		const { decision } = run(scratchpadPath(SESSION_ID, "creds.env"), {
			content: AWS_KEY_LINE,
		});
		expect(decision?.rule_id).toBe("builtin-tmp-secrets");
	});

	// test-contract: kills the reason-chunk StringLiterals plus the
	// severity/category literals on the tmp-secrets block decision object
	it("tmp-secrets block carries exact severity, category, and full reason text", () => {
		const { decision } = run(scratchpadPath(SESSION_ID, "creds.json"), {
			content: AWS_KEY_LINE,
		});
		expect(decision?.severity).toBe("critical");
		expect(decision?.category).toBe("Security");
		expect(decision?.reason).toContain(
			"BLOCKED: Secrets detected in a write to an ephemeral temp path",
		);
		expect(decision?.reason).toContain(
			"Temp/scratchpad files sit outside the repo's protected-file globs but are a",
		);
		expect(decision?.reason).toContain(
			"classic exfil-staging surface — keep credentials out of temp files entirely.",
		);
	});

	// test-contract: kills `ephemeral && content` -> `true`/OR (decideEphemeralWrite).
	// The tmp-secrets scan must fire ONLY for genuinely ephemeral paths — a
	// scratch/ probe write (ephemeral === false) with the same secret content
	// must NOT be caught by it.
	it("does not run the tmp-secrets scan on scratch/ probe writes (ephemeral-only)", () => {
		const { decision } = run(join(ROOT, "scratch", "leak.ts"), { content: SECRET_LINE });
		expect(decision).toBeNull();
	});
});

describe("evaluateScratchpadWriteGuard — ephemeral-write ledger", () => {
	const withTmpProjectRoot = (fn: (cwd: string) => void): void => {
		const cwd = mkdtempSync(join(tmpdir(), "scratch-guard-ledger-"));
		try {
			mkdirSync(join(cwd, ".interlinked"));
			fn(cwd);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	};
	const logPath = (cwd: string): string => join(cwd, ".interlinked", "ephemeral-writes.jsonl");
	const readLastRecord = (cwd: string): { blocked: boolean } => {
		const lines = readFileSync(logPath(cwd), "utf-8").trim().split("\n");
		const last = lines.at(-1) ?? "";
		return JSON.parse(last);
	};

	// test-contract: kills the BlockStatement `{}` mutant on the append call,
	// the ConditionalExpression/LogicalOperator/BooleanLiteral mutants on
	// `ephemeral && !event.dry_run`, and the `false`-blocked ternary branch
	it("appends a record with blocked=false for a real (non-dry-run), allowed ephemeral write", () => {
		withTmpProjectRoot((cwd) => {
			const warnings: string[] = [];
			const decision = evaluateScratchpadWriteGuard(
				makeEvent({ cwd, dry_run: false }),
				"Write",
				{ file_path: scratchpadPath(SESSION_ID, "results.json"), content: "{}" },
				RULES,
				warnings,
			);
			expect(decision).toBeNull();
			expect(existsSync(logPath(cwd))).toBe(true);
			expect(readLastRecord(cwd).blocked).toBe(false);
		});
	});

	// test-contract: kills the `true`/`!==`/StringLiteral-"" mutants on the
	// `decision?.decision === "block"` ternary (needs a blocked=true case too)
	it("appends a record with blocked=true for a blocked ephemeral write", () => {
		withTmpProjectRoot((cwd) => {
			const warnings: string[] = [];
			const decision = evaluateScratchpadWriteGuard(
				makeEvent({ cwd, dry_run: false }),
				"Write",
				{ file_path: scratchpadPath(SESSION_ID, "creds.json"), content: SECRET_LINE },
				RULES,
				warnings,
			);
			expect(decision?.decision).toBe("block");
			expect(existsSync(logPath(cwd))).toBe(true);
			expect(readLastRecord(cwd).blocked).toBe(true);
		});
	});

	// test-contract: kills the `ephemeral && !event.dry_run` -> `true` mutant:
	// a dry_run write must NEVER reach the ledger.
	it("never appends a record for a dry-run write", () => {
		withTmpProjectRoot((cwd) => {
			const warnings: string[] = [];
			evaluateScratchpadWriteGuard(
				makeEvent({ cwd, dry_run: true }),
				"Write",
				{ file_path: scratchpadPath(SESSION_ID, "probe.json"), content: "{}" },
				RULES,
				warnings,
			);
			expect(existsSync(logPath(cwd))).toBe(false);
		});
	});

	// test-contract: kills the LogicalOperator `||` mutant on
	// `ephemeral && !event.dry_run` — a non-ephemeral write must never append
	// even when dry_run is false. Uses a project root OUTSIDE the OS temp tree
	// (scratch/ is not an ephemeral root) so the `.interlinked` ledger dir is
	// real and the no-append outcome is a genuine assertion, not a missing-dir
	// coincidence.
	it("never appends a record for a non-ephemeral, non-scratch write", () => {
		withTmpProjectRoot((cwd) => {
			// Keep the managed-project ledger writable under the test sandbox, but
			// make the attempted absolute target platform-rooted and non-ephemeral.
			// This remains valid when the clone and HOME both live below /var/folders.
			const target = join(parse(tmpdir()).root, "interlinked-non-temp-target", "src", "real.ts");
			const warnings: string[] = [];
			evaluateScratchpadWriteGuard(
				makeEvent({ cwd, dry_run: false }),
				"Write",
				{ file_path: target, content: "export {};\n" },
				RULES,
				warnings,
			);
			expect(existsSync(logPath(cwd))).toBe(false);
		});
	});
});
