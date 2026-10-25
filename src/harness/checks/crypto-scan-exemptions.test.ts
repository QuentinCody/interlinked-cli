import { describe, expect, it } from "vitest";
import { isWeakHashSignatureAt, stringOpensMessageCall, stripWeakHashNonCalls } from "./crypto-scan-exemptions.js";

describe("stringOpensMessageCall", () => {
	it("recognizes logger, error-constructor, and throw prefixes", () => {
		for (const prefix of ["console.warn(", "logger.error( ", "throw new Error(", "raise RuntimeError(", "warnings.warn(", "throw "]) {
			expect(stringOpensMessageCall(`${prefix}"x"`, prefix.length)).toBe(true);
		}
	});

	it("does not treat an exec / spawn argument as a message", () => {
		const line = 'execSync("X=0 node a.js")';
		expect(stringOpensMessageCall(line, line.indexOf('"'))).toBe(false);
		expect(stringOpensMessageCall('  "dev": "X=0 node"', 10)).toBe(false);
	});
});

describe("isWeakHashSignatureAt", () => {
	it("recognizes single-line, multi-line, and nested-paren signatures", () => {
		expect(isWeakHashSignatureAt(["\tmd5(buf: Uint8Array): string {"], 0)).toBe(true);
		expect(isWeakHashSignatureAt(["\tmd5(", "\t\tbuf: Uint8Array,", "\t): string {"], 0)).toBe(true);
		expect(isWeakHashSignatureAt(["\tmd5(d: string, cb: (e: Error) => void): void {"], 0)).toBe(true);
		expect(isWeakHashSignatureAt(["\tabstract sha1(b: Uint8Array): Promise<string>;"], 0)).toBe(true);
	});

	it("does not treat a call statement as a signature", () => {
		expect(isWeakHashSignatureAt(["md5(buf);"], 0)).toBe(false);
		expect(isWeakHashSignatureAt(["md5(", "\tbuf,", ");"], 0)).toBe(false);
		expect(isWeakHashSignatureAt(["const h = md5(buf) {"], 0)).toBe(false);
		expect(isWeakHashSignatureAt(["md5(", "\tbuf,"], 0)).toBe(false);
	});
});

describe("stripWeakHashNonCalls", () => {
	it("removes a TS inline type-literal member but keeps a later real call", () => {
		const line = "type H = { md5(buf: Uint8Array): string }; const x = md5(y);";
		const out = stripWeakHashNonCalls(line, "a.ts");
		expect(out).not.toContain("md5(buf");
		expect(out).toContain("md5(y)");
	});

	it("removes single-line JSX text but keeps a JSX expression call", () => {
		expect(stripWeakHashNonCalls("<p>never md5() here</p>", "a.tsx")).toBe("<p></p>");
		expect(stripWeakHashNonCalls("<p>{md5(x)}</p>", "a.tsx")).toContain("md5(x)");
	});

	it("leaves other languages unchanged", () => {
		expect(stripWeakHashNonCalls("<p>md5() x</p>", "a.py")).toBe("<p>md5() x</p>");
		expect(stripWeakHashNonCalls("{ md5(b): string }", "a.js")).toBe("{ md5(b): string }");
	});
});
