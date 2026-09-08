import { sign as edSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendBeacon,
	BEACON_FILE,
	beaconUrlFromFeedUrl,
	buildClickUrl,
	fetchFeedWire,
	flushBeacons,
	fnv1a32,
	loadCachedWire,
	SPONSOR_STATUS_FILE,
	saveCachedWire,
	selectCreative,
	verifyWire,
	windowNumber,
	writeSponsorStatus,
} from "./feed-client.js";
import { ROTATION_WINDOW_MS, type SponsorBeacon, type SponsorFeed } from "./types.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

interface TestKeys {
	privateKey: KeyObject;
	pubB64: string;
}

function makeKeys(): TestKeys {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		pubB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

function makePayload(overrides: Partial<SponsorFeed> = {}): SponsorFeed {
	return {
		version: 1,
		generated_at: "2026-06-12T00:00:00Z",
		valid_until: "2099-01-01T00:00:00Z",
		creatives: [
			{
				id: "alpha",
				campaign: "friends",
				text: "Alpha — a friend project",
				url: "https://alpha.example",
				weight: 1,
			},
		],
		...overrides,
	};
}

function makeWire(keys: TestKeys, payload: SponsorFeed, keyId = "test-key"): string {
	const bytes = Buffer.from(JSON.stringify(payload), "utf8");
	return JSON.stringify({
		key_id: keyId,
		payload_b64: bytes.toString("base64"),
		sig: edSign(null, bytes, keys.privateKey).toString("base64"),
	});
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sponsor-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("verifyWire", () => {
	it("accepts a correctly signed wire via explicit pubkey", () => {
		const keys = makeKeys();
		const feed = verifyWire(makeWire(keys, makePayload()), { pubkeyB64: keys.pubB64 });
		expect(feed?.creatives[0]?.id).toBe("alpha");
	});

	it("rejects tampered payloads, wrong keys, and unknown key ids", () => {
		const keys = makeKeys();
		const other = makeKeys();
		const wire = makeWire(keys, makePayload());
		const tampered = JSON.stringify({
			...JSON.parse(wire),
			payload_b64: Buffer.from(
				JSON.stringify(makePayload({ generated_at: "2026-06-13T00:00:00Z" })),
			).toString("base64"),
		});
		expect(verifyWire(tampered, { pubkeyB64: keys.pubB64 })).toBeNull();
		expect(verifyWire(wire, { pubkeyB64: other.pubB64 })).toBeNull();
		// Unknown key_id with no override and no env: not verifiable.
		expect(verifyWire(wire)).toBeNull();
	});

	it("rejects malformed wires and garbage base64 keys without throwing", () => {
		expect(verifyWire("not json")).toBeNull();
		expect(verifyWire(JSON.stringify({ key_id: 1, payload_b64: 2, sig: 3 }))).toBeNull();
		const keys = makeKeys();
		expect(verifyWire(makeWire(keys, makePayload()), { pubkeyB64: "!!notakey!!" })).toBeNull();
	});

	it("N2: rejects a wire that parses to valid JSON but is not a keyed object (array/string/number/null)", () => {
		expect(verifyWire("[1,2,3]")).toBeNull();
		expect(verifyWire('"just a string"')).toBeNull();
		expect(verifyWire("42")).toBeNull();
		expect(verifyWire("null")).toBeNull();
	});
});

describe("rotation", () => {
	it("is deterministic within a window and respects weights across windows", () => {
		const feed = makePayload({
			creatives: [
				{ id: "light", campaign: "c", text: "light", url: "https://l.example", weight: 1 },
				{ id: "heavy", campaign: "c", text: "heavy", url: "https://h.example", weight: 9 },
			],
		});
		const t0 = Date.parse("2026-06-12T00:00:00Z");
		expect(selectCreative(feed, t0)?.id).toBe(selectCreative(feed, t0 + 1000)?.id);
		let heavy = 0;
		for (let w = 0; w < 200; w++) {
			const c = selectCreative(feed, t0 + w * ROTATION_WINDOW_MS);
			if (c?.id === "heavy") heavy++;
		}
		expect(heavy).toBeGreaterThan(120);
		expect(heavy).toBeLessThan(200);
	});

	it("returns null for expired feeds and empty creative lists", () => {
		const now = Date.parse("2026-06-12T00:00:00Z");
		expect(selectCreative(makePayload({ valid_until: "2020-01-01T00:00:00Z" }), now)).toBeNull();
		expect(selectCreative(makePayload({ creatives: [] }), now)).toBeNull();
	});

	it("exposes stable hashing + window helpers", () => {
		expect(fnv1a32("abc")).toBe(fnv1a32("abc"));
		expect(fnv1a32("abc")).not.toBe(fnv1a32("abd"));
		expect(windowNumber(ROTATION_WINDOW_MS * 7 + 1)).toBe(7);
	});

	it("falls back to the last candidate when total weight is zero", () => {
		// All-zero weights make `total` 0, so `slot = fnv % 0` is NaN and the
		// subtraction loop's `slot < 0` check never trips — exercises the
		// `?? null` fallback tail of selectCreative.
		const feed = makePayload({
			creatives: [
				{ id: "a", campaign: "c", text: "a", url: "https://a.example", weight: 0 },
				{ id: "b", campaign: "c", text: "b", url: "https://b.example", weight: 0 },
			],
		});
		const now = Date.parse("2026-06-12T00:00:00Z");
		expect(selectCreative(feed, now)?.id).toBe("b");
	});
});

describe("click + beacon urls", () => {
	it("routes clicks through the worker origin by creative id", () => {
		expect(buildClickUrl("https://w.example/v1/feed", "alpha")).toBe(
			"https://w.example/v1/c/alpha",
		);
		expect(buildClickUrl("https://w.example/v1/feed", "alpha", "inst-1")).toBe(
			"https://w.example/v1/c/alpha?i=inst-1",
		);
		expect(buildClickUrl("not a url", "alpha")).toBeNull();
		expect(beaconUrlFromFeedUrl("https://w.example/v1/feed")).toBe(
			"https://w.example/v1/beacon",
		);
	});

	it("returns null for an unparseable feed url", () => {
		expect(beaconUrlFromFeedUrl("not a url")).toBeNull();
	});
});

describe("sponsor.status writer", () => {
	it("writes kv lines with defensively re-stripped text", () => {
		writeSponsorStatus(dir, {
			enabled: true,
			creative: {
				id: "alpha",
				campaign: "friends",
				text: `evil${ESC}]8;;x${BEL}line`,
				url: "https://alpha.example",
				weight: 1,
			},
			clickUrl: "https://w.example/v1/c/alpha",
		});
		const body = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(body).toContain("enabled=1");
		expect(body).toContain("creative=alpha");
		expect(body).toContain("text=evil]8;;xline");
		expect(body).toContain("url=https://w.example/v1/c/alpha");
		expect(body).not.toContain(ESC);
	});

	it("writes a disabled marker when disabled", () => {
		writeSponsorStatus(dir, { enabled: false });
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
	});

	it("falls back to the creative's own url when no clickUrl is given", () => {
		writeSponsorStatus(dir, {
			enabled: true,
			creative: {
				id: "alpha",
				campaign: "friends",
				text: "Alpha",
				url: "https://alpha.example/direct",
				weight: 1,
			},
		});
		const body = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(body).toContain("url=https://alpha.example/direct");
	});
});

describe("wire cache", () => {
	it("round-trips and tolerates a missing cache", () => {
		expect(loadCachedWire(dir)).toBeNull();
		saveCachedWire(dir, '{"key_id":"k"}');
		expect(loadCachedWire(dir)).toBe('{"key_id":"k"}');
	});

	it("swallows atomic-write errors instead of throwing (missing parent dir)", () => {
		const missingDir = join(dir, "does", "not", "exist");
		expect(() => saveCachedWire(missingDir, '{"key_id":"k"}')).not.toThrow();
		expect(loadCachedWire(missingDir)).toBeNull();
	});
});

describe("beacons", () => {
	const beacon: SponsorBeacon = {
		kind: "impression",
		creative: "alpha",
		campaign: "friends",
		window: 7,
		install_id: "inst-1",
		ts: "2026-06-12T00:00:00Z",
	};

	it("appends JSONL rows and flushes them in one POST, truncating on success", async () => {
		appendBeacon(dir, beacon);
		appendBeacon(dir, { ...beacon, window: 8 });
		const calls: Array<{ url: string; body: string }> = [];
		const fetchImpl: typeof fetch = (async (url, init) => {
			calls.push({ url: String(url), body: String(init?.body ?? "") });
			return new Response(null, { status: 200 });
		});
		const ok = await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl);
		expect(ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]?.body ?? "").beacons).toHaveLength(2);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toBe("");
	});

	it("keeps the buffer when the POST fails and succeeds with nothing to send", async () => {
		appendBeacon(dir, beacon);
		const failing: typeof fetch = (async () => {
			throw new Error("offline");
		});
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", failing)).toBe(false);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toContain("alpha");
		// Empty buffer flush is a success no-op.
		writeFileSync(join(dir, BEACON_FILE), "");
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", failing)).toBe(true);
	});

	it("succeeds as a no-op when there is no buffer file at all", async () => {
		const fetchImpl: typeof fetch = (async () => {
			throw new Error("should not be called");
		});
		// Fresh dir: no appendBeacon call yet, so readFileSync hits ENOENT.
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl)).toBe(true);
	});

	it("drops unparseable buffered rows rather than wedging the buffer", async () => {
		writeFileSync(join(dir, BEACON_FILE), "not json\n{also bad\n");
		const fetchImpl: typeof fetch = (async () => {
			throw new Error("should not be called: nothing valid to send");
		});
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl)).toBe(true);
	});

	it("keeps the buffer when the server responds non-2xx", async () => {
		appendBeacon(dir, beacon);
		const fetchImpl: typeof fetch = (async () => new Response(null, { status: 503 }));
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl)).toBe(false);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toContain("alpha");
	});

	it("skips appending once the buffer file exceeds the size cap", () => {
		// Pre-populate a file larger than BEACON_FILE_MAX_BYTES (1 MiB) so the
		// existsSync/statSync guard's `size > cap` arm is exercised.
		const big = "x".repeat(1024 * 1024 + 1);
		writeFileSync(join(dir, BEACON_FILE), big);
		appendBeacon(dir, beacon);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toBe(big);
	});

	it("swallows write errors instead of throwing (missing parent dir)", () => {
		const missingDir = join(dir, "does", "not", "exist");
		expect(() => appendBeacon(missingDir, beacon)).not.toThrow();
	});
});

describe("flushBeacons — per-row shape validation (parseSponsorBeacon)", () => {
	it("P1: forwards a well-shaped buffered row through to the POST body untouched", async () => {
		const row = {
			kind: "click",
			creative: "alpha",
			campaign: "friends",
			window: 12,
			install_id: "inst-9",
			ts: "2026-06-12T00:00:00Z",
		};
		writeFileSync(join(dir, BEACON_FILE), `${JSON.stringify(row)}\n`);
		const calls: Array<{ url: string; body: string }> = [];
		const fetchImpl: typeof fetch = (async (url, init) => {
			calls.push({ url: String(url), body: String(init?.body ?? "") });
			return new Response(null, { status: 200 });
		});
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl)).toBe(true);
		expect(JSON.parse(calls[0]?.body ?? "{}").beacons).toEqual([row]);
	});

	it("N1: drops a row whose `kind` is not impression/click rather than forwarding it", async () => {
		writeFileSync(
			join(dir, BEACON_FILE),
			`${JSON.stringify({
				kind: "bogus",
				creative: "alpha",
				campaign: "friends",
				window: 1,
				install_id: "inst-1",
				ts: "2026-06-12T00:00:00Z",
			})}\n`,
		);
		const fetchImpl: typeof fetch = (async () => {
			throw new Error("should not be called: nothing valid to send");
		});
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl)).toBe(true);
	});

	it("N2: drops a row missing a required string field (no `creative`)", async () => {
		writeFileSync(
			join(dir, BEACON_FILE),
			`${JSON.stringify({
				kind: "impression",
				campaign: "friends",
				window: 1,
				install_id: "inst-1",
				ts: "2026-06-12T00:00:00Z",
			})}\n`,
		);
		const fetchImpl: typeof fetch = (async () => {
			throw new Error("should not be called: nothing valid to send");
		});
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl)).toBe(true);
	});

	it("N3: drops a row that parses to a JSON array instead of a keyed object", async () => {
		writeFileSync(join(dir, BEACON_FILE), "[1,2,3]\n");
		const fetchImpl: typeof fetch = (async () => {
			throw new Error("should not be called: nothing valid to send");
		});
		expect(await flushBeacons(dir, "https://w.example/v1/beacon", fetchImpl)).toBe(true);
	});
});

describe("fetchFeedWire", () => {
	it("returns the wire text on a 2xx response", async () => {
		const fetchImpl: typeof fetch = (async () =>
			new Response('{"key_id":"k"}', { status: 200 }));
		expect(await fetchFeedWire("https://w.example/v1/feed", fetchImpl)).toBe('{"key_id":"k"}');
	});

	it("returns null on a non-2xx response", async () => {
		const fetchImpl: typeof fetch = (async () =>
			new Response("", { status: 503 }));
		expect(await fetchFeedWire("https://w.example/v1/feed", fetchImpl)).toBeNull();
	});

	it("returns null when the body exceeds the wire size cap", async () => {
		const huge = "x".repeat(256 * 1024 + 1);
		const fetchImpl: typeof fetch = (async () =>
			new Response(huge, { status: 200 }));
		expect(await fetchFeedWire("https://w.example/v1/feed", fetchImpl)).toBeNull();
	});

	it("aborts (returns null) when the body read stalls past the timeout", async () => {
		// Headers arrive, but res.text() only settles when the request is aborted.
		// The fix keeps the abort timer armed THROUGH the body read; the old code
		// cleared it right after headers, so a stalled body hung res.text() forever
		// — wedging `sponsor enable --spinner` and the daemon's tick (finding 2026-06).
		vi.useFakeTimers();
		try {
			const fetchImpl: typeof fetch = (async (_url, init) => {
				const signal = init?.signal;
				return new Response(new ReadableStream({
					start(controller) {
						signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
					},
				}));
			});
			const p = fetchFeedWire("https://w.example/v1/feed", fetchImpl);
			await vi.advanceTimersByTimeAsync(5_000); // FETCH_TIMEOUT_MS
			expect(await p).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
