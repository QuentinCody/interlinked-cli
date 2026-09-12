// Tests for the independent adversarial-pass record.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AdversarialRecord,
	adversarialGap,
	CHECK_ADVERSARIAL_PATH,
	describeAdversarialGap,
	detectorHash,
	EMPTY_ADVERSARIAL,
	loadAdversarialStore,
	parseAdversarialStore,
} from "./adversarial.js";

const SOURCE = "export function detectThing(c: string) { return []; }";

function record(over: Partial<AdversarialRecord> = {}): AdversarialRecord {
	return {
		reviewer: "reviewer-b",
		author: "author-a",
		detector_sha256: detectorHash(SOURCE),
		findings: [],
		...over,
	};
}

describe("detectorHash", () => {
	it("is stable for identical source", () => {
		expect(detectorHash(SOURCE)).toBe(detectorHash(SOURCE));
	});

	it("changes when the source changes at all", () => {
		expect(detectorHash(SOURCE)).not.toBe(detectorHash(`${SOURCE} `));
	});
});

describe("adversarialGap — negative (obligation IS met, no gap)", () => {
	it("N1: a fresh independent review over the current source passes", () => {
		expect(adversarialGap(record(), SOURCE)).toBeNull();
	});

	it("N2: a review with no recorded author still passes", () => {
		// Author is optional; its absence cannot be used to infer a self-review.
		const r = record();
		delete r.author;
		expect(adversarialGap(r, SOURCE)).toBeNull();
	});

	it("N3: findings do not have to be non-empty", () => {
		expect(adversarialGap(record({ findings: [] }), SOURCE)).toBeNull();
	});
});

describe("adversarialGap — positive (must report a gap)", () => {
	it("P1: no record at all", () => {
		expect(adversarialGap(undefined, SOURCE)).toBe("missing");
	});

	it("P2: source changed since the review", () => {
		expect(adversarialGap(record(), `${SOURCE}\n// edited`)).toBe("stale_source");
	});

	it("P3: reviewer is the author", () => {
		expect(adversarialGap(record({ reviewer: "author-a" }), SOURCE)).toBe("self_review");
	});

	it("P4: reviewer is the author modulo whitespace", () => {
		expect(adversarialGap(record({ reviewer: " author-a " }), SOURCE)).toBe("self_review");
	});

	it("P5: blank reviewer", () => {
		expect(adversarialGap(record({ reviewer: "   " }), SOURCE)).toBe("no_reviewer");
	});

	it("P6: unreadable current source cannot confirm freshness", () => {
		expect(adversarialGap(record(), undefined)).toBe("stale_source");
	});
});

describe("describeAdversarialGap", () => {
	it("explains every gap kind", () => {
		for (const gap of ["missing", "stale_source", "self_review", "no_reviewer"] as const) {
			expect(describeAdversarialGap(gap).length).toBeGreaterThan(10);
		}
	});

	it("names independence in the missing-record message", () => {
		expect(describeAdversarialGap("missing")).toMatch(/only adversary/);
	});
});

describe("loadAdversarialStore", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cec-adv-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns an empty store when none is committed", () => {
		expect(loadAdversarialStore(root)).toEqual(EMPTY_ADVERSARIAL);
	});

	it("loads a committed store", () => {
		writeFileSync(
			join(root, CHECK_ADVERSARIAL_PATH),
			JSON.stringify({ checks: { c: { reviewer: "r", detector_sha256: "abc", findings: [] } } }),
			"utf8",
		);
		expect(loadAdversarialStore(root).checks.c?.reviewer).toBe("r");
	});

	it("fails closed on a malformed store", () => {
		writeFileSync(join(root, CHECK_ADVERSARIAL_PATH), "{ broken", "utf8");
		expect(loadAdversarialStore(root)).toEqual(EMPTY_ADVERSARIAL);
	});
});

describe("parseAdversarialStore", () => {
	it("discards non-object check records while preserving valid reviewer evidence", () => {
		const store = parseAdversarialStore({ checks: { bad: null, c: { reviewer: "r", detector_sha256: "abc", author: "a", findings: [] } } });
		expect(store.checks).toEqual({ c: { reviewer: "r", detector_sha256: "abc", author: "a", findings: [] } });
	});

	it("reads a well-formed store", () => {
		const store = parseAdversarialStore({
			version: 1,
			checks: { c: { reviewer: "r", detector_sha256: "abc", findings: ["fp1"], note: "n" } },
		});
		expect(store.checks.c?.findings).toEqual(["fp1"]);
		expect(store.checks.c?.note).toBe("n");
	});

	it("drops a record missing its source hash", () => {
		expect(parseAdversarialStore({ checks: { c: { reviewer: "r" } } }).checks).toEqual({});
	});

	it("drops a record missing its reviewer", () => {
		expect(parseAdversarialStore({ checks: { c: { detector_sha256: "abc" } } }).checks).toEqual({});
	});

	it.each([undefined, null, "invalid", ["ok", 5]])("does not certify an incomplete adversarial review: %j", (findings) => {
		const store = parseAdversarialStore({
			checks: { c: { reviewer: "r", detector_sha256: detectorHash(SOURCE), findings } },
		});
		expect(adversarialGap(store.checks.c, SOURCE)).toBe("missing");
		expect(store.checks.c).toBeUndefined();
	});

	it("fails closed on non-object input", () => {
		expect(parseAdversarialStore(null)).toEqual(EMPTY_ADVERSARIAL);
		expect(parseAdversarialStore({ version: 1 })).toEqual(EMPTY_ADVERSARIAL);
	});
});
