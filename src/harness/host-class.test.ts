import { describe, expect, it } from "vitest";
import { classifyHost, parseIpv4 } from "./host-class.js";

const classes = (hosts: readonly string[]): string[] => hosts.map(classifyHost);

describe("parseIpv4 — every inet_aton form", () => {
	it("P1: dotted, short, single decimal, hex and octal forms parse to the same value", () => {
		const loopback = 0x7f000001;
		expect(["127.0.0.1", "127.1", "127.0.1", "2130706433", "0x7f000001", "0x7f.1", "0177.0.0.1", "0177.0.0.01"].map(parseIpv4)).toEqual(
			Array(8).fill(loopback),
		);
	});
	it("N1: out-of-range parts, bad digits and too many parts do not parse", () => {
		expect(["256.0.0.1", "1.2.3.4.5", "08.1.1.1", "0x1g", "1..2", "4294967296", "1.16777216"].map(parseIpv4)).toEqual(Array(7).fill(null));
	});
});

describe("classifyHost — positive (public)", () => {
	it("P2: ordinary names, public IPv4 in any form, documentation ranges, public IPv6", () => {
		expect(classes(["example.com", "WWW.YouTube.com.", "8.8.8.8", "134744072", "203.0.113.9", "[2606:4700:4700::1111]", "2001:db8::1"])).toEqual(
			Array(7).fill("public"),
		);
	});
});

describe("classifyHost — negative (private: never leaves the machine or LAN)", () => {
	it("N2: loopback, RFC 1918, CGNAT, link-local, unspecified, multicast, broadcast in any IPv4 form", () => {
		const hosts = ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "10.1.2.3", "192.168.0.4", "172.31.255.1", "100.64.0.1", "169.254.169.254", "0.0.0.0", "0", "224.0.0.251", "255.255.255.255"];
		expect(classes(hosts)).toEqual(Array(hosts.length).fill("private"));
	});
	it("N3: IPv6 loopback, unspecified, v4-mapped loopback, link-local, unique-local, multicast; localhost names", () => {
		const hosts = ["::1", "[::1]", "::", "::ffff:127.0.0.1", "[::ffff:7f00:1]", "fe80::1%en0", "fd12:3456::1", "ff02::1", "localhost", "api.localhost", "printer.local"];
		expect(classes(hosts)).toEqual(Array(hosts.length).fill("private"));
	});
});

describe("classifyHost — negative (unknown: resolution is local configuration, or the host does not parse)", () => {
	it("N4: single-label names, local-config suffixes, unparsable numeric hosts, garbage", () => {
		const hosts = ["intranet", "svc.internal", "nas.lan", "box.home.arpa", "999.1.1.1", "1.2.3.4.5", "08.1.1.1", "ex$ample.com", "", "[zz::1]"];
		expect(classes(hosts)).toEqual(Array(hosts.length).fill("unknown"));
	});
});
