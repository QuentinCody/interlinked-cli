// ===========================================
// Host class — ONE canonical answer to "where does this host point?"
// ===========================================
// Two consumers ask it from opposite directions (review 3b, 2026-10-05):
//   - the origin-aware taint ratchet (evaluator/public-fetch-stage.ts) treats
//     a fetch as PUBLIC content only when the host is `public`;
//   - the network-intent predicate (network-verbs.ts isPublicHost) treats a
//     peer as external unless the host is `private`.
// `unknown` sits between them, so each consumer fails safe in its own
// direction: names whose resolution is local configuration (single-label,
// `.internal`, `.lan`, …) and numeric-looking hosts that do not parse.
//
// IPv4 is parsed the way inet_aton and the WHATWG URL parser read it: one to
// four parts, each decimal, octal (leading 0) or hex (0x), the last part
// filling the remaining bytes — so `127.1`, `2130706433`, `0x7f000001` and
// `0177.0.0.1` are all loopback.

import { isIP } from "node:net";

export type HostClass = "public" | "private" | "unknown";

/** Name suffixes that never leave the machine (RFC 6761 / mDNS RFC 6762). */
const PRIVATE_NAME_RE = /(?:^|\.)(?:localhost|local)$/;
/** Suffixes resolved by local configuration: the peer is not readable. */
const LOCAL_CONFIG_NAME_RE = /\.(?:internal|lan|home|corp|intranet|localdomain|arpa|private)$/;
const HOSTNAME_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/;
/** WHATWG "ends in a number": the last label is decimal or 0x-hex. */
const NUMERIC_LABEL_RE = /^(?:\d+|0x[0-9a-f]*)$/;
const IPV4_PART_RE = /^(?:0x[0-9a-f]*|0[0-7]*|[1-9]\d*)$/;
const BYTE = 256;
const IPV4_PARTS = 4;
const IPV6_GROUPS = 8;
const GROUP_MAX = 0xffff;
const IPV4_MAPPED_MARK = 0xffff;

function parseIpv4Part(part: string): number | null {
	if (!IPV4_PART_RE.test(part)) return null;
	if (part.startsWith("0x")) return part === "0x" ? 0 : Number.parseInt(part.slice(2), 16);
	if (part.length > 1 && part.startsWith("0")) return Number.parseInt(part.slice(1), 8);
	return Number(part);
}

/** The 32-bit value of an IPv4 host in any inet_aton form, or null. */
export function parseIpv4(host: string): number | null {
	const parts = host.split(".");
	if (parts.length > IPV4_PARTS || parts.some((p) => p === "")) return null;
	let value = 0;
	for (const [i, part] of parts.entries()) {
		const v = parseIpv4Part(part);
		const limit = i === parts.length - 1 ? BYTE ** (IPV4_PARTS + 1 - parts.length) : BYTE;
		if (v === null || v >= limit) return null;
		value = value * limit + v;
	}
	return value;
}

/** IPv4 blocks `[base, prefix bits]` that never reach a public peer. */
const NON_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = [
	[0x00000000, 8], // 0/8 "this network" (0.0.0.0 reaches the local host)
	[0x0a000000, 8], // 10/8 private
	[0x64400000, 10], // 100.64/10 CGNAT / tailnet
	[0x7f000000, 8], // 127/8 loopback
	[0xa9fe0000, 16], // 169.254/16 link-local (cloud metadata)
	[0xac100000, 12], // 172.16/12 private
	[0xc0000000, 24], // 192.0.0/24 IETF protocol assignments
	[0xc0a80000, 16], // 192.168/16 private
	[0xc6120000, 15], // 198.18/15 benchmarking
	[0xe0000000, 4], // 224/4 multicast
	[0xf0000000, 4], // 240/4 reserved, 255.255.255.255 broadcast
];

function classifyIpv4Value(value: number): HostClass {
	const inBlock = ([base, bits]: readonly [number, number]): boolean => {
		const size = 2 ** (32 - bits); // bits ≤ 32, so size ≥ 1
		return Math.floor(value / size) === Math.floor(base / size);
	};
	return NON_PUBLIC_V4.some(inBlock) ? "private" : "public";
}

/** `::ffff:1.2.3.4` → `::ffff:102:304`; null when the tail is not IPv4. */
function expandIpv4Tail(address: string): string | null {
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
	if (!tail) return address;
	const v4 = parseIpv4(tail[1] ?? "");
	if (v4 === null) return null;
	return `${address.slice(0, tail.index)}${Math.floor(v4 / 0x10000).toString(16)}:${(v4 % 0x10000).toString(16)}`;
}

/** Sixteen-bit groups of an IPv6 address, or null. */
function ipv6Groups(address: string): number[] | null {
	const text = expandIpv4Tail(address);
	if (text === null) return null;
	const [head = "", rest] = text.split("::");
	const left = head === "" ? [] : head.split(":");
	const right = rest === undefined || rest === "" ? [] : rest.split(":");
	const fill = rest === undefined ? 0 : Math.max(IPV6_GROUPS - left.length - right.length, 0);
	const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map((g) => Number.parseInt(g, 16));
	const valid = groups.length === IPV6_GROUPS && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= GROUP_MAX);
	return valid ? groups : null;
}

/** First-group prefixes `[value, mask]`: link-local, site-local, unique-local, multicast. */
const NON_PUBLIC_V6_PREFIX: ReadonlyArray<readonly [number, number]> = [
	[0xfe80, 0xffc0],
	[0xfec0, 0xffc0],
	[0xfc00, 0xfe00],
	[0xff00, 0xff00],
];

function classifyIpv6(address: string): HostClass {
	const g = ipv6Groups(address.replace(/%.*$/, ""));
	if (g === null) return "unknown";
	const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
	if (g.slice(0, 5).some((x) => x !== 0)) {
		return NON_PUBLIC_V6_PREFIX.some(([value, mask]) => (g0 & mask) === value) ? "private" : "public";
	}
	if (g5 === 0 && g6 === 0) return g7 <= 1 ? "private" : "public"; // `::` and `::1`
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) carry an IPv4 peer.
	return g5 === IPV4_MAPPED_MARK || g5 === 0 ? classifyIpv4Value(g6 * (GROUP_MAX + 1) + g7) : "public";
}

function classifyName(name: string): HostClass {
	if (PRIVATE_NAME_RE.test(name)) return "private";
	if (!HOSTNAME_RE.test(name) || !name.includes(".") || LOCAL_CONFIG_NAME_RE.test(name)) return "unknown";
	return "public";
}

/** Classify a URL or remote-operand host (brackets allowed, no port, any case). */
export function classifyHost(rawHost: string): HostClass {
	const host = rawHost.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
	if (host === "") return "unknown";
	// A colon in a port-free host means IPv6 (isIP returns 0 for anything else).
	if (host.includes(":")) return isIP(host.replace(/%.*$/, "")) !== 0 ? classifyIpv6(host) : "unknown";
	const lastLabel = host.slice(host.lastIndexOf(".") + 1);
	if (!NUMERIC_LABEL_RE.test(lastLabel)) return classifyName(host);
	const value = parseIpv4(host);
	return value === null ? "unknown" : classifyIpv4Value(value);
}
