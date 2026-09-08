// Mutation-directed tests for src/harness/content-scanner/web-fetch-proxy-ssrf-fetch.ts.
//
// The companion suite (__tests__/web-fetch-proxy.test.ts) already exercises this
// module extensively through a real loopback server; this file targets ONLY the
// specific mutants that survived that coverage — cases where the companion
// suite's inputs happened not to distinguish the mutated behavior from the
// original. Every expected value below was hand-derived from the source AND
// cross-checked against the pristine build's actual runtime behavior (Node's
// `net.isIP`, `URL` parsing, `EventEmitter` semantics) before being pinned as
// an assertion.
//
// pinnedFetch's mutants are driven through a mocked node:http/node:https
// `request` (not a real loopback socket like the companion suite uses) because
// several of them — which of httpRequest/httpsRequest gets called, the exact
// options object, which literal string an event listener is registered under —
// need to be observed directly rather than inferred from a real connection's
// success/failure, which can't distinguish e.g. "used the wrong agent" from
// "used the right agent against an unreachable port".

import { EventEmitter } from "node:events";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";

// ---- module mocks (only pinnedFetch touches node:http/node:https; every
// other export in this file uses node:net's real isIP and an injected
// HostResolver, exactly like the companion suite) -------------------------

const { httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
	httpRequestMock: vi.fn(),
	httpsRequestMock: vi.fn(),
}));

vi.mock("node:http", () => ({ request: httpRequestMock }));
vi.mock("node:https", () => ({ request: httpsRequestMock }));

// ---- imports (after mocks) -------------------------------------------------

import {
	assertSafeFetchTarget,
	fetchBody,
	type HostResolver,
	isBlockedAddress,
	makePinnedLookup,
	type PinnedFetchResponse,
	pinnedFetch,
	SsrfBlockedError,
	type VettedTarget,
} from "./web-fetch-proxy-ssrf-fetch.js";

// ---------------------------------------------------------------------------
// SsrfBlockedError
// ---------------------------------------------------------------------------

describe("SsrfBlockedError", () => {
	// test-contract: invariant — the constructor sets `this.name` explicitly
	// (Error subclasses don't get this for free); collapsing the literal to ""
	// leaves the default "Error" name instead.
	it("sets the Error name to SsrfBlockedError", () => {
		const err = new SsrfBlockedError("invalid_url", "http://x/", "detail");
		expect(err.name).toBe("SsrfBlockedError");
	});
});

// ---------------------------------------------------------------------------
// isBlockedAddress — family dispatch
// ---------------------------------------------------------------------------

describe("isBlockedAddress — family dispatch", () => {
	// test-contract: security — isIP("1234:zzzz") is 0 (not a valid IPv6: the
	// "zzzz" group isn't hex), so the real code takes the final `return true`
	// default; forcing IPv6 dispatch on it anyway would clear it instead (its
	// leading "1234" parses as a public-shaped first hextet).
	it("stays blocked for a non-IP string even though forcing IPv6 dispatch on it would clear it", () => {
		expect(isBlockedAddress("1234:zzzz")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// isBlockedAddress — V4_BLOCKED_RANGES boundary rules. Every rule below
// requires ALL of its listed octets to match; each test isolates one octet
// as "matches" and the other(s) as "does not match" to prove the rule is a
// conjunction, not satisfied by any single octet alone.
// ---------------------------------------------------------------------------

describe("isBlockedAddress — V4_BLOCKED_RANGES boundary rules", () => {
	// test-contract: boundary — link-local (169.254.0.0/16) requires BOTH
	// a===169 AND b===254; b alone must not be enough (the && must not
	// weaken to ||, and a===169 alone must not be enough either).
	it("does not block 169.x.x.x when the second octet is not 254", () => {
		expect(isBlockedAddress("169.1.2.3")).toBe(false);
	});

	// test-contract: boundary — same rule, the other operand in isolation:
	// b===254 alone (first octet not 169) must not trip it.
	it("does not block x.254.x.x when the first octet is not 169", () => {
		expect(isBlockedAddress("5.254.1.1")).toBe(false);
	});

	// test-contract: boundary — 192.168.0.0/16 (RFC1918) requires b===168;
	// a===192 alone (second octet not 168) must not trip it. This isolates
	// the FIRST a===192 comparison in source order (the 192.168 rule) from
	// the second one (the 192.0.0.0/24 rule below).
	it("does not block x.168.x.x when the first octet is not 192", () => {
		expect(isBlockedAddress("5.168.9.9")).toBe(false);
	});

	// test-contract: boundary — 192.0.0.0/24 requires a===192 AND b===0 AND
	// c===0; b===0&&c===0 alone (first octet not 192) must not trip it — this
	// isolates the SECOND a===192 comparison (and the a===192&&b===0
	// sub-clause's && vs || form) from the 192.168 rule above.
	it("does not block x.0.0.x when the first octet is not 192", () => {
		expect(isBlockedAddress("5.0.0.9")).toBe(false);
	});

	// test-contract: boundary — same 192.0.0.0/24 rule, isolating b===0:
	// a===192 with a non-zero second octet must not trip it.
	it("does not block 192.x.0.x when the second octet is not 0", () => {
		expect(isBlockedAddress("192.5.0.9")).toBe(false);
	});

	// test-contract: boundary — 198.18.0.0/15 (RFC2544 benchmark) requires
	// a===198; b===18 alone (first octet not 198) must not trip it.
	it("does not block x.18.x.x when the first octet is not 198", () => {
		expect(isBlockedAddress("5.18.1.1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isBlockedAddress — isBlockedV6's ::ffff: (IPv4-mapped) branch
// ---------------------------------------------------------------------------

describe("isBlockedAddress — isBlockedV6 ::ffff: branch", () => {
	// test-contract: security — forcing `startsWith("::ffff:")` to always be
	// true makes "::abcd:1.2.3.4" (no real ::ffff: prefix) slice to the
	// public-looking tail "1.2.3.4" instead of failing the real first-hextet
	// (0xabcd) range check that blocks it.
	it("still applies the first-hextet range check to an address that does not start with ::ffff:", () => {
		expect(isBlockedAddress("::abcd:1.2.3.4")).toBe(true);
	});

	// test-contract: security — weakening the "::ffff:" literal to "" slices
	// ZERO chars off, so `v4` is the whole IPv6 string (never a valid dotted-
	// quad); isBlockedV4 never runs and the empty-leading-hextet fallback
	// blocks a real public mapped address that should be allowed.
	it("allows an IPv4-mapped address whose embedded V4 is public", () => {
		expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
	});

	// test-contract: security — forcing `isIP(v4) === 4` to always be true
	// hands a non-dotted-quad tail to isBlockedV4 anyway; its naive parseInt
	// parser reads "50:1.2.3.4" as octets [50,2,3,4] (unblocked), clearing an
	// address that should fall through to the blocking first-hextet default.
	it("does not treat a ::ffff:-prefixed tail that is not really a dotted-quad as a valid embedded IPv4", () => {
		expect(isBlockedAddress("::ffff:50:1.2.3.4")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// assertSafeFetchTarget / vetIpLiteral / vetResolvedHostname — message-content
// mutants. Each collapses a template literal's interpolated detail to "",
// which the companion suite's `.rejects.toMatchObject({ reason: ... })`
// assertions never exercise (they check `.reason`, never `.message`).
// ---------------------------------------------------------------------------

describe("assertSafeFetchTarget — rejection message content", () => {
	// test-contract: invariant — the invalid_url detail is asserted via the
	// FULL SsrfBlockedError message, so collapsing the template to "" is
	// directly observable (the companion suite only ever checks `.reason`).
	it("includes the literal 'URL parse failed' detail when the URL fails to parse", async () => {
		const err = await assertSafeFetchTarget("not a url").catch((e: unknown) => e);
		assert(err instanceof SsrfBlockedError);
		expect(err.message).toBe(
			"SSRF guard blocked WebFetch (invalid_url): URL parse failed",
		);
	});

	// test-contract: invariant — same pattern for the scheme_not_allowed
	// detail template: the companion suite never asserts `.message`, only
	// `.reason`.
	it("includes the literal scheme name in the scheme_not_allowed detail", async () => {
		const err = await assertSafeFetchTarget("ftp://x.example/").catch((e: unknown) => e);
		assert(err instanceof SsrfBlockedError);
		expect(err.message).toBe(
			"SSRF guard blocked WebFetch (scheme_not_allowed): scheme ftp: not in {http, https}",
		);
	});

	// test-contract: invariant — vetIpLiteral's detail template.
	it("includes the literal 'is private/loopback/link-local' detail for a blocked IP literal", async () => {
		const err = await assertSafeFetchTarget("http://127.0.0.1/").catch((e: unknown) => e);
		assert(err instanceof SsrfBlockedError);
		expect(err.message).toBe(
			"SSRF guard blocked WebFetch (ip_literal_blocked): literal address 127.0.0.1 is private/loopback/link-local",
		);
	});

	// test-contract: invariant — vetResolvedHostname's detail template.
	it("includes the literal 'resolves to blocked address' detail for a blocked resolved address", async () => {
		const blockedResolver: HostResolver = async () => [{ address: "127.0.0.1", family: 4 }];
		const err = await assertSafeFetchTarget("https://attacker.example/", blockedResolver).catch(
			(e: unknown) => e,
		);
		assert(err instanceof SsrfBlockedError);
		expect(err.message).toBe(
			"SSRF guard blocked WebFetch (resolved_ip_blocked): hostname attacker.example resolves to blocked address 127.0.0.1",
		);
	});

});

// ---------------------------------------------------------------------------
// makePinnedLookup — typeof-options mutants
// ---------------------------------------------------------------------------

describe("makePinnedLookup — typeof-options mutants", () => {
	// test-contract: invariant — both mutants make the 2-argument (hostname,
	// callback) form ALWAYS treat `options` as the options object — even when
	// it really is the callback — losing the real callback (the omitted 3rd
	// argument) instead of invoking it.
	it("still recognizes the 2-argument (hostname, callback) form and invokes the real callback", () => {
		const target: VettedTarget = {
			url: new URL("https://pinned.example/"),
			vettedAddress: "203.0.113.42",
			vettedFamily: 4,
		};
		const lookup = makePinnedLookup(target);
		let addr: string | undefined;
		let fam: number | undefined;
		const cb = (_err: Error | null, a: string, f: number): void => {
			addr = a;
			fam = f;
		};
		lookup("pinned.example", cb);
		expect(addr).toBe("203.0.113.42");
		expect(fam).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// pinnedFetch — request construction and event wiring, driven through a
// mocked node:http/node:https `request`. Every field mutated below is
// captured directly off the options object handed to the mock, or observed
// via a spy / EventEmitter.eventNames() on the fake request/response — no
// real socket, so no ambiguity between "wrong agent" and "unreachable port".
// ---------------------------------------------------------------------------

class FakeClientRequest extends EventEmitter {
	readonly destroy = vi.fn();
	readonly end = vi.fn();
}

class FakeIncomingMessage extends EventEmitter {
	statusCode: number | undefined;
	headers: Record<string, unknown> = {};
	readonly setEncoding = vi.fn();
}

interface CapturedRequestOptions {
	protocol?: unknown;
	path?: unknown;
	method?: unknown;
	port?: unknown;
	headers?: Record<string, unknown>;
}

describe("pinnedFetch — request construction (mocked node:http/https)", () => {
	let capturedOpts: CapturedRequestOptions | undefined;
	let capturedReq: FakeClientRequest | undefined;

	function getCapturedReq(): FakeClientRequest {
		if (!capturedReq) throw new Error("expected requestFn to have been called synchronously");
		return capturedReq;
	}

	beforeEach(() => {
		httpRequestMock.mockReset();
		httpsRequestMock.mockReset();
		capturedOpts = undefined;
		capturedReq = undefined;
		const impl = (opts: CapturedRequestOptions): FakeClientRequest => {
			capturedOpts = opts;
			capturedReq = new FakeClientRequest();
			return capturedReq;
		};
		httpRequestMock.mockImplementation(impl);
		httpsRequestMock.mockImplementation(impl);
	});

	// test-contract: security — both mutants on this comparison (forcing the
	// ConditionalExpression to false, and weakening the "https:" literal to
	// "") make `isHttps` always false, so an https: target would silently
	// use the plaintext http.request agent instead of https.request.
	it("selects httpsRequest, not httpRequest, for an https: target", () => {
		const target: VettedTarget = {
			url: new URL("https://example.test/secure"),
			vettedAddress: "203.0.113.9",
			vettedFamily: 4,
		};
		pinnedFetch(target);
		expect(httpRequestMock).not.toHaveBeenCalled();
		// Value check (not just "was httpsRequestMock called"): the options
		// object httpsRequestMock's own implementation captured must be the
		// real https: request, proving the RIGHT agent ran with the RIGHT data.
		expect(capturedOpts).toMatchObject({ protocol: "https:", hostname: "example.test" });
	});

	// test-contract: boundary — both mutants (forcing `port !== ""` true, and
	// weakening its "" comparand) make a portless URL compute
	// `Number("")===0` instead of falling back to the correct default port 80.
	it("falls back to the default port 80 when the URL has no explicit port", () => {
		const target: VettedTarget = {
			url: new URL("http://example.test/"),
			vettedAddress: "203.0.113.9",
			vettedFamily: 4,
		};
		pinnedFetch(target);
		getCapturedReq();
		expect(capturedOpts).toMatchObject({ port: 80 });
	});

	// test-contract: invariant — path/method/headers are each independently
	// mutated (the path template collapsed to "", "GET" collapsed to "", the
	// whole headers spread collapsed to {}); one request's options object
	// pins all three at once.
	it("builds the path from pathname+search, method GET, and the Accept/Host headers", () => {
		const target: VettedTarget = {
			url: new URL("http://example.test/some/path?foo=bar"),
			vettedAddress: "203.0.113.9",
			vettedFamily: 4,
		};
		pinnedFetch(target);
		getCapturedReq();
		expect(capturedOpts).toMatchObject({
			path: "/some/path?foo=bar",
			method: "GET",
		});
		expect(capturedOpts?.headers).toEqual({
			Accept: "text/markdown",
			Host: "example.test",
		});
	});

	// test-contract: security — both mutants (the "timeout" event name
	// weakened to "", and the handler body replaced with a no-op) mean a real
	// socket timeout would never call req.destroy(), leaving a dangling
	// connection instead of aborting it.
	it("destroys the request with a timeout Error when the socket 'timeout' event fires", () => {
		const target: VettedTarget = {
			url: new URL("http://example.test/"),
			vettedAddress: "203.0.113.9",
			vettedFamily: 4,
		};
		pinnedFetch(target);
		const req = getCapturedReq();
		req.emit("timeout");
		const destroyArg = req.destroy.mock.calls[0]?.[0];
		assert(destroyArg instanceof Error);
		expect(destroyArg.message).toBe("fetch timeout after 30000ms");
	});

	// test-contract: invariant — forcing this ConditionalExpression to `true`
	// means ANY headers.location value (not just a genuine string) flows
	// through to the resolved PinnedFetchResponse verbatim.
	it("reports location as undefined when the header value is not a string", async () => {
		const target: VettedTarget = {
			url: new URL("http://example.test/"),
			vettedAddress: "203.0.113.9",
			vettedFamily: 4,
		};
		const promise = pinnedFetch(target);
		const req = getCapturedReq();
		const res = new FakeIncomingMessage();
		res.statusCode = 200;
		res.headers = { location: 12345 };
		req.emit("response", res);
		res.emit("end");
		const resp = await promise;
		expect(resp.location).toBeUndefined();
	});

	// test-contract: invariant — the literal encoding string is pinned on the
	// spy AND the accumulated body is asserted, so this checks real output
	// (not just that a mock fired) alongside the argument the mutant weakens.
	it("sets the response encoding to utf-8 while correctly accumulating the body", async () => {
		const target: VettedTarget = {
			url: new URL("http://example.test/"),
			vettedAddress: "203.0.113.9",
			vettedFamily: 4,
		};
		const promise = pinnedFetch(target);
		const req = getCapturedReq();
		const res = new FakeIncomingMessage();
		res.statusCode = 200;
		req.emit("response", res);
		expect(res.setEncoding).toHaveBeenCalledWith("utf-8");
		res.emit("data", "hello ");
		res.emit("data", "world");
		res.emit("end");
		const resp = await promise;
		expect(resp.body).toBe("hello world");
		expect(resp.status).toBe(200);
	});

	// test-contract: security — the event name "error" weakened to "" means a
	// response-stream error would never reach the promise's reject(), leaving
	// the caller hanging forever instead of failing fast.
	it("registers the response-stream error handler under the exact event name 'error'", async () => {
		const target: VettedTarget = {
			url: new URL("http://example.test/"),
			vettedAddress: "203.0.113.9",
			vettedFamily: 4,
		};
		const promise = pinnedFetch(target);
		const req = getCapturedReq();
		const res = new FakeIncomingMessage();
		res.statusCode = 200;
		req.emit("response", res);
		expect(res.eventNames()).toContain("error");
		res.emit("end");
		await promise;
	});
});

// ---------------------------------------------------------------------------
// fetchBody — status-comparison boundary mutants. status===300 is the exact
// point where `>=300` and `>300` diverge; status===400 is the exact point
// where `<400` and (`true` / `<=400`) diverge.
// ---------------------------------------------------------------------------

describe("fetchBody — status-comparison boundary mutants", () => {
	function vettedFor(url: string): VettedTarget {
		return { url: new URL(url), vettedAddress: "203.0.113.7", vettedFamily: 4 };
	}

	// test-contract: boundary — weakening the redirect-entry guard's `>=300`
	// to `>300` would skip the redirect branch entirely for a bare 300 and
	// fall through to the plain-throw branch instead of following Location.
	it("still treats a bare 300 as a redirect status and follows its Location header", async () => {
		let call = 0;
		const vet = async (u: string): Promise<VettedTarget> => vettedFor(u);
		const fetchOne = async (): Promise<PinnedFetchResponse> => {
			call += 1;
			return call === 1
				? { status: 300, location: "/next", body: "" }
				: { status: 200, body: "after-300-redirect" };
		};
		await expect(fetchBody("https://public.example/", { vet, fetchOne })).resolves.toBe(
			"after-300-redirect",
		);
	});

	// test-contract: boundary — either mutant on the redirect-entry guard's
	// `<400` (forced `true`, or weakened to `<=400`) wrongly routes a bare 400
	// through the redirect branch, changing the rejection message from
	// "HTTP 400" to "HTTP 400 redirect without Location header".
	it("throws the plain HTTP-400 message, not a redirect-without-Location message", async () => {
		const vet = async (u: string): Promise<VettedTarget> => vettedFor(u);
		const fetchOne = async (): Promise<PinnedFetchResponse> => ({ status: 400, body: "bad" });
		const err = await fetchBody("https://public.example/", { vet, fetchOne }).catch(
			(e: unknown) => e,
		);
		assert(err instanceof Error);
		expect(err.message).toBe("HTTP 400");
	});
});
