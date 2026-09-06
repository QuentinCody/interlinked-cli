import { describe, expect, it } from "vitest";
import {
	activeCreatives,
	feedIsLive,
	MAX_CREATIVES,
	MAX_TEXT_LEN,
	parseFeedPayload,
	sanitizeCreative,
	stripControlChars,
} from "./types.js";

const GOOD = {
	id: "friend-001",
	campaign: "friends-2026",
	text: "Sceneglass — local-first video notes",
	url: "https://example.com/sceneglass",
	weight: 2,
};

function feedJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		generated_at: "2026-06-12T00:00:00Z",
		valid_until: "2026-06-19T00:00:00Z",
		creatives: [GOOD],
		...overrides,
	});
}

describe("stripControlChars", () => {
	it("strips C0/C1/DEL bytes including ANSI and OSC introducers", () => {
		// ESC [31m ... BEL — the classic ANSI color + OSC terminator pair.
		expect(stripControlChars("a\u001b[31mred\u0007b")).toBe("a[31mredb");
		// C1 range (0x80-0x9f) and DEL (0x7f).
		expect(stripControlChars("x\u009d\u007fy")).toBe("xy");
	});

	it("preserves emoji, pipes, unicode, and URLs", () => {
		const s = "♥ café | https://a.b/c?d=1 — ok";
		expect(stripControlChars(s)).toBe(s);
	});
});

describe("sanitizeCreative", () => {
	it("accepts a valid creative verbatim", () => {
		expect(sanitizeCreative(GOOD)).toEqual(GOOD);
	});

	it("rejects bad ids, non-https urls, and missing text", () => {
		expect(sanitizeCreative({ ...GOOD, id: "Bad_ID!" })).toBeNull();
		expect(sanitizeCreative({ ...GOOD, url: "http://example.com" })).toBeNull();
		expect(sanitizeCreative({ ...GOOD, url: "javascript:alert(1)" })).toBeNull();
		expect(sanitizeCreative({ ...GOOD, text: 42 })).toBeNull();
		expect(sanitizeCreative(null)).toBeNull();
	});

	it("rejects a url that `new URL()` itself cannot parse, not just a non-https one", () => {
		// "not a url" has no scheme at all, so `new URL()` throws rather than
		// returning a parsed object with a non-https protocol — a different
		// code path than the `http://` / `javascript:` cases above. If the
		// catch swallowed the throw and returned true instead of false, this
		// would come back as a full creative object instead of null.
		expect(sanitizeCreative({ ...GOOD, url: "not a url" })).toBeNull();
	});

	it("strips control bytes from text and rejects text that is empty after stripping", () => {
		// An embedded OSC 8 hyperlink attempt must come out inert.
		const c = sanitizeCreative({ ...GOOD, text: "hi\u001b]8;;evil\u0007there" });
		expect(c?.text).toBe("hi]8;;evilthere");
		expect(sanitizeCreative({ ...GOOD, text: "\u0007\u001b" })).toBeNull();
	});

	it("caps text length and clamps weight into 1..100 with default 1", () => {
		const long = sanitizeCreative({ ...GOOD, text: "x".repeat(500) });
		expect(long?.text).toHaveLength(MAX_TEXT_LEN);
		expect(sanitizeCreative({ ...GOOD, weight: 9999 })?.weight).toBe(100);
		expect(sanitizeCreative({ ...GOOD, weight: -3 })?.weight).toBe(1);
		const noWeight = { ...GOOD } as Record<string, unknown>;
		delete noWeight.weight;
		expect(sanitizeCreative(noWeight)?.weight).toBe(1);
	});

	it("defaults campaign and keeps only ISO flight bounds", () => {
		const noCampaign = { ...GOOD } as Record<string, unknown>;
		delete noCampaign.campaign;
		expect(sanitizeCreative(noCampaign)?.campaign).toBe("default");
		const flighted = sanitizeCreative({
			...GOOD,
			starts_at: "2026-06-12T00:00:00Z",
			ends_at: "not a date",
		});
		expect(flighted?.starts_at).toBe("2026-06-12T00:00:00Z");
		expect(flighted?.ends_at).toBeUndefined();
	});
});

describe("parseFeedPayload", () => {
	it("parses a valid feed", () => {
		const feed = parseFeedPayload(feedJson());
		expect(feed?.creatives).toHaveLength(1);
		expect(feed?.valid_until).toBe("2026-06-19T00:00:00Z");
	});

	it("rejects wrong version, malformed JSON, and over-cap creative lists", () => {
		expect(parseFeedPayload(feedJson({ version: 2 }))).toBeNull();
		expect(parseFeedPayload("{nope")).toBeNull();
		const many = Array.from({ length: MAX_CREATIVES + 1 }, (_, i) => ({
			...GOOD,
			id: `c-${i}`,
		}));
		expect(parseFeedPayload(feedJson({ creatives: many }))).toBeNull();
	});

	it("skips invalid creatives without rejecting the feed", () => {
		const feed = parseFeedPayload(
			feedJson({ creatives: [GOOD, { ...GOOD, id: "BAD ID" }] }),
		);
		expect(feed?.creatives.map((c) => c.id)).toEqual(["friend-001"]);
	});
});

describe("feedIsLive / activeCreatives", () => {
	const now = Date.parse("2026-06-15T00:00:00Z");

	it("is live strictly before valid_until", () => {
		const feed = parseFeedPayload(feedJson());
		if (!feed) throw new Error("feed should parse");
		expect(feedIsLive(feed, now)).toBe(true);
		expect(feedIsLive(feed, Date.parse("2026-07-01T00:00:00Z"))).toBe(false);
	});

	it("filters creatives by flight window", () => {
		const feed = parseFeedPayload(
			feedJson({
				creatives: [
					{ ...GOOD, id: "live-now" },
					{ ...GOOD, id: "not-yet", starts_at: "2026-06-16T00:00:00Z" },
					{ ...GOOD, id: "ended", ends_at: "2026-06-14T00:00:00Z" },
				],
			}),
		);
		if (!feed) throw new Error("feed should parse");
		expect(activeCreatives(feed, now).map((c) => c.id)).toEqual(["live-now"]);
	});

	it("fail-closes on a malformed flight-window bound (would-be NaN comparison)", () => {
		// activeCreatives is exported + defense-in-depth: a garbage starts_at/ends_at
		// (Date.parse → NaN) must NOT render the creative on a broken schedule — a raw
		// `nowMs < NaN` is always false (fail open). The harness's own
		// nan_coercion_guard check flagged the pre-fix code here (finding 2026-06).
		const feed = parseFeedPayload(feedJson());
		if (!feed) throw new Error("feed should parse");
		const injected = {
			...feed,
			creatives: [
				{ ...GOOD, id: "bad-start", starts_at: "garbage" },
				{ ...GOOD, id: "bad-end", ends_at: "not-a-date" },
				{ ...GOOD, id: "ok" },
			],
		};
		expect(activeCreatives(injected, now).map((c) => c.id)).toEqual(["ok"]);
	});
});
