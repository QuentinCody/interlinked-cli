// Tests for the review/decision file lifecycle that backs the WebFetch
// 3-way human-in-the-loop interception. The contract that matters most:
//   - Same (url, prompt) always produces the same cache key (proxy can find
//     the user's prior decision after a re-invoke).
//   - listPendingReviews surfaces only reviews without a sibling decision.
//   - consumeDecision removes BOTH files so the next call doesn't silently
//     re-apply the old verdict.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheKey,
	consumeDecision,
	countPendingReviews,
	listPendingReviews,
	parseDecisionPayload,
	parseReviewPayload,
	readDecision,
	readReview,
	writeDecision,
	writeReview,
} from "../review-files.js";
import type { ScanFinding } from "../types.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "review-files-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function fakeFinding(label: string, text: string): ScanFinding {
	return { label, start: 0, end: text.length, text, source: "WebFetch.response" };
}

describe("cacheKey", () => {
	it("returns 16 hex chars", () => {
		const k = cacheKey("https://example.com", "summarise");
		expect(k).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is stable for the same (url, prompt)", () => {
		const a = cacheKey("https://example.com", "p");
		const b = cacheKey("https://example.com", "p");
		expect(a).toBe(b);
	});

	it("changes when prompt changes", () => {
		expect(cacheKey("https://example.com", "a")).not.toBe(
			cacheKey("https://example.com", "b"),
		);
	});

	it("treats undefined prompt as empty string", () => {
		const a = cacheKey("https://example.com", undefined);
		const b = cacheKey("https://example.com", "");
		expect(a).toBe(b);
	});
});

describe("writeReview / readReview", () => {
	it("round-trips a payload", () => {
		const key = cacheKey("https://example.com/foo", "p");
		const findings = [fakeFinding("private_email", "alice@example.com")];
		writeReview({
			cwd,
			key,
			url: "https://example.com/foo",
			prompt: "p",
			toolName: "WebFetch",
			body: "Contact: alice@example.com",
			redactedBody: "Contact: <PRIVATE_EMAIL>",
			findings,
		});
		const got = readReview(cwd, key);
		expect(got?.url).toBe("https://example.com/foo");
		expect(got?.body).toBe("Contact: alice@example.com");
		expect(got?.redacted_body).toBe("Contact: <PRIVATE_EMAIL>");
		expect(got?.findings).toHaveLength(1);
		expect(got?.findings[0]?.label).toBe("private_email");
	});

	it("returns undefined when the review does not exist", () => {
		expect(readReview(cwd, "nope_no_such_key_")).toBeUndefined();
	});

	it("creates the pending dir on first write", () => {
		expect(existsSync(join(cwd, ".interlinked/scanner/pending"))).toBe(false);
		writeReview({
			cwd,
			key: "k1",
			url: "u",
			prompt: "p",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		expect(existsSync(join(cwd, ".interlinked/scanner/pending"))).toBe(true);
	});
});

describe("writeDecision / readDecision", () => {
	const actor = { user: "u", host: "h", tty: null };

	it.each(["allow", "redact", "block"] as const)("round-trips %s", (decision) => {
		writeDecision({ cwd, key: "k", decision, actor });
		const got = readDecision(cwd, "k");
		expect(got?.decision).toBe(decision);
		expect(got?.actor.user).toBe("u");
	});

	it("returns undefined when no decision recorded yet (steady state, not an error)", () => {
		expect(readDecision(cwd, "no_such_key")).toBeUndefined();
	});

	it("survives a corrupt decision file by returning undefined", () => {
		mkdirSync(join(cwd, ".interlinked/scanner/pending"), { recursive: true });
		writeFileSync(
			join(cwd, ".interlinked/scanner/pending/k.decision.json"),
			"this is not json",
		);
		expect(readDecision(cwd, "k")).toBeUndefined();
	});
});

describe("listPendingReviews / countPendingReviews", () => {
	const actor = { user: "u", host: "h", tty: null };

	it("returns empty when the pending dir doesn't exist", () => {
		expect(listPendingReviews(cwd)).toEqual([]);
		expect(countPendingReviews(cwd)).toBe(0);
	});

	it("includes reviews without a decision sibling", () => {
		writeReview({
			cwd,
			key: "k1",
			url: "u1",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [fakeFinding("private_email", "a@b.c")],
		});
		const list = listPendingReviews(cwd);
		expect(list).toHaveLength(1);
		expect(list[0]?.url).toBe("u1");
		expect(list[0]?.finding_count).toBe(1);
		expect(countPendingReviews(cwd)).toBe(1);
	});

	it("excludes reviews that already have a decision sibling", () => {
		writeReview({
			cwd,
			key: "k1",
			url: "u1",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		writeDecision({ cwd, key: "k1", decision: "allow", actor });
		expect(listPendingReviews(cwd)).toEqual([]);
		expect(countPendingReviews(cwd)).toBe(0);
	});

	it("sorts newest-first", ({ onTestFinished }) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		onTestFinished(() => { vi.useRealTimers(); });
		vi.setSystemTime(Date.UTC(2025, 0, 1));
		writeReview({
			cwd,
			key: "k1",
			url: "older",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		vi.setSystemTime(Date.UTC(2025, 0, 2));
		writeReview({
			cwd,
			key: "k2",
			url: "newer",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		const list = listPendingReviews(cwd);
		expect(list.map((r: { url: string }) => r.url)).toEqual(["newer", "older"]);
	});
});

describe("parseReviewPayload — positive (must parse)", () => {
	// No return-type annotation: letting TS infer a concrete object type (not
	// `unknown`) is what makes the `{ ...validPayload(), ... }` spreads below
	// type-check. `parseReviewPayload` takes `unknown`, so the concrete type
	// is still accepted at every call site.
	function validPayload() {
		return {
			timestamp: "2026-01-01T00:00:00.000Z",
			url: "https://example.com",
			prompt: "p",
			tool_name: "WebFetch",
			body: "b",
			redacted_body: "b",
			findings: [fakeFinding("private_email", "a@b.c")],
			cache_key: "k1",
		};
	}

	it("P1: parses a well-formed payload with a finding", () => {
		const input = validPayload();
		expect(parseReviewPayload(input)).toEqual(input);
	});

	it("P2: parses an empty findings array", () => {
		const input = { ...validPayload(), findings: [] };
		expect(parseReviewPayload(input)).toEqual(input);
	});

	it("P3: keeps an absent optional finding score as undefined", () => {
		const input = validPayload();
		const parsed = parseReviewPayload(input);
		expect(parsed?.findings[0]?.score).toBeUndefined();
	});

	it("P4: keeps a present optional finding score", () => {
		const input = {
			...validPayload(),
			findings: [{ ...fakeFinding("x", "y"), score: 0.9 }],
		};
		expect(parseReviewPayload(input)?.findings[0]?.score).toBe(0.9);
	});
});

describe("parseReviewPayload — negative (must reject)", () => {
	it("N1: rejects non-object JSON", () => {
		expect(parseReviewPayload(["array"])).toBeNull();
		expect(parseReviewPayload("string")).toBeNull();
		expect(parseReviewPayload(null)).toBeNull();
	});

	it("N2: rejects a payload missing a required field", () => {
		const { url: _url, ...rest } = {
			timestamp: "2026-01-01T00:00:00.000Z",
			url: "u",
			prompt: "p",
			tool_name: "WebFetch",
			body: "b",
			redacted_body: "b",
			findings: [],
			cache_key: "k",
		};
		expect(parseReviewPayload(rest)).toBeNull();
	});

	it("N3: rejects when findings is not an array", () => {
		expect(
			parseReviewPayload({
				timestamp: "2026-01-01T00:00:00.000Z",
				url: "u",
				prompt: "p",
				tool_name: "WebFetch",
				body: "b",
				redacted_body: "b",
				findings: "not-an-array",
				cache_key: "k",
			}),
		).toBeNull();
	});

	it("N4: rejects the whole payload when one finding in the array is malformed", () => {
		expect(
			parseReviewPayload({
				timestamp: "2026-01-01T00:00:00.000Z",
				url: "u",
				prompt: "p",
				tool_name: "WebFetch",
				body: "b",
				redacted_body: "b",
				findings: [fakeFinding("ok", "text"), { label: "missing-fields" }],
				cache_key: "k",
			}),
		).toBeNull();
	});
});

describe("parseDecisionPayload — positive (must parse)", () => {
	it("P1: parses a well-formed decision", () => {
		const input = {
			decision: "redact",
			timestamp: "2026-01-01T00:00:00.000Z",
			cache_key: "k",
			actor: { user: "u", host: "h", tty: null },
		};
		expect(parseDecisionPayload(input)).toEqual(input);
	});

	it("P2: accepts a string tty", () => {
		const input = {
			decision: "allow",
			timestamp: "2026-01-01T00:00:00.000Z",
			cache_key: "k",
			actor: { user: "u", host: "h", tty: "/dev/ttys001" },
		};
		expect(parseDecisionPayload(input)?.actor.tty).toBe("/dev/ttys001");
	});
});

describe("parseDecisionPayload — negative (must reject)", () => {
	it("N1: rejects non-object JSON", () => {
		expect(parseDecisionPayload([1, 2, 3])).toBeNull();
	});

	it("N2: rejects a decision value outside allow|redact|block", () => {
		expect(
			parseDecisionPayload({
				decision: "maybe",
				timestamp: "2026-01-01T00:00:00.000Z",
				cache_key: "k",
				actor: { user: "u", host: "h", tty: null },
			}),
		).toBeNull();
	});

	it("N3: rejects a missing actor", () => {
		expect(
			parseDecisionPayload({
				decision: "allow",
				timestamp: "2026-01-01T00:00:00.000Z",
				cache_key: "k",
			}),
		).toBeNull();
	});

	it("N4: rejects an actor with a wrong-typed field", () => {
		expect(
			parseDecisionPayload({
				decision: "allow",
				timestamp: "2026-01-01T00:00:00.000Z",
				cache_key: "k",
				actor: { user: "u", host: 123, tty: null },
			}),
		).toBeNull();
	});
});

describe("consumeDecision", () => {
	const actor = { user: "u", host: "h", tty: null };

	it("removes both review and decision files", () => {
		writeReview({
			cwd,
			key: "k",
			url: "u",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		writeDecision({ cwd, key: "k", decision: "allow", actor });
		consumeDecision(cwd, "k");
		expect(existsSync(join(cwd, ".interlinked/scanner/pending/k.review.json"))).toBe(false);
		expect(existsSync(join(cwd, ".interlinked/scanner/pending/k.decision.json"))).toBe(false);
	});

	it("is idempotent — second call is a no-op", () => {
		consumeDecision(cwd, "no_such_key");
		expect(() => consumeDecision(cwd, "no_such_key")).not.toThrow();
	});
});
