// Companion tests for `scanner-review-steps.ts` — the two resolution steps
// extracted out of `scannerReviewCommand`'s body.
//
// Both steps report their own failure through `outputError` and return null,
// so every case asserts BOTH the return value and what reached stderr.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PendingReviewSummary,
	ReviewPayload,
} from "../harness/content-scanner/review-files.js";

const { mockReadReview, questionAnswers, rlClose } = vi.hoisted(() => {
	const answers: string[] = [];
	return {
		mockReadReview: vi.fn<(cwd: string, key: string) => ReviewPayload | undefined>(
			() => undefined,
		),
		questionAnswers: answers,
		rlClose: vi.fn<() => void>(),
	};
});

vi.mock("../harness/content-scanner/review-files.js", () => ({
	readReview: mockReadReview,
}));

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: vi.fn(async (): Promise<string> => questionAnswers.shift() ?? ""),
		close: rlClose,
	})),
}));

import { resolveReviewDecision, resolveTargetReview } from "./scanner-review-steps.js";

function summary(key: string): PendingReviewSummary {
	return {
		key,
		path: `/tmp/${key}.review.json`,
		timestamp: "2026-09-01T00:00:00.000Z",
		url: `https://example.test/${key}`,
		tool_name: "WebFetch",
		finding_count: 2,
	};
}

function payload(key: string): ReviewPayload {
	return {
		timestamp: "2026-09-01T00:00:00.000Z",
		url: `https://example.test/${key}`,
		prompt: "summarize",
		tool_name: "WebFetch",
		body: "body",
		redacted_body: "redacted",
		findings: [],
		cache_key: key,
	};
}

let errors: string[];
let logs: string[];
let originalIsTty: boolean | undefined;

beforeEach(() => {
	errors = [];
	logs = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	originalIsTty = process.stdin.isTTY;
	questionAnswers.length = 0;
	mockReadReview.mockReset();
	process.exitCode = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(process.stdin, "isTTY", {
		value: originalIsTty,
		configurable: true,
		writable: true,
	});
	process.exitCode = undefined;
});

function setTty(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", {
		value,
		configurable: true,
		writable: true,
	});
}

describe("resolveTargetReview", () => {
	it("returns the picked key and its payload", () => {
		mockReadReview.mockReturnValue(payload("k1"));
		const target = resolveTargetReview({
			cwd: "/repo",
			mode: "normal",
			reviews: [summary("k1")],
			key: undefined,
		});
		expect(target).toEqual({ key: "k1", review: payload("k1") });
		expect(mockReadReview).toHaveBeenCalledWith("/repo", "k1");
		expect(errors).toEqual([]);
	});

	it("reports no match when the pending list is empty", () => {
		const target = resolveTargetReview({
			cwd: "/repo",
			mode: "normal",
			reviews: [],
			key: undefined,
		});
		expect(target).toBeNull();
		expect(errors.join("\n")).toContain("no pending reviews matched");
		expect(process.exitCode).toBe(1);
		expect(mockReadReview).not.toHaveBeenCalled();
	});

	it("reports the pick error when --key matches nothing", () => {
		const target = resolveTargetReview({
			cwd: "/repo",
			mode: "normal",
			reviews: [summary("k1")],
			key: "nope",
		});
		expect(target).toBeNull();
		expect(errors.join("\n")).toContain('no pending review with key "nope"');
		expect(process.exitCode).toBe(1);
	});

	it("reports an unreadable review file", () => {
		mockReadReview.mockReturnValue(undefined);
		const target = resolveTargetReview({
			cwd: "/repo",
			mode: "normal",
			reviews: [summary("k1")],
			key: "k1",
		});
		expect(target).toBeNull();
		expect(errors.join("\n")).toContain("pending review for key k1 could not be read");
		expect(process.exitCode).toBe(1);
	});
});

describe("resolveReviewDecision", () => {
	const target = { key: "k1", review: payload("k1") };

	it("uses the decision supplied by a flag without prompting", async () => {
		setTty(true);
		const decision = await resolveReviewDecision("normal", "allow", target);
		expect(decision).toBe("allow");
		expect(logs).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("refuses to prompt in json mode", async () => {
		setTty(true);
		const decision = await resolveReviewDecision("json", undefined, target);
		expect(decision).toBeNull();
		expect(errors.join("\n")).toContain("requires an explicit --allow, --redact, or --block flag");
	});

	it("refuses to prompt when stdin is not a TTY", async () => {
		setTty(false);
		const decision = await resolveReviewDecision("normal", undefined, target);
		expect(decision).toBeNull();
		expect(errors.join("\n")).toContain("non-interactive scanner review");
	});

	it("renders the review and prompts when interactive", async () => {
		setTty(true);
		questionAnswers.push("b");
		const decision = await resolveReviewDecision("normal", undefined, target);
		expect(decision).toBe("block");
		expect(logs.join("\n")).toContain("https://example.test/k1");
		expect(rlClose).toHaveBeenCalled();
	});
});
