import { parseWire, wireObject, wireString } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
// Mutation-kill suite for wave pass1_w46 survivors in scanner-render.ts.
// The formatter module is mocked with identity `c.*` + real header/kvLine
// bodies so assertions match raw substrings regardless of TTY/NO_COLOR/CI
// color gating (mirrors src/commands/audit.test.ts convention).

import { describe, expect, it, vi } from "vitest";
import type {
	PendingReviewSummary,
	ReviewDecision,
	ReviewPayload,
} from "../harness/content-scanner/review-files.js";
import type { AuditEntry, ScannerOptions } from "./scanner.js";

vi.mock("../lib/formatter.js", () => {
	const identity = (s: string) => s;
	const c = {
		bold: identity,
		dim: identity,
		italic: identity,
		red: identity,
		green: identity,
		yellow: identity,
		blue: identity,
		magenta: identity,
		cyan: identity,
		gray: identity,
		white: identity,
	};
	return {
		c,
		header: (title: string) => `\n${title}\n${"-".repeat(title.length)}`,
		kvLine: (key: string, value: string, keyWidth = 14) => `  ${key.padEnd(keyWidth)} ${value}`,
	};
});

const {
	renderToggleResult,
	renderStatus,
	pickReview,
	pickFlagDecision,
	renderReview,
	REVIEW_DECISION_TO_ACTION,
	isPickError,
} = await import("./scanner-render.js");

function opts(reason?: string): ScannerOptions {
	return reason === undefined ? {} : { reason };
}

function finding(label: string, start: number, end: number, text: string) {
	return { label, start, end, text, source: "body" };
}

describe("renderToggleResult — positive (must fire)", () => {
	it("unchanged=false (current !== target) shows wrote/audit/harness lines", () => {
		const out = renderToggleResult({
			cwd: "/x",
			current: true,
			target: false,
			opts: opts(),
			localRulesPath: "RULES_PATH_Y",
			auditPath: "AUDIT_PATH_X",
		});
		expect(out).toContain("wrote: RULES_PATH_Y");
		expect(out).toContain("audit: AUDIT_PATH_X");
		expect(out).toContain(
			"the harness will pick this up on its next config watch event (usually <1s).",
		);
		expect(out).not.toContain("already off");
	});

	it("unchanged=true (current === target) omits wrote/audit/harness lines", () => {
		const out = renderToggleResult({
			cwd: "/x",
			current: true,
			target: true,
			opts: opts(),
			localRulesPath: "RULES_PATH_Y",
			auditPath: "AUDIT_PATH_X",
		});
		expect(out).not.toContain("wrote:");
		expect(out).not.toContain("audit:");
		expect(out).not.toContain("the harness will pick this up");
		expect(out).toContain("already on");
	});

	it("current === ctx.target is computed correctly, not forced — false case shows exact DISABLED line", () => {
		const out = renderToggleResult({
			cwd: "/x",
			current: true,
			target: false,
			opts: opts(),
			localRulesPath: "R",
			auditPath: "A",
		});
		const firstLine = out.split("\n")[0];
		expect(firstLine).toBe("PII filter: DISABLED");
	});

	it("ctx.target selects ENABLED vs DISABLED branch (not forced true)", () => {
		const disabled = renderToggleResult({
			cwd: "/x",
			current: false,
			target: false,
			opts: opts(),
			localRulesPath: "R",
			auditPath: "A",
		});
		expect(disabled.split("\n")[0]).toBe("PII filter: DISABLED (already off)");
	});

	it("opts.reason present appends a reason line", () => {
		const out = renderToggleResult({
			cwd: "/x",
			current: true,
			target: true,
			opts: opts("because"),
			localRulesPath: "R",
			auditPath: "A",
		});
		expect(out).toContain("reason: because");
	});

	it("lines are newline-joined, not concatenated", () => {
		const out = renderToggleResult({
			cwd: "/x",
			current: true,
			target: false,
			opts: opts("why"),
			localRulesPath: "R",
			auditPath: "A",
		});
		const lines = out.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(4);
		expect(lines).toContain("  reason: why");
	});
});

describe("renderStatus — positive (must fire)", () => {
	const base = {
		enabled: true,
		runtime_status: null,
		last_audit: [],
		local_rules_path: "/local/rules.json",
		audit_path: "/audit.jsonl",
	};

	it("includes all static header/key labels", () => {
		const out = renderStatus(base);
		expect(out).toContain("PII Filter");
		expect(out).toContain("Enabled");
		expect(out).toContain("yes");
		expect(out).toContain("Config");
		expect(out).toContain("Audit");
		expect(out).toContain("Runtime");
		expect(out).toContain("(harness not writing status)");
	});

	it("empty last_audit omits Recent Activity section", () => {
		const out = renderStatus(base);
		expect(out).not.toContain("Recent Activity");
	});

	it("non-empty last_audit renders Recent Activity with newline-separated entries", () => {
		const entry: AuditEntry = {
			ts: "2026-08-22T00:00:00Z",
			action: "no_change",
			actor: { user: "bob", host: "h", tty: null, via: "cli" },
			reason: null,
		};
		const out = renderStatus({ ...base, last_audit: [entry] });
		expect(out).toContain("Recent Activity");
		expect(out).toContain("no-change");
		expect(out).toContain("bob");
		const lines = out.split("\n");
		expect(lines.length).toBeGreaterThan(6);
	});
});

describe("pickReview — positive (must fire)", () => {
	function review(key: string): PendingReviewSummary {
		return {
			key,
			path: `/p/${key}`,
			timestamp: "t",
			url: "https://example.com",
			tool_name: "WebFetch",
			finding_count: 1,
		};
	}

	it("empty reviews with a key returns null, not an error", () => {
		expect(pickReview([], "somekey")).toBeNull();
	});

	it("no key returns the first review, not treating undefined key as a match key", () => {
		const a = review("a");
		const b = review("b");
		const result = pickReview([a, b], undefined);
		expect(result).toBe(a);
		expect(isPickError(result)).toBe(false);
	});

	it("matching key returns the matching review, not an error", () => {
		const a = review("a");
		const b = review("b");
		const result = pickReview([a, b], "b");
		expect(result).toBe(b);
		expect(isPickError(result)).toBe(false);
	});

	it("non-matching key returns a PickError", () => {
		const a = review("a");
		const result = pickReview([a], "zzz");
		expect(isPickError(result)).toBe(true);
	});
});

describe("pickFlagDecision — positive (must fire)", () => {
	it("no flags returns undefined", () => {
		const result = pickFlagDecision({});
		expect(result).toBeUndefined();
	});

	it("single flag returns that decision", () => {
		expect(pickFlagDecision({ allow: true })).toBe("allow");
		expect(pickFlagDecision({ redact: true })).toBe("redact");
		expect(pickFlagDecision({ block: true })).toBe("block");
	});

	it("two conflicting flags returns an error mentioning both", () => {
		const result = pickFlagDecision({ allow: true, block: true });
		expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("allow") }));
		expect((parseWire(result, wireObject({ "error": wireString }), "test JSON value")).error).toContain("block");
		expect((parseWire(result, wireObject({ "error": wireString }), "test JSON value")).error).toContain("conflicting flags");
	});
});

describe("renderReview — positive (must fire)", () => {
	function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
		return {
			timestamp: "t",
			url: "https://example.com/x",
			prompt: "",
			tool_name: "WebFetch",
			body: "hello world",
			redacted_body: "hello world",
			findings: [],
			cache_key: "k",
			...overrides,
		};
	}

	it("includes static headers/labels and the disclaimer", () => {
		const out = renderReview(payload());
		expect(out).toContain("Privacy Filter — Review");
		expect(out).toContain("URL");
		expect(out).toContain("https://example.com/x");
		expect(out).toContain("Categories");
		expect(out).toContain("Body (PII highlighted)");
		expect(out).toContain("This body is rendered locally and was NOT sent to the model.");
	});

	it("empty prompt omits the Prompt line", () => {
		const out = renderReview(payload({ prompt: "" }));
		expect(out).not.toContain("Prompt");
	});

	it("non-empty prompt includes the Prompt line and its value", () => {
		const out = renderReview(payload({ prompt: "what is this" }));
		expect(out).toContain("Prompt");
		expect(out).toContain("what is this");
	});

	it("lines are newline-joined", () => {
		const out = renderReview(payload());
		expect(out.split("\n").length).toBeGreaterThan(5);
	});

	it("formatCategories: counts identical labels correctly (not decremented)", () => {
		const out = renderReview(
			payload({
				findings: [finding("EMAIL", 0, 1, "x"), finding("EMAIL", 2, 3, "y")],
			}),
		);
		expect(out).toContain("EMAIL(2)");
	});

	it("formatCategories: sorts labels alphabetically regardless of insertion order", () => {
		const out = renderReview(
			payload({
				findings: [finding("ZEBRA", 0, 1, "x"), finding("ALPHA", 2, 3, "y")],
			}),
		);
		const catLine = out.split("\n").find((l) => l.includes("("));
		expect(catLine).toBeDefined();
		const idxA = (nonNull(catLine)).indexOf("ALPHA");
		const idxZ = (nonNull(catLine)).indexOf("ZEBRA");
		expect(idxA).toBeGreaterThanOrEqual(0);
		expect(idxZ).toBeGreaterThan(idxA);
	});

	it("formatCategories: non-empty findings produce a non-empty categories string", () => {
		const out = renderReview(payload({ findings: [finding("PHONE", 0, 1, "x")] }));
		expect(out).toContain("PHONE(1)");
	});

	it("formatCategories: entries joined with ', ' separator", () => {
		const out = renderReview(
			payload({
				findings: [finding("AAA", 0, 1, "x"), finding("BBB", 2, 3, "y")],
			}),
		);
		expect(out).toContain("AAA(1), BBB(1)");
	});

	it("highlightFindings: processes findings in descending start order so earlier spans keep valid indices", () => {
		// Findings supplied in ASCENDING start order (opposite of the required
		// sort key) — if the descending .sort() is removed/neutered, splicing
		// the earlier span (start=2) after the later one (start=6) shifts
		// indices and corrupts the earlier tag/text.
		const out = renderReview(
			payload({
				body: "0123456789",
				findings: [finding("A", 2, 4, "23"), finding("B", 6, 8, "67")],
			}),
		);
		expect(out).toContain("23");
		expect(out).toContain("<A>");
		expect(out).toContain("67");
		expect(out).toContain("<B>");
		// The untouched prefix/suffix chars must be intact and in order.
		expect(out).toContain("01");
		expect(out).toContain("45");
		expect(out).toContain("89");
	});
});

describe("REVIEW_DECISION_TO_ACTION — positive (must fire)", () => {
	it("maps every decision to its review_* action", () => {
		expect(REVIEW_DECISION_TO_ACTION.allow).toBe("review_allow");
		expect(REVIEW_DECISION_TO_ACTION.redact).toBe("review_redact");
		expect(REVIEW_DECISION_TO_ACTION.block).toBe("review_block");
		expect(REVIEW_DECISION_TO_ACTION.skip).toBe("review_skip");
	});
});

// Reference decision type usage so the import isn't flagged unused by lint
// while keeping the type import for signature accuracy above.
const _typeCheck: ReviewDecision = "allow";
void _typeCheck;
