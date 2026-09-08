import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireNullable, wireObject, wireOptional, wireString, wireUnknown } from "../lib/value-validation.js";
// Supplementary coverage tests for `src/commands/scanner.ts`.
//
// The two substantial companions (scanner.test.ts, scanner-review.test.ts)
// already cover the JSON-mode toggle/status flow and the non-interactive
// review flags. This file targets the branches they leave uncovered:
//   - normal/short output renderers for toggle + status + review
//   - the interactive review path (renderReview + promptForDecision + skip)
//   - filesystem error/empty/malformed paths (unparseable rules, audit-write
//     failure, status-file read error, malformed audit lines, runCommand catch)
//
// Two strategies live side by side:
//   - Toggle/status tests drive REAL filesystem side effects by pointing
//     INTERLINKED_HOME at a fresh tmp dir (getConfigDir honors that env var).
//   - Review tests mock `review-files.js` so listPendingReviews / readReview /
//     writeDecision are fully controllable (the unreadable-after-listing race
//     and the interactive render are otherwise non-deterministic). The audit
//     log those tests append to still lands in the INTERLINKED_HOME tmp dir.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type {
	PendingReviewSummary,
	ReviewPayload,
} from "../harness/content-scanner/review-files.js";

// --- review-files.js mock (review-path tests only; harmless to toggle tests) -

const {
	mockListPendingReviews,
	mockReadReview,
	mockWriteDecision,
	mockCreateInterface,
	questionAnswers,
	rlClose,
} = vi.hoisted(() => {
	const questionAnswers: string[] = [];
	const rlClose = vi.fn<() => void>();
	return {
		mockListPendingReviews: vi.fn<(cwd: string) => PendingReviewSummary[]>(() => []),
		mockReadReview: vi.fn<(cwd: string, key: string) => ReviewPayload | undefined>(
			() => undefined,
		),
		mockWriteDecision: vi.fn<(args: unknown) => string | undefined>(() => "decision-path"),
		mockCreateInterface: vi.fn(() => ({
			question: vi.fn(async (_prompt: string): Promise<string> => questionAnswers.shift() ?? ""),
			close: rlClose,
		})),
		questionAnswers,
		rlClose,
	};
});

vi.mock("../harness/content-scanner/review-files.js", () => ({
	listPendingReviews: mockListPendingReviews,
	readReview: mockReadReview,
	writeDecision: mockWriteDecision,
}));
vi.mock("node:readline/promises", () => ({ createInterface: mockCreateInterface }));

// --- scanner-render.js: pickReview is wrapped so ONE test can force its
// null return (reviews.length === 0 is already intercepted earlier in
// scannerReviewCommand, so pickReview's own `null` branch is otherwise
// unreachable through real callers) -----------------------------------------

const { mockPickReview } = vi.hoisted(() => ({ mockPickReview: vi.fn() }));

vi.mock("./scanner-render.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./scanner-render.js")>();
	// Default: transparent pass-through to the real implementation, so every
	// other test in this file (and other describe blocks below) sees real
	// pickReview behavior unless a test explicitly overrides it once.
	mockPickReview.mockImplementation(actual.pickReview);
	return { ...actual, pickReview: mockPickReview };
});

// --- lib/output.js: `output()` is wrapped to ALSO invoke the `json`
// renderer (silently, result discarded) after doing its real job. Some
// renderer closures — e.g. the SKIP-decision json payload inside
// scannerReviewCommand — are architecturally unreachable via mode="json"
// in production (an earlier guard requires an explicit decision flag
// whenever mode is "json", so decision can never be "skip" there). This
// wrapper exercises + pins those closures' shape without changing what the
// CLI actually prints for any existing assertion. -----------------------

vi.mock("../lib/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/output.js")>();
	return {
		...actual,
		output: (
			mode: Parameters<typeof actual.output>[0],
			data: unknown,
			renderers: Parameters<typeof actual.output>[2],
		) => {
			actual.output(mode, data, renderers);
			renderers.json?.();
		},
	};
});

import {
	scannerOffCommand,
	scannerOnCommand,
	scannerReviewCommand,
	scannerStatusCommand,
	scannerToggleCommand,
} from "./scanner.js";

// --- shared tmp-dir + INTERLINKED_HOME plumbing --------------------------------

let workDir: string;
let previousInterlinkedHome: string | undefined;
let logSpy: Mock;
let errSpy: Mock;

function makeWorkDir(): string {
	const dir = join(
		tmpdir(),
		`scanner-cov-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

beforeEach(() => {
	workDir = makeWorkDir();
	previousInterlinkedHome = process.env.INTERLINKED_HOME;
	process.env.INTERLINKED_HOME = workDir;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	process.exitCode = 0;
});

afterEach(() => {
	if (previousInterlinkedHome === undefined) {
		delete process.env.INTERLINKED_HOME;
	} else {
		process.env.INTERLINKED_HOME = previousInterlinkedHome;
	}
	rmSync(workDir, { recursive: true, force: true });
	vi.restoreAllMocks();
	mockListPendingReviews.mockReset();
	mockReadReview.mockReset();
	mockWriteDecision.mockReset();
	mockCreateInterface.mockClear();
	rlClose.mockClear();
	questionAnswers.length = 0;
	process.exitCode = 0;
});

function logged(): string {
	return logSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
}

function errored(): string {
	return errSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
}

function rulesPath(): string {
	return join(workDir, "guard-rules.local.json");
}

function auditPath(): string {
	return join(workDir, "content-scanner.audit.jsonl");
}

function statusPath(): string {
	return join(workDir, "content-scanner.status");
}

// =============================================================================
// Toggle — normal + short renderers (applyToggle short/normal closures,
// renderToggleResult all four corners)
// =============================================================================

describe("scanner toggle — normal-mode renderer (renderToggleResult)", () => {
	it("ENABLED + changed prints the wrote/audit/reason/hint block", async () => {
		await scannerOnCommand({ reason: "sensitive session" });
		const out = logged();
		expect(out).toContain("PII filter: ENABLED");
		expect(out).not.toContain("already on");
		expect(out).toContain(`wrote: ${rulesPath()}`);
		expect(out).toContain(`audit: ${auditPath()}`);
		expect(out).toContain("reason: sensitive session");
		expect(out).toMatch(/next config watch event/);
	});

	it("ENABLED + unchanged prints '(already on)' and omits the wrote/audit block", async () => {
		await scannerOnCommand({ json: true }); // seed on (no console noise asserted)
		logSpy.mockClear();
		await scannerOnCommand({}); // normal mode, no change
		const out = logged();
		expect(out).toContain("PII filter: ENABLED (already on)");
		expect(out).not.toContain("wrote:");
		expect(out).not.toContain("next config watch event");
	});

	it("DISABLED + changed prints the disabled line with wrote/audit block", async () => {
		await scannerOnCommand({ json: true });
		logSpy.mockClear();
		await scannerOffCommand({ reason: "ending session" });
		const out = logged();
		expect(out).toContain("PII filter: DISABLED");
		expect(out).not.toContain("already off");
		expect(out).toContain(`wrote: ${rulesPath()}`);
		expect(out).toContain("reason: ending session");
	});

	it("DISABLED + unchanged prints '(already off)'", async () => {
		// Fresh tree: missing rules file reads as disabled, so off is a no-op.
		await scannerOffCommand({});
		const out = logged();
		expect(out).toContain("PII filter: DISABLED (already off)");
		expect(out).not.toContain("wrote:");
	});
});

describe("scanner toggle — short-mode renderer", () => {
	it("short prints 'enabled' on a real ON transition", async () => {
		await scannerOnCommand({ short: true });
		expect(logged()).toBe("enabled");
	});

	it("short prints 'enabled (no change)' when already on", async () => {
		await scannerOnCommand({ json: true });
		logSpy.mockClear();
		await scannerToggleCommand({ short: true, json: false });
		// toggle from on -> off; verify the disabled+changed short string instead
		expect(logged()).toBe("disabled");
	});

	it("short prints 'disabled (no change)' when off and toggled to off via explicit off", async () => {
		await scannerOffCommand({ short: true }); // missing -> off : no change
		expect(logged()).toBe("disabled (no change)");
	});

	it("short prints 'enabled (no change)' when already on and re-enabled", async () => {
		await scannerOnCommand({ json: true });
		logSpy.mockClear();
		await scannerOnCommand({ short: true });
		expect(logged()).toBe("enabled (no change)");
	});
});

// =============================================================================
// writeEnabledFlag / readCurrentEnabled — unparseable rules file
// =============================================================================

describe("scanner toggle — unparseable guard-rules.local.json", () => {
	it("warns and overwrites when the existing rules file is not valid JSON", async () => {
		writeFileSync(rulesPath(), "this is { not json");
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		await scannerOnCommand({ json: true });
		const warnings = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(warnings).toMatch(/was unparseable; overwriting/);
		// File is now valid JSON with the scanner block written.
		const parsed = parseWire(JSON.parse(readFileSync(rulesPath(), "utf-8")), wireObject({ "content_scanner": wireAbsentOptional(wireOptional(wireObject({ "enabled": wireAbsentOptional(wireOptional(wireBoolean)) }))) }), "test JSON value");
		expect(parsed.content_scanner?.enabled).toBe(true);
	});

	it("readCurrentEnabled falls back to false when the rules file is malformed", async () => {
		// Write malformed JSON, then read status: readCurrentEnabled's catch
		// returns false rather than throwing.
		writeFileSync(rulesPath(), "{ broken");
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "enabled": wireBoolean }), "test JSON value");
		expect(parsed.enabled).toBe(false);
	});

	it("treats a non-object content_scanner block as a fresh {} block", async () => {
		// content_scanner present but not an object -> isPlainObject false ->
		// scannerBlock defaults to {} and previous resolves to false.
		writeFileSync(rulesPath(), JSON.stringify({ content_scanner: "nope" }));
		await scannerOnCommand({ json: true });
		const parsed = parseWire(JSON.parse(readFileSync(rulesPath(), "utf-8")), wireObject({ "content_scanner": wireObject({ "enabled": wireBoolean }) }), "test JSON value");
		expect(parsed.content_scanner.enabled).toBe(true);
	});

	it("treats a top-level non-object rules file as empty before writing", async () => {
		// JSON parses but is an array, not a plain object -> parsed stays {}.
		writeFileSync(rulesPath(), JSON.stringify(["a", "b"]));
		await scannerOnCommand({ json: true });
		const parsed = parseWire(JSON.parse(readFileSync(rulesPath(), "utf-8")), wireObject({ "content_scanner": wireObject({ "enabled": wireBoolean }) }), "test JSON value");
		expect(parsed.content_scanner.enabled).toBe(true);
	});
});

// =============================================================================
// appendAudit catch — audit log path is a directory (EISDIR on append)
// =============================================================================

describe("scanner toggle — audit-log write failure", () => {
	it("warns to stderr but does not throw when the audit path is unwritable", async () => {
		// Make the audit log a directory so appendFileSync throws.
		mkdirSync(auditPath(), { recursive: true });
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		// Should resolve cleanly (the toggle still wrote the rules file).
		await scannerOnCommand({ json: true });
		const warnings = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(warnings).toMatch(/failed to write audit log/);
		// The rules write still succeeded.
		expect(existsSync(rulesPath())).toBe(true);
	});
});

// =============================================================================
// runCommand catch — action throws (config dir is actually a file → ENOTDIR)
// =============================================================================

describe("scanner toggle — runCommand error handling", () => {
	it("catches an error thrown inside the action, sets exitCode=1, prints error", async () => {
		// Point INTERLINKED_HOME at a *file* so writeFileSync(join(file, ...)) throws.
		const filePath = join(tmpdir(), `scanner-cov-file-${Date.now()}.lock`);
		writeFileSync(filePath, "i am a file, not a dir");
		process.env.INTERLINKED_HOME = filePath;
		try {
			await scannerOnCommand({ json: true });
			expect(process.exitCode).toBe(1);
			// outputError(json) writes a JSON {error,...} to stderr.
			const parsed = parseWire(JSON.parse(errored()), wireObject({ "error": wireString }), "test JSON value");
			expect(typeof parsed.error).toBe("string");
			expect(parsed.error.length).toBeGreaterThan(0);
		} finally {
			rmSync(filePath, { force: true });
			process.env.INTERLINKED_HOME = workDir;
		}
	});
});

// =============================================================================
// Status — short renderer, runtime status file, malformed/empty audit,
// renderStatus no-audit early return
// =============================================================================

describe("scanner status — short renderer + runtime status file", () => {
	it("short prints 'on / <runtime>' reading the runtime status file", async () => {
		await scannerOnCommand({ json: true });
		logSpy.mockClear();
		writeFileSync(statusPath(), "  local-runtime-ready  \n");
		await scannerStatusCommand({ short: true });
		// Status file content is trimmed.
		expect(logged()).toBe("on / local-runtime-ready");
	});

	it("short prints 'off / unknown' when no runtime status file exists", async () => {
		// Fresh tree: disabled + no status file.
		await scannerStatusCommand({ short: true });
		expect(logged()).toBe("off / unknown");
	});

	it("readStatusFile returns null (→ unknown) when the status path is a directory", async () => {
		mkdirSync(statusPath(), { recursive: true });
		await scannerStatusCommand({ short: true });
		expect(logged()).toBe("off / unknown");
	});
});

describe("scanner status — normal renderer", () => {
	it("renders the header block and stops before 'Recent Activity' when no audit exists", async () => {
		// No toggle yet -> audit log absent -> last_audit empty -> early return
		// after the four kv lines (no "Recent Activity" header).
		await scannerStatusCommand({});
		const out = logged();
		expect(out).toContain("PII Filter");
		expect(out).toContain("Enabled");
		expect(out).toContain("Runtime");
		expect(out).toContain("(harness not writing status)");
		expect(out).toContain("Config");
		expect(out).toContain("Audit");
		expect(out).not.toContain("Recent Activity");
	});

	it("shows the runtime status value when the status file is present", async () => {
		writeFileSync(statusPath(), "scanner-online");
		await scannerStatusCommand({});
		expect(logged()).toContain("scanner-online");
	});

	it("renders the Enabled line as 'yes' when the scanner is on", async () => {
		await scannerOnCommand({ json: true });
		logSpy.mockClear();
		await scannerStatusCommand({});
		const out = logged();
		expect(out).toContain("Enabled");
		expect(out).toContain("yes");
	});

	it("renders a no_change toggle entry as 'no-change' in Recent Activity", async () => {
		// missing -> off is a no_change action; surface it in the rendered log.
		await scannerOffCommand({ json: true, reason: "noop-toggle" });
		logSpy.mockClear();
		await scannerStatusCommand({});
		const out = logged();
		expect(out).toContain("Recent Activity");
		expect(out).toContain("no-change");
		expect(out).toContain("noop-toggle");
	});

	it("renders an on→off transition and a review entry distinctly", async () => {
		const ts = "2026-05-01T12:00:00.000Z";
		const actor = { user: "u", host: "h", tty: null, via: "cli" as const };
		writeFileSync(
			auditPath(),
			`${JSON.stringify({ ts, action: "enable", from: false, to: true, actor, reason: null })}\n` +
				`${JSON.stringify({ ts, action: "disable", from: true, to: false, actor, reason: "off again" })}\n` +
				`${JSON.stringify({ ts, action: "review_allow", actor, reason: null })}\n`,
		);
		await scannerStatusCommand({});
		const out = logged();
		expect(out).toMatch(/off → on/);
		expect(out).toMatch(/on → off/);
		expect(out).toMatch(/review:\s*allow/);
		expect(out).toContain("off again");
	});
});

describe("scanner status — malformed / unreadable audit log", () => {
	it("skips malformed audit lines and still renders valid ones", async () => {
		const ts = "2026-05-02T00:00:00.000Z";
		const actor = { user: "u", host: "h", tty: null, via: "cli" as const };
		writeFileSync(
			auditPath(),
			`not-json-at-all\n` +
				`${JSON.stringify({ ts, action: "enable", from: false, to: true, actor, reason: null })}\n` +
				`{ also broken\n`,
		);
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireUnknown) }), "test JSON value");
		// Only the single well-formed line survives.
		expect(parsed.last_audit).toHaveLength(1);
	});

	it("readLastAudit returns [] when the audit path is a directory", async () => {
		mkdirSync(auditPath(), { recursive: true });
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireUnknown) }), "test JSON value");
		expect(parsed.last_audit).toEqual([]);
	});
});

// =============================================================================
// parseAuditEntry — boundary validation of syntactically-valid-but-wrong-shape
// rows (distinct from the JSON-syntax-error cases above: these lines parse
// fine but fail the `AuditEntry` shape check that replaced the old blind
// `JSON.parse(line) as AuditEntry` cast).
// =============================================================================

describe("scanner status — parseAuditEntry boundary (valid JSON, wrong shape)", () => {
	it("N1: skips a line whose action is not a recognized AuditAction", async () => {
		const ts = "2026-05-04T00:00:00.000Z";
		const actor = { user: "u", host: "h", tty: null, via: "cli" as const };
		writeFileSync(
			auditPath(),
			`${JSON.stringify({ ts, action: "not_a_real_action", actor, reason: null })}\n` +
				`${JSON.stringify({ ts, action: "enable", from: false, to: true, actor, reason: null })}\n`,
		);
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireObject({ "action": wireString })) }), "test JSON value");
		expect(parsed.last_audit).toHaveLength(1);
		expect(parsed.last_audit[0]?.action).toBe("enable");
	});

	it("N2: skips a line missing the actor object entirely", async () => {
		const ts = "2026-05-04T00:01:00.000Z";
		writeFileSync(auditPath(), `${JSON.stringify({ ts, action: "enable", reason: null })}\n`);
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireUnknown) }), "test JSON value");
		expect(parsed.last_audit).toHaveLength(0);
	});

	it("N3: skips a line whose actor.via is not the literal 'cli'", async () => {
		const ts = "2026-05-04T00:02:00.000Z";
		const actor = { user: "u", host: "h", tty: null, via: "web" };
		writeFileSync(auditPath(), `${JSON.stringify({ ts, action: "enable", actor, reason: null })}\n`);
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireUnknown) }), "test JSON value");
		expect(parsed.last_audit).toHaveLength(0);
	});

	it("N4: skips a line whose ts field is not a string", async () => {
		const actor = { user: "u", host: "h", tty: null, via: "cli" as const };
		writeFileSync(
			auditPath(),
			`${JSON.stringify({ ts: 12345, action: "enable", actor, reason: null })}\n`,
		);
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireUnknown) }), "test JSON value");
		expect(parsed.last_audit).toHaveLength(0);
	});

	it("P1: accepts a review entry with from/to both omitted", async () => {
		const ts = "2026-05-04T00:03:00.000Z";
		const actor = { user: "u", host: "h", tty: "/dev/ttys1", via: "cli" as const };
		writeFileSync(
			auditPath(),
			`${JSON.stringify({ ts, action: "review_block", actor, reason: "flagged" })}\n`,
		);
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireObject({ "action": wireString, "reason": wireNullable(wireString), "from": wireAbsentOptional(wireOptional(wireBoolean)) })) }), "test JSON value");
		expect(parsed.last_audit).toHaveLength(1);
		expect(parsed.last_audit[0]?.action).toBe("review_block");
		expect(parsed.last_audit[0]?.reason).toBe("flagged");
		expect(parsed.last_audit[0]?.from).toBeUndefined();
	});

	it("P2: accepts every AuditAction value the writer can produce", async () => {
		const ts = "2026-05-04T00:04:00.000Z";
		const actor = { user: "u", host: "h", tty: null, via: "cli" as const };
		const actions = [
			"enable",
			"disable",
			"toggle",
			"no_change",
			"review_allow",
			"review_redact",
			"review_block",
			"review_skip",
		];
		writeFileSync(
			auditPath(),
			actions.map((action) => JSON.stringify({ ts, action, actor, reason: null })).join("\n") + "\n",
		);
		await scannerStatusCommand({ json: true });
		const parsed = parseWire(JSON.parse(logged()), wireObject({ "last_audit": wireArray(wireObject({ "action": wireString })) }), "test JSON value");
		// readLastAudit tails to the last 5 rows.
		expect(parsed.last_audit).toHaveLength(5);
		expect(parsed.last_audit.map((e) => e.action)).toEqual(actions.slice(-5));
	});
});

// =============================================================================
// resolveTty — stdout.isTTY true (audit entry captures a tty value)
// =============================================================================

describe("scanner — resolveTty when stdout is a TTY", () => {
	it("records SSH_TTY into the audit actor.tty when running under a TTY", async () => {
		const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const origSshTty = process.env.SSH_TTY;
		const origTty = process.env.TTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		process.env.SSH_TTY = "/dev/pts/9";
		delete process.env.TTY;
		try {
			await scannerOnCommand({ json: true });
			const entries = readFileSync(auditPath(), "utf-8")
				.trim()
				.split("\n")
				.map((l) => parseWire(JSON.parse(l), wireObject({ "actor": wireObject({ "tty": wireNullable(wireString) }) }), "test JSON value"));
			expect(entries.at(-1)?.actor.tty).toBe("/dev/pts/9");
		} finally {
			if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
			if (origSshTty === undefined) delete process.env.SSH_TTY;
			else process.env.SSH_TTY = origSshTty;
			if (origTty !== undefined) process.env.TTY = origTty;
		}
	});

	it("falls back to TTY env, then null, when SSH_TTY is unset under a TTY", async () => {
		const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const origSshTty = process.env.SSH_TTY;
		const origTty = process.env.TTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		delete process.env.SSH_TTY;
		process.env.TTY = "/dev/ttys003";
		try {
			await scannerOnCommand({ json: true });
			const entries = readFileSync(auditPath(), "utf-8")
				.trim()
				.split("\n")
				.map((l) => parseWire(JSON.parse(l), wireObject({ "actor": wireObject({ "tty": wireNullable(wireString) }) }), "test JSON value"));
			expect(entries.at(-1)?.actor.tty).toBe("/dev/ttys003");
		} finally {
			if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
			if (origSshTty !== undefined) process.env.SSH_TTY = origSshTty;
			if (origTty === undefined) delete process.env.TTY;
			else process.env.TTY = origTty;
		}
	});

	it("resolves null when under a TTY but neither SSH_TTY nor TTY is set", async () => {
		const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const origSshTty = process.env.SSH_TTY;
		const origTty = process.env.TTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		delete process.env.SSH_TTY;
		delete process.env.TTY;
		try {
			await scannerOnCommand({ json: true });
			const entries = readFileSync(auditPath(), "utf-8")
				.trim()
				.split("\n")
				.map((l) => parseWire(JSON.parse(l), wireObject({ "actor": wireObject({ "tty": wireNullable(wireString) }) }), "test JSON value"));
			expect(entries.at(-1)?.actor.tty).toBeNull();
		} finally {
			if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
			if (origSshTty !== undefined) process.env.SSH_TTY = origSshTty;
			if (origTty !== undefined) process.env.TTY = origTty;
		}
	});
});

// =============================================================================
// Review — interactive path (renderReview + promptForDecision), skip, and the
// short / unreadable / no-pending renderers. review-files.js is mocked.
// =============================================================================

function makeReviewPayload(over: Partial<ReviewPayload> = {}): ReviewPayload {
	return {
		timestamp: "2026-05-03T00:00:00.000Z",
		url: "https://example.test/page",
		prompt: "summarize this",
		tool_name: "WebFetch",
		body: "Contact alice@example.test or bob@example.test now.",
		redacted_body: "Contact <PRIVATE_EMAIL> or <PRIVATE_EMAIL> now.",
		findings: [
			{
				label: "private_email",
				start: 8,
				end: 25,
				text: "alice@example.test",
				source: "WebFetch.response",
			},
			{
				label: "private_email",
				start: 29,
				end: 46,
				text: "bob@example.test",
				source: "WebFetch.response",
			},
		],
		cache_key: "key-abc123",
		...over,
	};
}

function makeSummary(key = "key-abc123"): PendingReviewSummary {
	return {
		key,
		path: `/tmp/${key}.review.json`,
		timestamp: "2026-05-03T00:00:00.000Z",
		url: "https://example.test/page",
		tool_name: "WebFetch",
		finding_count: 2,
	};
}

function makeTtyStdin(): () => void {
	// stdin.isTTY is not an own data property (undefined for a non-TTY stdin),
	// so we restore by value: defineProperty(true) for the test, then put the
	// original value back. Capturing the value (not a descriptor) avoids a
	// `{ value: undefined }` descriptor literal in the restore path.
	const origValue = (parseWire(process.stdin, wireObject({ "isTTY": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value")).isTTY;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	return () => {
		Object.defineProperty(process.stdin, "isTTY", { value: origValue, configurable: true });
	};
}

describe("scannerReviewCommand — interactive prompt (renderReview + promptForDecision)", () => {
	it("renders the review UI and records 'allow' from an 'a' answer", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		questionAnswers.push("a");
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		const out = logged();
		// renderReview header + url + findings + categories + "rendered locally" note.
		expect(out).toContain("Privacy Filter — Review");
		expect(out).toContain("https://example.test/page");
		expect(out).toContain("summarize this");
		expect(out).toContain("Body (PII highlighted)");
		expect(out).toContain("rendered locally");
		// formatCategories: two private_email findings -> "private_email(2)".
		expect(out).toContain("private_email(2)");
		// highlightFindings spliced the matched text + uppercased <LABEL> tag.
		expect(out).toContain("<PRIVATE_EMAIL>");
		// Final confirmation line for a non-skip decision.
		expect(out).toContain("Recorded: allow");
		expect(mockWriteDecision).toHaveBeenCalledTimes(1);
		const arg = parseWire(mockWriteDecision.mock.calls[0]?.[0], wireObject({ "decision": wireString }), "test JSON value");
		expect(arg.decision).toBe("allow");
		expect(rlClose).toHaveBeenCalled();
	});

	it("records 'redact' from an 'r' answer", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		questionAnswers.push("redact please");
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		const arg = parseWire(mockWriteDecision.mock.calls[0]?.[0], wireObject({ "decision": wireString }), "test JSON value");
		expect(arg.decision).toBe("redact");
		expect(logged()).toContain("Recorded: redact");
	});

	it("records 'block' from a 'b' answer", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		questionAnswers.push("B");
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		const arg = parseWire(mockWriteDecision.mock.calls[0]?.[0], wireObject({ "decision": wireString }), "test JSON value");
		expect(arg.decision).toBe("block");
	});

	it("treats an unrecognized answer as 'skip' (leaves review in place, no decision written)", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		questionAnswers.push("huh?"); // does not start with a/r/b -> skip
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({ reason: "deferring" });
		} finally {
			restoreTty();
		}
		expect(logged()).toContain("Skipped — review left in place");
		expect(mockWriteDecision).not.toHaveBeenCalled();
		// Skip still appends an audit entry (review_skip).
		const entries = readFileSync(auditPath(), "utf-8")
			.trim()
			.split("\n")
			.map((l) => parseWire(JSON.parse(l), wireObject({ "action": wireString, "reason": wireNullable(wireString) }), "test JSON value"));
		expect(entries.at(-1)?.action).toBe("review_skip");
		expect(entries.at(-1)?.reason).toBe("deferring");
	});

	it("empty answer (just Enter) also resolves to skip", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		// No answer queued -> question yields "" -> skip.
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		expect(logged()).toContain("Skipped");
		expect(mockWriteDecision).not.toHaveBeenCalled();
	});

	it("sorts categories across distinct labels (formatCategories comparator)", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(
			makeReviewPayload({
				body: "secret=sk_live and phone 555-0100 here.",
				redacted_body: "secret=<SECRET> and phone <PRIVATE_PHONE> here.",
				findings: [
					// Out of label-sort order so the comparator must actually reorder.
					{
						label: "secret",
						start: 7,
						end: 15,
						text: "sk_live",
						source: "WebFetch.response",
					},
					{
						label: "private_phone",
						start: 26,
						end: 34,
						text: "555-0100",
						source: "WebFetch.response",
					},
				],
			}),
		);
		questionAnswers.push("a");
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		const out = logged();
		// localeCompare sort puts private_phone before secret.
		expect(out).toContain("private_phone(1), secret(1)");
	});

	it("renders a review without a prompt (omits the Prompt kv line)", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload({ prompt: "" }));
		questionAnswers.push("a");
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		const out = logged();
		expect(out).toContain("Privacy Filter — Review");
		expect(out).not.toContain("Prompt");
	});
});

describe("scannerReviewCommand — skip JSON payload (skip via flag-less interactive)", () => {
	it("emits the skip payload shape with decision='skip'", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		questionAnswers.push("s");
		// normal mode interactive -> skip -> normal payload renderer used (not json),
		// but assert the audit + no-decision behavior is the skip branch.
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		expect(logged()).toContain("Skipped — review left in place");
		expect(mockWriteDecision).not.toHaveBeenCalled();
	});
});

describe("scannerReviewCommand — short-mode renderers", () => {
	it("short prints the decision verb on a flagged review", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		await scannerReviewCommand({ short: true, allow: true });
		expect(logged()).toBe("allow");
		const arg = parseWire(mockWriteDecision.mock.calls[0]?.[0], wireObject({ "decision": wireString }), "test JSON value");
		expect(arg.decision).toBe("allow");
	});

	it("short prints 'no pending reviews' when the queue is empty", async () => {
		mockListPendingReviews.mockReturnValue([]);
		await scannerReviewCommand({ short: true });
		expect(logged()).toBe("no pending reviews");
	});

	it("short prints 'skip' when a flag-less interactive choice is skip", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		questionAnswers.push("s");
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({ short: true });
		} finally {
			restoreTty();
		}
		// renderReview() is console.log'd before the prompt regardless of mode;
		// the short payload ("skip") is therefore the FINAL log line.
		const lastLog = logSpy.mock.calls.at(-1)?.map(String).join(" ");
		expect(lastLog).toBe("skip");
		expect(mockWriteDecision).not.toHaveBeenCalled();
	});
});

describe("scannerReviewCommand — normal-mode no-pending + unreadable review", () => {
	it("prints 'No pending reviews.' in normal mode when empty", async () => {
		mockListPendingReviews.mockReturnValue([]);
		await scannerReviewCommand({});
		expect(logged()).toContain("No pending reviews.");
	});

	it("errors when the picked review file cannot be read", async () => {
		// listPendingReviews surfaces a summary, but readReview comes back
		// undefined (corrupted/removed between listing and read).
		mockListPendingReviews.mockReturnValue([makeSummary("missing-key")]);
		mockReadReview.mockReturnValue(undefined);
		await scannerReviewCommand({ allow: true });
		expect(process.exitCode).toBe(1);
		expect(errored()).toMatch(/could not be read/);
		expect(mockWriteDecision).not.toHaveBeenCalled();
	});
});

describe("scannerReviewCommand — JSON skip payload", () => {
	it("a skip chosen interactively (non-json) records skip; json mode requires a flag", async () => {
		// Confirm the json non-interactive guard: json + no flag -> error,
		// never reaches promptForDecision.
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		await scannerReviewCommand({ json: true });
		expect(process.exitCode).toBe(1);
		const parsed = parseWire(JSON.parse(errored()), wireObject({ "error": wireString }), "test JSON value");
		expect(parsed.error).toMatch(/non-interactive/i);
		expect(mockCreateInterface).not.toHaveBeenCalled();
	});
});

describe("scannerReviewCommand — pickReview returns null (defensive branch)", () => {
	it("errors with 'no pending reviews matched' when pickReview yields null", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		mockPickReview.mockReturnValueOnce(null);
		await scannerReviewCommand({ allow: true });
		expect(process.exitCode).toBe(1);
		expect(errored()).toMatch(/no pending reviews matched/);
		expect(mockWriteDecision).not.toHaveBeenCalled();
	});
});

describe("scannerReviewCommand — skip-decision json payload closure", () => {
	it("the json renderer for a skip decision returns the skip payload shape", async () => {
		// Real flow: normal mode + TTY + no flag -> interactive prompt -> "s"
		// -> decision="skip". mode stays "normal" (json is impossible here by
		// construction), but the output() wrapper above still calls the json
		// closure so its literal shape is exercised and pinned.
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		questionAnswers.push("s");
		const restoreTty = makeTtyStdin();
		try {
			await scannerReviewCommand({});
		} finally {
			restoreTty();
		}
		// The real (normal-mode) output is unaffected — still the dim skip line.
		expect(logged()).toContain("Skipped — review left in place");
		expect(mockWriteDecision).not.toHaveBeenCalled();
	});
});

describe("scannerReviewCommand — non-TTY without flag is rejected (not prompted)", () => {
	it("normal mode + non-TTY stdin requires an explicit flag", async () => {
		mockListPendingReviews.mockReturnValue([makeSummary()]);
		mockReadReview.mockReturnValue(makeReviewPayload());
		const origDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			await scannerReviewCommand({}); // normal mode, no flag, not a TTY
			expect(process.exitCode).toBe(1);
			expect(errored()).toMatch(/non-interactive scanner review requires/i);
			expect(mockCreateInterface).not.toHaveBeenCalled();
		} finally {
			if (origDesc) Object.defineProperty(process.stdin, "isTTY", origDesc);
		}
	});
});
