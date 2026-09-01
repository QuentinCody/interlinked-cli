// Evidence-contract cases for fetch_without_abort_signal (fetch-abort.ts).

import { describe, expect, it } from "vitest";
import { checkFetchWithoutAbortSignal } from "./fetch-abort.js";

const FILE = "/repo/src/lib/client.ts";

describe("checkFetchWithoutAbortSignal — positive (must fire)", () => {
	it("P1: bare single-argument fetch", () => {
		const src = 'const res = await fetch("https://api.example.com/items");\n';
		const out = checkFetchWithoutAbortSignal(src, FILE);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toContain("signal");
	});

	it("P2: options literal with headers but no signal", () => {
		const src = [
			"const res = await fetch(url, {",
			'\tmethod: "POST",',
			"\theaders: { accept: 'application/json' },",
			"\tbody: JSON.stringify(payload),",
			"});",
		].join("\n");
		expect(checkFetchWithoutAbortSignal(src, FILE)).toHaveLength(1);
	});

	it("P3: globalThis.fetch with signal-less options", () => {
		const src = "await globalThis.fetch(url, { method: 'GET' });\n";
		expect(checkFetchWithoutAbortSignal(src, FILE)).toHaveLength(1);
	});
});

describe("checkFetchWithoutAbortSignal — negative (must not fire)", () => {
	it("N1: options carry a signal key", () => {
		const src = "await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });\n";
		expect(checkFetchWithoutAbortSignal(src, FILE)).toEqual([]);
	});

	it("N2: options carry a spread that may hold a signal", () => {
		const src = "await fetch(url, { ...baseOptions, method: 'GET' });\n";
		expect(checkFetchWithoutAbortSignal(src, FILE)).toEqual([]);
	});

	it("N3: non-literal options argument — contents not visible", () => {
		const src = "await fetch(url, requestInit);\n";
		expect(checkFetchWithoutAbortSignal(src, FILE)).toEqual([]);
	});

	it("N4: wrapper method call is not the platform fetch", () => {
		const src = "await client.fetch(url);\nawait this.fetch(url, { method: 'GET' });\n";
		expect(checkFetchWithoutAbortSignal(src, FILE)).toEqual([]);
	});

	it("N5: file defines its own fetch", () => {
		const src = [
			"async function fetch(url: string): Promise<string> {",
			"\treturn url;",
			"}",
			"await fetch('https://example.com');",
		].join("\n");
		expect(checkFetchWithoutAbortSignal(src, FILE)).toEqual([]);
	});

	it("N6: test files are skipped", () => {
		const src = 'await fetch("https://api.example.com");\n';
		expect(checkFetchWithoutAbortSignal(src, "/repo/src/lib/client.test.ts")).toEqual([]);
	});

	it("N7: fetch mentioned in a string or comment only", () => {
		const src = '// call fetch(url) later\nconst doc = "fetch(url)";\n';
		expect(checkFetchWithoutAbortSignal(src, FILE)).toEqual([]);
	});
});
