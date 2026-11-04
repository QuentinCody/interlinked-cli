import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { runVerifyParityChecks } from "../verify-parity.js";

describe("verify-parity: scanProjectSwitchDiscriminants", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verify-parity-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags same discriminant switched in two files", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kind) { case 'B': return 2; } }");
		const r = runVerifyParityChecks([a, b]);
		expect(r.crossFileSwitchDiscriminant.length).toBe(2);
		expect(new Set(r.crossFileSwitchDiscriminant.map((x) => x.file))).toEqual(new Set([a, b]));
	});

	it("ignores discriminant appearing in only one file", () => {
		const a = join(dir, "a.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		const r = runVerifyParityChecks([a]);
		expect(r.crossFileSwitchDiscriminant).toEqual([]);
	});

    it.each([
        ["oversized", "//" + "x".repeat(256 * 1024) + "\n"],
        ["generated", "// @generated\n"],
        ["codegen data", "// @codegen-data\n"],
    ])("excludes %s source from cross-file parity analysis", (_label, prefix) => {
        const ordinary = join(dir, "ordinary.ts");
        const excluded = join(dir, "excluded.ts");
        const source = "function f(x) { switch (x.kind) { case 'A': return 1; } }";
        writeFileSync(ordinary, source);
        writeFileSync(excluded, prefix + source);
        const result = runVerifyParityChecks([ordinary, excluded]);
        expect(result.crossFileSwitchDiscriminant).toEqual([]);
        expect(result.filesWithoutTest.map(finding => finding.file)).toEqual([ordinary]);
    });

	it("ignores non-discriminant switches (e.g., x.status)", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "switch (x.status) { case 1: break; }");
		writeFileSync(b, "switch (x.status) { case 2: break; }");
		const r = runVerifyParityChecks([a, b]);
		expect(r.crossFileSwitchDiscriminant).toEqual([]);
	});
});

describe("verify-parity: scanProjectSingleImplInterfaces", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verify-parity-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags interface with exactly one implementor", () => {
		const iface = join(dir, "shape.ts");
		const impl = join(dir, "square.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(
			impl,
			"import type { Shape } from './shape'; class Square implements Shape { area() { return 4; } }",
		);
		const r = runVerifyParityChecks([iface, impl]);
		expect(r.singleImplementationInterface.length).toBe(1);
	});

	it("passes interface with two implementors", () => {
		const iface = join(dir, "shape.ts");
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(a, "class A implements Shape { area() { return 1; } }");
		writeFileSync(b, "class B implements Shape { area() { return 2; } }");
		const r = runVerifyParityChecks([iface, a, b]);
		expect(r.singleImplementationInterface).toEqual([]);
	});
});

describe("verify-parity: scanFilesWithoutTest", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verify-parity-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags prod file with no sibling test", () => {
		const prod = join(dir, "foo.ts");
		writeFileSync(prod, "export const x = 1;");
		const r = runVerifyParityChecks([prod]);
		expect(r.filesWithoutTest.length).toBe(1);
		expect(nonNull(r.filesWithoutTest[0]).file).toBe(prod);
	});

	it("passes when sibling test exists", () => {
		const prod = join(dir, "foo.ts");
		const test = join(dir, "foo.test.ts");
		writeFileSync(prod, "export const x = 1;");
		writeFileSync(test, "it('x', () => {});");
		const r = runVerifyParityChecks([prod, test]);
		expect(r.filesWithoutTest).toEqual([]);
	});

	it("does not flag the test file itself", () => {
		const test = join(dir, "foo.test.ts");
		writeFileSync(test, "it('x', () => {});");
		const r = runVerifyParityChecks([test]);
		expect(r.filesWithoutTest).toEqual([]);
	});
});

describe("verify-parity: computeProjectLocRatio", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "verify-parity-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports exceeded=true when ratio > 5", () => {
		const prod = join(dir, "foo.ts");
		const test = join(dir, "foo.test.ts");
		writeFileSync(prod, "a\n".repeat(100));
		writeFileSync(test, "a\n".repeat(10));
		const r = runVerifyParityChecks([prod, test]);
		expect(r.projectLocRatio?.exceeded).toBe(true);
	});

	it("reports exceeded=false when ratio healthy", () => {
		const prod = join(dir, "foo.ts");
		const test = join(dir, "foo.test.ts");
		writeFileSync(prod, "a\n".repeat(50));
		writeFileSync(test, "a\n".repeat(30));
		const r = runVerifyParityChecks([prod, test]);
		expect(r.projectLocRatio?.exceeded).toBe(false);
	});

	it("returns null when no JS/TS files", () => {
		const r = runVerifyParityChecks([]);
		expect(r.projectLocRatio).toBe(null);
	});
});
