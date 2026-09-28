import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/evaluator.js";

vi.mock("../hook-observations.js", () => ({ recordHookObservations: vi.fn() }));

describe("evaluatePreToolUse — file & network guards", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	// This suite exercises real repo-relative and `/tmp`-style file paths
	// with no per-test cwd isolation, so `findProjectRoot` falls back to this
	// repo's own cwd and every write lands in the REAL (gitignored)
	// `.interlinked/obligations.jsonl` ledger — shared across every local
	// test run. Accumulated debt/wander state from prior runs (this file's
	// own repeated local runs, or sibling evaluator suites) leaks into
	// unrelated cases here as spurious `transient_debt` blocks (reproduced:
	// "allows writing to normal code files" and "allows writing to .env
	// without secrets" start failing after a few repeated local runs).
	// Transient-debt behavior has its own dedicated coverage in
	// `evaluator/transient-debt-guard.test.ts` (nothing in this file
	// exercises it); bypass it here so this suite stays isolated from that
	// shared local state.
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
	// Protected Files
	// ===========================================

	describe("lock file and binary guards", () => {
		it("blocks editing package-lock.json", () => {
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "package-lock.json",
					old_string: '"version": "1.0.0"',
					new_string: '"version": "2.0.0"',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Lock files");
		});

		it("blocks writing to yarn.lock", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "yarn.lock", content: "# yarn lockfile" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks writing to binary files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "logo.png", content: "not a real png" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("binary");
		});

		it("allows writing to normal code files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "src/index.ts", content: "export const x = 1;" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	describe("sensitive file read blocking", () => {
		it("blocks reading .env", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: ".env" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("secrets");
		});

		it("blocks reading .env.local", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "/project/.env.local" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows reading .env.example", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: ".env.example" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks reading credentials.json", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "credentials.json" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks reading .pem files", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "server.pem" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});
	});

	describe("protected files", () => {
		it("blocks writing secrets to .env files", () => {
			// Reason: test fixture — a deliberately fake GH token pattern
			// assembled at runtime to exercise the secret-detection rule
			// without tripping the harness secrets scanner on the source file.
			// nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
			const fakeToken = `${"gh" + "p_"}1234567890abcdef1234567890abcdef1234`;
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: ".env",
					content: `API_KEY=${fakeToken}`,
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Secrets");
		});

		it("allows writing to .env without secrets", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: ".env",
					content: "NODE_ENV=production\nPORT=3000",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks reading private key files", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "certs/server.pem" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Private key");
		});
	});

	// ===========================================
	// Curl-to-MCP Detection
	// ===========================================

	describe("curl-to-MCP detection", () => {
		it("warns on curl to an /mcp path on a configured port", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:8787/mcp" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings).toBeDefined();
			expect(result.warnings?.some((w) => w.includes("localhost"))).toBe(true);
		});

		it("does NOT warn on curl to a non-MCP path (e.g. /health) — #21 FP", () => {
			// :8787 is the wrangler dev port for our own cloud governor; curling
			// /health or /governor/evaluate is normal dev work, not a dropped MCP.
			const healthEvent = makeEvent({
				tool_input: { command: "curl http://localhost:8787/health" },
			});
			const healthResult = evaluatePreToolUse(healthEvent, rules, session, reservations, cohort);
			expect(healthResult.warnings?.some((w) => w.includes("disconnected"))).toBeFalsy();
			expect(healthResult.warnings?.some((w) => w.includes("MCP server"))).toBeFalsy();

			const governorEvent = makeEvent({
				tool_input: { command: "curl -X POST http://localhost:8787/governor/evaluate" },
			});
			const govResult = evaluatePreToolUse(governorEvent, rules, session, reservations, cohort);
			expect(govResult.warnings?.some((w) => w.includes("disconnected"))).toBeFalsy();
		});

		it("warns (not blocks) after configured threshold on an /mcp path", () => {
			// Simulate 4 prior curl calls to same port
			for (let i = 0; i < 4; i++) {
				session.curl_localhost_count[8787] = i + 1;
			}

			const event = makeEvent({
				tool_input: { command: "curl http://localhost:8787/mcp/messages" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings).toBeDefined();
			expect(result.warnings?.some((w) => w.includes("disconnected"))).toBe(true);
		});

		it("warns on /sse path (MCP transport) too", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:3000/sse" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("localhost"))).toBe(true);
		});

		it("does not fire port-keyed curl-mcp detection for non-configured ports", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:9999/mcp" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			// The generic /mcp-route guard ("use MCP tools, not curl") still fires
			// on any /mcp curl, but the port-keyed disconnection detector must NOT —
			// 9999 isn't a configured port.
			expect(
				result.warnings?.some((w) => w.includes("disconnected") || w.includes("9999")),
			).toBeFalsy();
		});

		it("does NOT fire on a git commit whose MESSAGE mentions curl + /mcp (command-position FP)", () => {
			// The real FP: committing a message that describes this very guard.
			// The curl / `/mcp` tokens live in a quoted string or heredoc body,
			// not in command position, so neither the mcp-direct nudge nor the
			// port-keyed disconnection detector may fire. extractScannableText
			// blanks quoted / comment / heredoc spans before the guards test.
			const quoted = makeEvent({
				tool_input: {
					command: `git commit -m "guard: never curl http://localhost:8787/mcp directly"`,
				},
			});
			const quotedResult = evaluatePreToolUse(quoted, rules, session, reservations, cohort);
			expect(quotedResult.decision).toBe("allow");
			expect(quotedResult.warnings?.some((w) => w.includes("mcp-direct"))).toBeFalsy();
			expect(quotedResult.warnings?.some((w) => w.includes("disconnected"))).toBeFalsy();

			const heredoc = makeEvent({
				tool_input: {
					command:
						"git commit -F - <<'MSG'\nfix: scope curl-to-MCP to /mcp paths\n\nA curl to /mcp must not fire here.\nMSG",
				},
			});
			const heredocResult = evaluatePreToolUse(heredoc, rules, session, reservations, cohort);
			expect(heredocResult.warnings?.some((w) => w.includes("mcp-direct"))).toBeFalsy();
			expect(heredocResult.warnings?.some((w) => w.includes("disconnected"))).toBeFalsy();
		});

		it("still fires on a REAL executed curl to an /mcp endpoint (not a regression)", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:8787/mcp" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("mcp-direct"))).toBe(true);
		});
	});

	// ===========================================
	// Auto File Reservation
	// ===========================================

	describe("auto file reservation", () => {
		it("allows first write to unreserved file", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "hello" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows same agent to write again to reserved file", () => {
			// First write creates reservation
			const event1 = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "hello" },
			});
			evaluatePreToolUse(event1, rules, session, reservations, cohort);

			// Second write by same agent (use Write, not Edit, to avoid old_string check)
			const event2 = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "world" },
			});
			const result = evaluatePreToolUse(event2, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	// ===========================================
	// Safe Commands (Should ALL Allow)
	// ===========================================

	describe("safe commands", () => {
		// `cat package.json` is not asserted here: whether it passes depends
		// on the fixture file's line count vs the file-dump cap (200 as of
		// 2026-07-24). The guard's own suite pins that boundary; this list
		// keeps only commands that are shape-safe regardless of file size.
		//
		// `npm install` is also NOT here — the supply-chain allowlist gate
		// (added 2026-05) now blocks bare installs until a snapshot is
		// approved. See `evaluator/package-install-guard.test.ts`.
		const safeCommands = [
			"ls -la",
			"npm run test",
			"git status",
			"git add .",
			"git commit -m 'test'",
			"git push origin main",
			"head -n 5 package.json",
			"echo hello",
			"node --version",
			"npx vitest run",
			"curl https://api.example.com",
		];

		for (const cmd of safeCommands) {
			it(`allows: ${cmd}`, () => {
				const event = makeEvent({ tool_input: { command: cmd } });
				const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
				expect(result.decision).toBe("allow");
			});
		}
	});
});
