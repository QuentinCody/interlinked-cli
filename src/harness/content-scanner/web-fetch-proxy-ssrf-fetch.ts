// interlinked-tdd: exempt
// ===========================================
// Content Scanner — WebFetch proxy SSRF-guarded fetch
// ===========================================
//
// The harness performs the WebFetch on the developer's behalf, so an
// agent-supplied URL would otherwise reach loopback / RFC1918 / link-local
// addresses the agent itself can't reach (cloud metadata at
// 169.254.169.254, dev-only services on localhost, intranet apps over
// VPN, …). Every fetch goes through `assertSafeFetchTarget` before the
// network call, and redirects are followed manually with the same
// validation re-applied to each hop.
//
// Extracted verbatim from `web-fetch-proxy.ts` as a leaf cluster (only
// depends on node builtins) to keep the main proxy module under the
// per-file line cap. No behaviour change.

import type { LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { nonNull } from "../../lib/non-null.js";

/** WebFetch can pull megabytes; cap the network wait at 30 s to keep the
 *  hook well under Claude Code's 5 s PreToolUse budget when the harness is
 *  acting as the agent's substitute fetcher. The harness is allowed to take
 *  longer than the hook because the proxy returns block-and-answer (the
 *  hook reply IS the tool's result) rather than awaiting a separate tool. */
const FETCH_TIMEOUT_MS = 30_000;
/** `Accept: text/markdown` opts into Cloudflare's Markdown for Agents
 *  conversion (project convention) — ~80% fewer tokens for HTML pages and
 *  the response includes an `x-markdown-tokens` count. Servers that don't
 *  support content negotiation just ignore it. */
const FETCH_HEADERS = { Accept: "text/markdown" } as const;
/** Cap manual redirect follows. Five matches Chrome / curl-default-style
 *  behaviour and is enough for normal web use without giving an attacker
 *  unbounded hop chains to confuse the per-hop SSRF re-validation. */
const MAX_REDIRECT_HOPS = 5;
/** Schemes other than these go straight to a fail_open. `file://`,
 *  `javascript:`, `gopher://`, and `data://` are not network fetches we
 *  want the harness performing on the agent's behalf. */
const ALLOWED_FETCH_SCHEMES = new Set(["http:", "https:"]);

// ===========================================
// Fetch — SSRF-guarded
// ===========================================

/** Resolver shape used by `assertSafeFetchTarget`. Defaults to
 *  `dns/promises.lookup`; tests inject a deterministic stub. */
export type HostResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: HostResolver = async (hostname) => {
	const results = await dnsLookup(hostname, { all: true });
	return results.map((r) => ({ address: r.address, family: r.family }));
};

/** Reasons `assertSafeFetchTarget` rejects a URL. Exported so callers and
 *  tests can branch on a stable set of strings instead of substring-
 *  matching error messages. */
export type SsrfRejectionReason =
	| "invalid_url"
	| "scheme_not_allowed"
	| "ip_literal_blocked"
	| "hostname_resolution_failed"
	| "resolved_ip_blocked";

export class SsrfBlockedError extends Error {
	readonly reason: SsrfRejectionReason;
	readonly url: string;
	constructor(
		reason: SsrfRejectionReason,
		url: string,
		detail: string,
		options?: { cause?: unknown },
	) {
		super(`SSRF guard blocked WebFetch (${reason}): ${detail}`, options);
		this.reason = reason;
		this.url = url;
		this.name = "SsrfBlockedError";
	}
}

/** True for any IPv4/IPv6 address that should never be reached by the
 *  proxy: loopback, RFC1918 private, link-local (incl. cloud-metadata
 *  169.254.169.254), broadcast/wildcard, multicast, and ULA/site-local
 *  IPv6. Operates on the canonical string form returned by
 *  `dns.lookup` — no parsing back into octets needed for the V4 ranges
 *  we care about. */
export function isBlockedAddress(addr: string): boolean {
	const family = isIP(addr);
	if (family === 4) return isBlockedV4(addr);
	if (family === 6) return isBlockedV6(addr);
	return true;
}

/** One blocked IPv4 CIDR range, evaluated against the four parsed octets.
 *  Kept as a data table so `isBlockedV4` is a flat `some(...)` over it rather
 *  than a long `&&`/`if` chain (cyclomatic was 22). Each predicate is the
 *  bit-for-bit equivalent of the original conditional it replaced; the octets
 *  are guaranteed defined numbers because `parseV4Octets` rejects anything
 *  that isn't exactly four numeric parts before these run. */
const V4_BLOCKED_RANGES: ReadonlyArray<(o: readonly [number, number, number, number]) => boolean> = [
	([a]) => a === 0, // 0.0.0.0/8 — wildcard / "this network"
	([a]) => a === 10, // RFC1918
	([a]) => a === 127, // loopback
	([a, b]) => a === 169 && b === 254, // link-local incl. cloud metadata
	([a, b]) => a === 172 && b >= 16 && b <= 31, // RFC1918
	([a, b]) => a === 192 && b === 168, // RFC1918
	([a, b, c]) => a === 192 && b === 0 && c === 0, // RFC5736 / RFC6890
	([a, b]) => a === 198 && (b === 18 || b === 19), // RFC2544 benchmark
	([a]) => a >= 224, // multicast (224/4) + reserved (240/4) + 255.255.255.255
];

/** Parse a dotted-quad into its four octets, or `null` when the string isn't
 *  exactly four numeric parts. Splitting the parse out keeps `isBlockedV4`
 *  flat and lets the range predicates take a fixed-length tuple of numbers. */
function parseV4Octets(addr: string): [number, number, number, number] | null {
	const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
	/* v8 ignore next -- defensive: every caller reaches here only after isIP(addr)===4, so a dotted-quad always splits into four numeric octets; the malformed-input null path is structurally unreachable. */
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
	return [nonNull(parts[0]), nonNull(parts[1]), nonNull(parts[2]), nonNull(parts[3])];
}

function isBlockedV4(addr: string): boolean {
	const octets = parseV4Octets(addr);
	/* v8 ignore next -- defensive: isBlockedV4 is only reached via isBlockedAddress after isIP(addr)===4, so the dotted-quad always parses; the null branch can't be hit in practice. */
	if (!octets) return true;
	return V4_BLOCKED_RANGES.some((inRange) => inRange(octets));
}

function isBlockedV6(addrRaw: string): boolean {
	// Strip a zone-id suffix if any (`fe80::1%eth0` → `fe80::1`). `split`
	// always yields ≥1 element, so `[0]` is a string (no nullish fallback
	// needed — that dead branch is gone).
	const addr = nonNull(addrRaw.split("%")[0]).toLowerCase();
	if (addr === "::" || addr === "::1") return true;
	// IPv4-mapped (::ffff:a.b.c.d) → re-check against the V4 ranges.
	if (addr.startsWith("::ffff:")) {
		const v4 = addr.slice("::ffff:".length);
		if (isIP(v4) === 4) return isBlockedV4(v4);
	}
	// fc00::/7 (unique-local) and fe80::/10 (link-local). `[0]` is again a
	// guaranteed string from `split`.
	const firstSegment = Number.parseInt(nonNull(addr.split(":")[0]), 16);
	if (Number.isNaN(firstSegment)) return true;
	if ((firstSegment & 0xfe00) === 0xfc00) return true; // fc00::/7
	if ((firstSegment & 0xffc0) === 0xfe80) return true; // fe80::/10
	if ((firstSegment & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	return false;
}

/** Tuple returned by `assertSafeFetchTarget`. The vetted address is the
 *  one — and only one — IP literal the caller is allowed to actually
 *  connect to. The fetcher must pin its `lookup` to this value so the
 *  later connect cannot land on a different IP that didn't pass the
 *  guard (DNS-rebinding TOCTOU). For literal-IP URLs `vettedAddress`
 *  equals the parsed hostname; for hostnames it's the address the
 *  resolver returned and the guard cleared. `vettedFamily` is 4 or 6
 *  to feed `lookup`'s callback signature. */
export interface VettedTarget {
	url: URL;
	vettedAddress: string;
	vettedFamily: 4 | 6;
}

/** Range-check a literal-IP host (the no-DNS-rebinding-window path). Throws
 *  `SsrfBlockedError` if the address is private/loopback/link-local, else
 *  returns the vetted target pinned to the literal itself. Factored out of
 *  `assertSafeFetchTarget` to keep that function's branch count low; the
 *  caller has already established `isIP(bareHost) !== 0`. */
function vetIpLiteral(parsed: URL, rawUrl: string, bareHost: string): VettedTarget {
	if (isBlockedAddress(bareHost)) {
		throw new SsrfBlockedError(
			"ip_literal_blocked",
			rawUrl,
			`literal address ${bareHost} is private/loopback/link-local`,
		);
	}
	const family = isIP(bareHost) === 4 ? 4 : 6;
	return { url: parsed, vettedAddress: bareHost, vettedFamily: family };
}

/** Resolve a hostname and reject if **any** A/AAAA record is blocked (defends
 *  against split-resolve records mixing a public and a private IP). Pins to
 *  the first resolved address — the fetcher's `lookup` returns exactly this
 *  IP, closing the DNS-rebinding TOCTOU between resolution and connect.
 *  Factored out of `assertSafeFetchTarget` for the same branch-count reason. */
async function vetResolvedHostname(
	parsed: URL,
	rawUrl: string,
	bareHost: string,
	resolver: HostResolver,
): Promise<VettedTarget> {
	let addresses: { address: string; family: number }[];
	try {
		addresses = await resolver(bareHost);
	} catch (err) {
		throw new SsrfBlockedError(
			"hostname_resolution_failed",
			rawUrl,
			`DNS lookup of ${bareHost} failed: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	if (addresses.length === 0) {
		throw new SsrfBlockedError(
			"hostname_resolution_failed",
			rawUrl,
			`DNS lookup of ${bareHost} returned no addresses`,
		);
	}
	for (const entry of addresses) {
		if (isBlockedAddress(entry.address)) {
			throw new SsrfBlockedError(
				"resolved_ip_blocked",
				rawUrl,
				`hostname ${bareHost} resolves to blocked address ${entry.address}`,
			);
		}
	}
	// Every record passed; pin the first one. Fetcher's `lookup` callback
	// returns this exact address regardless of what a second DNS round
	// might say a few ms later — that's the SSRF-rebinding fix.
	const first = addresses[0];
	/* v8 ignore next 8 -- defensive: addresses.length === 0 is rejected above, so addresses[0] is always present here; the empty-guard branch is structurally unreachable. */
	if (!first) {
		throw new SsrfBlockedError(
			"hostname_resolution_failed",
			rawUrl,
			`DNS lookup of ${bareHost} returned no usable address`,
		);
	}
	const family = first.family === 6 ? 6 : 4;
	return { url: parsed, vettedAddress: first.address, vettedFamily: family };
}

/** Validates a URL is safe for the harness to fetch. Throws
 *  `SsrfBlockedError` if not. Resolves hostnames via `dnsLookup` (or the
 *  injected resolver) and rejects if **any** resolved address is blocked
 *  (defends against DNS records that include a public + a private IP).
 *  Returns the parsed URL together with the single vetted address the
 *  fetcher must pin to. */
export async function assertSafeFetchTarget(
	rawUrl: string,
	resolver: HostResolver = defaultResolver,
): Promise<VettedTarget> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch (err) {
		throw new SsrfBlockedError("invalid_url", rawUrl, "URL parse failed", {
			cause: err,
		});
	}
	if (!ALLOWED_FETCH_SCHEMES.has(parsed.protocol)) {
		throw new SsrfBlockedError(
			"scheme_not_allowed",
			rawUrl,
			`scheme ${parsed.protocol} not in {http, https}`,
		);
	}
	const hostname = parsed.hostname;
	/* v8 ignore next -- defensive: WHATWG `new URL` throws on an empty host for http/https, so a successfully-parsed allowed-scheme URL always has a hostname; this branch can't be reached. */
	if (!hostname) {
		throw new SsrfBlockedError("invalid_url", rawUrl, "URL has no hostname");
	}
	// Strip surrounding brackets that `URL.hostname` keeps for IPv6
	// literals (`[::1]` → `::1`).
	const bareHost = hostname.startsWith("[") && hostname.endsWith("]")
		? hostname.slice(1, -1)
		: hostname;
	if (isIP(bareHost) !== 0) {
		// Literal IP — no DNS rebinding window, just range-check it.
		return vetIpLiteral(parsed, rawUrl, bareHost);
	}
	// Hostname — resolve and reject if any A/AAAA is blocked.
	return vetResolvedHostname(parsed, rawUrl, bareHost, resolver);
}

export interface PinnedFetchResponse {
	status: number;
	location?: string | undefined;
	body: string;
}

/** The two shapes Node's `http(s).request` `lookup` option can be invoked
 *  with. The client passes `{ all: true }`, in which case it expects the
 *  callback to receive an **array** of `{ address, family }`; the legacy
 *  positional `(err, address, family)` form is used otherwise. We support
 *  both so the connect is pinned whether the hostname is a literal IP (Node
 *  skips lookup) or a name (Node calls lookup with `all: true`). */
type LookupAllCb = (err: Error | null, addresses: { address: string; family: number }[]) => void;
type LookupPositionalCb = (err: Error | null, address: string, family: number) => void;
type PinnedLookup = LookupFunction & {
	(hostname: string, callback: LookupPositionalCb): void;
	(hostname: string, options: { all: true }, callback: LookupAllCb): void;
	(hostname: string, options: { all?: false }, callback: LookupPositionalCb): void;
};

/** Build the `lookup` override that pins every connect to the single vetted
 *  address. Factored out of `pinnedFetch` so the dual-shape callback is its
 *  own unit (and directly testable). Returns the vetted address in whichever
 *  form Node asked for — the SSRF-rebinding pin is identical either way: the
 *  socket can only ever connect to `target.vettedAddress`. Exported so both
 *  the `{ all: true }` (real Node) and the positional / two-argument
 *  invocation shapes can be unit-tested without a live socket. */
export function makePinnedLookup(target: VettedTarget): PinnedLookup {
	const lookup = (
		_hostname: string,
		options: LookupOptions | LookupPositionalCb,
		cb?: Parameters<LookupFunction>[2],
	): void => {
		if (typeof options === "function") {
			options(null, target.vettedAddress, target.vettedFamily);
			return;
		}
		const callback = nonNull(cb);
		if (options.all) {
			callback(null, [
				{ address: target.vettedAddress, family: target.vettedFamily },
			]);
			return;
		}
		callback(null, target.vettedAddress, target.vettedFamily);
	};
	// SAFETY: each overload pairs its callback with the matching all flag;
	// the implementation sends an array only for all:true and positional values otherwise.
	return lookup as PinnedLookup;
}

/** Issues a single HTTP/HTTPS request whose underlying TCP `connect` is
 *  pinned to `target.vettedAddress`. Implemented via `node:http(s).request`
 *  with the `lookup` option overridden — the lookup callback synchronously
 *  returns the address the SSRF guard already approved, so undici / the
 *  global `fetch`'s second DNS resolution can't slip a different IP past
 *  the gate (the DNS-rebinding TOCTOU). TLS SNI + cert verification still
 *  use the original hostname so HTTPS works against a normal DNS-routed
 *  server.
 *
 *  Manual redirect handling (no automatic follow): the caller drives the
 *  hop loop in `fetchBody` so each hop's URL is re-vetted by
 *  `assertSafeFetchTarget` before its connect is pinned.
 *
 *  Exported for direct testing against a real loopback server: `pinnedFetch`
 *  itself does NOT call the SSRF guard (the caller `fetchBody` does), so a
 *  test may hand it a `VettedTarget` pointing at a loopback address to
 *  exercise the real socket / response-event path without tripping the
 *  range checks. */
export function pinnedFetch(target: VettedTarget): Promise<PinnedFetchResponse> {
	return new Promise((resolve, reject) => {
		const isHttps = target.url.protocol === "https:";
		const requestFn = isHttps ? httpsRequest : httpRequest;
		const defaultPort = isHttps ? 443 : 80;
		// The explicit-port arm is exercised by every test. The default-port
		// fallback is TESTABLE, not unmeasurable: calling the exported
		// `pinnedFetch` with a portless URL pinned to 127.0.0.1 takes this arm
		// and settles in a few ms (ECONNREFUSED when nothing listens on 80).
		// The pragma is therefore left DELIBERATELY BARE so the
		// suppressions-unjustified surface keeps reporting it as a
		// coverage-campaign target: remove the pragma, write the test.
		/* v8 ignore next */
		const port = target.url.port !== "" ? Number(target.url.port) : defaultPort;
		// `lookup` runs once per connect; we synchronously hand back the
		// vetted IP so the underlying socket connects exactly there. The
		// dual-shape handler covers Node's `{ all: true }` array form (used
		// for hostname URLs) as well as the positional form.
		const req = requestFn({
			protocol: target.url.protocol,
			hostname: target.url.hostname,
			port,
			path: `${target.url.pathname}${target.url.search}`,
			method: "GET",
			headers: { ...FETCH_HEADERS, Host: target.url.host },
			timeout: FETCH_TIMEOUT_MS,
			lookup: makePinnedLookup(target),
			servername: target.url.hostname,
		});
		req.on("response", (res) => {
			// `?? 0` is defensive: a delivered IncomingMessage always carries a
			// numeric statusCode, so the null-coalesce arm can't be reached.
			/* v8 ignore next -- unmeasurable: a delivered IncomingMessage always carries a numeric statusCode, so the coalesce arm is structurally unreachable */
			const status = res.statusCode ?? 0;
			const location =
				typeof res.headers.location === "string" ? res.headers.location : undefined;
			let body = "";
			res.setEncoding("utf-8");
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => resolve({ status, location, body }));
			res.on("error", reject);
		});
		req.on("error", reject);
		// The timeout handler only fires after FETCH_TIMEOUT_MS (30 s) of socket
		// inactivity; reaching it hermetically would mean a 30 s wall-clock wait,
		// so the handler body is coverage-ignored. The registration line runs.
		/* v8 ignore next -- unmeasurable: the handler body needs 30 s of real socket inactivity to fire */
		req.on("timeout", () => req.destroy(new Error(`fetch timeout after ${FETCH_TIMEOUT_MS}ms`)));
		req.end();
	});
}

/** Throws on any non-success outcome (network error, abort, non-2xx
 *  status, decode failure, SSRF rejection on any hop). The caller wraps
 *  the call in try/catch and surfaces `fail_open` — keeping the success
 *  path linear here. Redirects are followed manually with the same SSRF
 *  validation applied to every hop, which closes the public-URL-302-to-
 *  private-host bypass. The connect for each hop is pinned to the vetted
 *  IP returned by `assertSafeFetchTarget`, closing the DNS-rebinding
 *  TOCTOU between resolution and connect.
 *
 *  `deps` is a test seam: production callers pass nothing, so `vet` defaults
 *  to the real `assertSafeFetchTarget` and `fetchOne` to the real
 *  `pinnedFetch`. The existing `args.fetcher ?? fetchBody` call site stays
 *  unchanged (it invokes `fetchBody(url)` with `deps` defaulted to `{}`).
 *  Tests inject stub `vet`/`fetchOne` to drive the redirect-follow loop,
 *  status branches, and hop exhaustion without any real network or DNS.
 *  Exported for that direct testing; production reaches it via the
 *  `args.fetcher ?? fetchBody` default in `fetchAndScan`. */
export async function fetchBody(
	url: string,
	deps: { vet?: typeof assertSafeFetchTarget; fetchOne?: typeof pinnedFetch } = {},
): Promise<string> {
	const vet = deps.vet ?? assertSafeFetchTarget;
	const fetchOne = deps.fetchOne ?? pinnedFetch;
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
		const target = await vet(currentUrl);
		const response = await fetchOne(target);
		if (response.status >= 300 && response.status < 400) {
			if (!response.location) {
				throw new Error(`HTTP ${response.status} redirect without Location header`);
			}
			// Resolve relative redirects against the current URL.
			currentUrl = new URL(response.location, currentUrl).toString();
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`HTTP ${response.status}`);
		}
		return response.body;
	}
	throw new Error(`exceeded ${MAX_REDIRECT_HOPS} redirect hops`);
}
