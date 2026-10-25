// Independent adversarial FP review (2026-10-21) for the pre_block check
// `cookie_missing_security_flags`. Every negative below is an idiomatic
// Express / `cookie`-package shape that fired before the detector learned to
// accept a non-false `secure:` expression, resolve same-file option objects
// and serialized header values, ignore a `cookies` Map, and ignore string
// literals that merely mention the call.
// Probe: scratch/2026-10-21-adversarial/cookie_missing_security_flags.probe.mts

import { describe, expect, it } from "vitest";
import { checkCookieMissingSecurityFlags } from "../../checks/ubs-language-specific/js-security-checks.js";

describe("cookie_missing_security_flags — negative (must not fire)", () => {
	it("N1: secure gated on NODE_ENV (the Express localhost-vs-prod idiom)", () => {
		const code = [
			"res.cookie('sid', token, {",
			"  httpOnly: true,",
			"  secure: process.env.NODE_ENV === 'production',",
			"  sameSite: 'lax',",
			"});",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/auth.ts")).toEqual([]);
	});

	it("N2: shared options object declared in the same file, passed by identifier", () => {
		const code = [
			"const SESSION_COOKIE = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };",
			"export function issue(res, token) {",
			"  res.cookie('sid', token, SESSION_COOKIE);",
			"}",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/session.ts")).toEqual([]);
	});

	it("N3: spread of a same-file secure base object plus a computed maxAge", () => {
		const code = [
			"const base = { httpOnly: true, secure: true, sameSite: 'strict' };",
			"export function issue(res, token, ttl) {",
			"  res.cookie('sid', token, { ...base, maxAge: ttl });",
			"}",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/session2.ts")).toEqual([]);
	});

	it("N4: Set-Cookie header set from a serialize() result held in a same-file const", () => {
		const code = [
			"import { serialize } from 'cookie';",
			"export function login(req, res, token) {",
			"  const cookie = serialize('sid', token, {",
			"    httpOnly: true,",
			"    secure: true,",
			"    sameSite: 'lax',",
			"    path: '/',",
			"  });",
			"  res.setHeader('Set-Cookie', cookie);",
			"}",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/login.ts")).toEqual([]);
	});

	it("N5: `cookies` is a Map built while parsing a Cookie header", () => {
		const code = [
			"export function parseCookies(header: string) {",
			"  const cookies = new Map<string, string>();",
			"  for (const part of header.split(';')) {",
			"    const [k, v] = part.trim().split('=');",
			"    if (k) cookies.set(k, decodeURIComponent(v ?? ''));",
			"  }",
			"  return cookies;",
			"}",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/parse-cookies.ts")).toEqual([]);
	});

	it("N6: a string literal that merely mentions the call (lint message)", () => {
		const code =
			"export const hint = 'use res.cookie(name, value, { httpOnly: true, secure: true }) not res.cookie(name, value)';";
		expect(checkCookieMissingSecurityFlags(code, "src/messages.ts")).toEqual([]);
	});

	it("N7: secure gated on a same-file boolean const", () => {
		const code = [
			"const isProd = process.env.NODE_ENV === 'production';",
			"export function issue(res, token) {",
			"  res.cookie('sid', token, { httpOnly: true, secure: isProd, sameSite: 'lax' });",
			"}",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/auth2.ts")).toEqual([]);
	});

	it("N8: Set-Cookie header set from an array of same-file serialized consts", () => {
		const code = [
			"import { serialize } from 'cookie';",
			"const access = serialize('at', at, { httpOnly: true, secure: true });",
			"const refresh = serialize('rt', rt, { httpOnly: true, secure: true, path: '/refresh' });",
			"res.setHeader('Set-Cookie', [access, refresh]);",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/login2.ts")).toEqual([]);
	});
});

describe("cookie_missing_security_flags — positive (must fire)", () => {
	it("P1: inline options omit secure", () => {
		const code = "res.cookie('sid', token, { httpOnly: true });";
		expect(checkCookieMissingSecurityFlags(code, "src/bad.ts").length).toBe(1);
	});

	it("P2: secure: false is an explicit opt-out, not a declaration", () => {
		const code = "res.cookie('sid', token, { httpOnly: true, secure: false });";
		expect(checkCookieMissingSecurityFlags(code, "src/bad2.ts").length).toBe(1);
	});

	it("P3: a same-file const options object that lacks secure", () => {
		const code = [
			"const OPTS = { httpOnly: true, sameSite: 'lax' };",
			"res.cookie('sid', token, OPTS);",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/bad3.ts").length).toBe(1);
	});

	it("P4: a Set-Cookie header from a same-file const whose serialize options lack both flags", () => {
		const code = [
			"const cookie = serialize('sid', token, { path: '/' });",
			"res.setHeader('Set-Cookie', cookie);",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/bad4.ts").length).toBe(1);
	});

	it("P5: a spread of a same-file base that lacks secure", () => {
		const code = [
			"const base = { httpOnly: true, sameSite: 'lax' };",
			"res.cookie('sid', token, { ...base, maxAge: 1000 });",
		].join("\n");
		expect(checkCookieMissingSecurityFlags(code, "src/bad5.ts").length).toBe(1);
	});

	it("P6: cookies.set(name, value) with no options and no Map binding", () => {
		const code = "cookies.set('sid', token);";
		expect(checkCookieMissingSecurityFlags(code, "src/bad6.ts").length).toBe(1);
	});
});
