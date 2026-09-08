import { parseWire, wireNullable, wireNumber, wireObject, wireRecord, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked audit — CLI surface behavioral tests
// ===========================================
// Drives every branch of auditVerifyCommand by mocking the verifier
// (../lib/audit-chain.js) so we can return crafted AuditVerifyResult
// shapes deterministically, and the formatter (../lib/formatter.js) so
// `c.*` is an identity pass-through — assertions match raw substrings
// regardless of TTY/NO_COLOR/CI color gating.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditVerifyResult } from "../lib/audit-chain.js";
import { nonNull } from "../lib/non-null.js";
import { auditVerifyCommand } from "./audit.js";

// Identity formatter: strip ANSI from the equation so we assert on text.
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
	},
}));

// Mockable verifier. Each test sets `verifyResult`; the spy returns it.
const verifyAuditChainStreaming = vi.fn<(cwd: string) => Promise<AuditVerifyResult>>();
vi.mock("../lib/audit-chain.js", () => ({
	verifyAuditChainStreaming: (cwd: string) => verifyAuditChainStreaming(cwd),
}));

// A fully-valid, fully-chained baseline result. Tests clone + override.
function baseResult(over: Partial<AuditVerifyResult> = {}): AuditVerifyResult {
	return {
		valid: true,
		total_events: 100,
		guard_events: 40,
		chained_events: 40,
		unchained_guard_events: 0,
		last_hash: "a".repeat(64),
		...over,
	};
}

let logged: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

function out(): string {
	return logged.join("\n");
}

beforeEach(() => {
	logged = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logged.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	});
	verifyAuditChainStreaming.mockReset();
	// Default exitCode is reset per-test so the `!valid` assertions are clean.
	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	process.exitCode = undefined;
});

// ===========================================
// cwd resolution (line 19 ternary)
// ===========================================

describe("auditVerifyCommand — cwd resolution", () => {
	it("passes opts.cwd straight through to the verifier when it is a string", async () => {
		verifyAuditChainStreaming.mockResolvedValue(baseResult());
		await auditVerifyCommand({ cwd: "/some/explicit/dir" });
		expect(verifyAuditChainStreaming).toHaveBeenCalledWith("/some/explicit/dir");
	});

	it("falls back to process.cwd() when opts.cwd is not a string", async () => {
		verifyAuditChainStreaming.mockResolvedValue(baseResult());
		// opts.cwd is a number — not a string — so the ternary takes the else.
		await auditVerifyCommand({ cwd: 123 });
		expect(verifyAuditChainStreaming).toHaveBeenCalledWith(process.cwd());
	});

	it("falls back to process.cwd() when opts.cwd is absent", async () => {
		verifyAuditChainStreaming.mockResolvedValue(baseResult());
		await auditVerifyCommand({});
		expect(verifyAuditChainStreaming).toHaveBeenCalledWith(process.cwd());
	});
});

// ===========================================
// JSON output mode (isJson === true)
// ===========================================

describe("auditVerifyCommand — JSON output", () => {
	it("emits a single pretty-printed JSON object mirroring the result fields", async () => {
		const result = baseResult({
			valid: true,
			total_events: 250,
			guard_events: 50,
			chained_events: 45,
			unchained_guard_events: 5,
			last_hash: "f".repeat(64),
		});
		verifyAuditChainStreaming.mockResolvedValue(result);

		await auditVerifyCommand({ json: true });

		// Exactly one console.log call in JSON mode.
		expect(logged).toHaveLength(1);
		const parsed = parseWire(JSON.parse(nonNull(logged[0])), wireRecord(wireUnknown), "test JSON value");
		expect(parsed).toEqual({
			valid: true,
			total_events: 250,
			guard_events: 50,
			chained_events: 45,
			unchained_guard_events: 5,
			first_bad_index: undefined,
			first_bad_line_number: undefined,
			first_bad_reason: undefined,
			last_hash: "f".repeat(64),
			coverage_pct: 90, // round(45/50*100)
		});
		// Pretty-printed (2-space indent) — newline + indentation present.
		expect(logged[0]).toContain("\n  ");
	});

	it("rounds coverage_pct from the chained/guard ratio", async () => {
		// 1/3 -> 33.33 -> rounds to 33.
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({ guard_events: 3, chained_events: 1 }),
		);
		await auditVerifyCommand({ json: true });
		const parsed = parseWire(JSON.parse(nonNull(logged[0])), wireObject({ "coverage_pct": wireNumber }), "test JSON value");
		expect(parsed.coverage_pct).toBe(33);
	});

	it("sets coverage_pct to null when there are zero guard events", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({ guard_events: 0, chained_events: 0, last_hash: undefined }),
		);
		await auditVerifyCommand({ json: true });
		const parsed = parseWire(JSON.parse(nonNull(logged[0])), wireObject({ "coverage_pct": wireNullable(wireNumber) }), "test JSON value");
		expect(parsed.coverage_pct).toBeNull();
	});

	it("does not touch process.exitCode when the chain is valid", async () => {
		verifyAuditChainStreaming.mockResolvedValue(baseResult());
		await auditVerifyCommand({ json: true });
		expect(process.exitCode).toBeUndefined();
	});

	it("sets process.exitCode to 1 when the chain is invalid (JSON mode still exits non-zero)", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({ valid: false, first_bad_reason: "hash mismatch" }),
		);
		await auditVerifyCommand({ json: true });
		expect(process.exitCode).toBe(1);
		// Even in failure, JSON mode emits exactly the one JSON object.
		expect(logged).toHaveLength(1);
		expect(() => JSON.parse(nonNull(logged[0]))).not.toThrow();
	});
});

// ===========================================
// Human-readable output — VALID path
// ===========================================

describe("auditVerifyCommand — human output, valid chain", () => {
	it("prints VALID status with localized counts and a truncated last hash", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({
				valid: true,
				total_events: 1234,
				guard_events: 200,
				chained_events: 200,
				unchained_guard_events: 0,
				last_hash: "0123456789abcdef0123456789abcdef".padEnd(64, "0"),
			}),
		);

		await auditVerifyCommand({});

		const text = out();
		expect(text).toContain("Audit Chain Verification");
		expect(text).toContain("Status:                VALID");
		expect(text).not.toContain("TAMPERED");
		// toLocaleString() inserts grouping separators.
		expect(text).toContain("1,234");
		expect(text).toContain("200  (100% hash-chained)");
		// Last hash truncated to first 16 chars + ellipsis.
		expect(text).toContain("Last hash:             0123456789abcdef…");
		// Valid + chained_events > 0 -> the "chain intact" footer.
		expect(text).toContain("chain intact, no rewrites detected.");
		expect(process.exitCode).toBeUndefined();
	});

	it("omits the Last hash line when last_hash is absent", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({ last_hash: undefined, guard_events: 10, chained_events: 10 }),
		);
		await auditVerifyCommand({});
		expect(out()).not.toContain("Last hash:");
	});

	it("shows the legacy/unchained line only when unchained_guard_events > 0", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({
				guard_events: 30,
				chained_events: 20,
				unchained_guard_events: 10,
			}),
		);
		await auditVerifyCommand({});
		const text = out();
		expect(text).toContain("Legacy / unchained:");
		expect(text).toContain("10  (written before the chain shipped)");
	});

	it("hides the legacy/unchained line when there are none", async () => {
		verifyAuditChainStreaming.mockResolvedValue(baseResult({ unchained_guard_events: 0 }));
		await auditVerifyCommand({});
		expect(out()).not.toContain("Legacy / unchained:");
	});
});

// ===========================================
// Human-readable output — zero-guard-events path
// ===========================================

describe("auditVerifyCommand — human output, empty chain", () => {
	it("renders 0% coverage and the 'no guard decision events yet' footer", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({
				valid: true,
				total_events: 12,
				guard_events: 0,
				chained_events: 0,
				unchained_guard_events: 0,
				last_hash: undefined,
			}),
		);

		await auditVerifyCommand({});

		const text = out();
		// coverage_pct is null here, so the `?? 0` fallback renders 0%.
		expect(text).toContain("0  (0% hash-chained)");
		expect(text).toContain("No guard decision events yet");
		// Not the "chain intact" footer (chained_events is 0).
		expect(text).not.toContain("chain intact");
		expect(process.exitCode).toBeUndefined();
	});
});

// ===========================================
// Human-readable output — TAMPERED path
// ===========================================

describe("auditVerifyCommand — human output, tampered chain", () => {
	it("prints the full tamper block with index, line number, and reason", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({
				valid: false,
				total_events: 80,
				guard_events: 40,
				chained_events: 17,
				unchained_guard_events: 0,
				first_bad_index: 17,
				first_bad_line_number: 42,
				first_bad_reason: "hash mismatch at chained event #17",
				last_hash: "b".repeat(64),
			}),
		);

		await auditVerifyCommand({});

		const text = out();
		expect(text).toContain("Status:                INVALID");
		expect(text).toContain("Integrity or continuity failure:");
		expect(text).toContain("Chained event #17");
		expect(text).toContain("activity.jsonl line 42");
		expect(text).toContain("Reason: hash mismatch at chained event #17");
		expect(text).toContain("interlinked data audit diagnose");
		expect(text).toContain("preserves the historical failure");
		// Tamper path is mutually exclusive with the valid footers.
		expect(text).not.toContain("chain intact");
		expect(process.exitCode).toBe(1);
	});

	it("omits the activity.jsonl line when first_bad_line_number is absent", async () => {
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({
				valid: false,
				first_bad_index: 3,
				first_bad_reason: "previousHash mismatch",
			}),
		);

		await auditVerifyCommand({});

		const text = out();
		expect(text).toContain("Chained event #3");
		expect(text).toContain("Reason: previousHash mismatch");
		expect(text).not.toContain("activity.jsonl line");
		expect(process.exitCode).toBe(1);
	});

	it("falls through to no special footer when invalid but first_bad_reason is missing", async () => {
		// !valid but no reason: the first `if` is false; valid is false so the
		// `else if (valid && ...)` is false; guard_events>0 so the final
		// `else if (guard_events === 0)` is false. No footer block is printed,
		// but exitCode is still 1.
		verifyAuditChainStreaming.mockResolvedValue(
			baseResult({
				valid: false,
				guard_events: 40,
				chained_events: 40,
			}),
		);

		await auditVerifyCommand({});

		const text = out();
		expect(text).toContain("INVALID");
		expect(text).not.toContain("Integrity or continuity failure:");
		expect(text).not.toContain("chain intact");
		expect(text).not.toContain("No guard decision events yet");
		expect(process.exitCode).toBe(1);
	});
});
