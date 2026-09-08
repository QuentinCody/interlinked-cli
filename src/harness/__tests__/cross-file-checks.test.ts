import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkCrossFileSwitchDiscriminant,
	checkSingleImplementationInterface,
	lineOfOffset,
} from "../cross-file-checks.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol } from "../types.js";

// Minimal fake ProjectGraph — implements only the methods the checks call.
function makeGraph(
	files: string[],
	exportsByFile: Record<string, ExportedSymbol[]> = {},
): Pick<ProjectGraph, "allFiles" | "toRelative" | "getExports"> {
	return {
		allFiles: () => files,
		toRelative: (p: string) => p.split("/").slice(-2).join("/"),
		getExports: (p: string) => exportsByFile[p] ?? [],
	};
}

describe("checkCrossFileSwitchDiscriminant", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xfile-switch-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags the edited file when the same discriminant appears elsewhere", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kind) { case 'B': return 2; } }");
		const graph = makeGraph([a, b]);
		const results = checkCrossFileSwitchDiscriminant(
			a,
			"a.ts",
			graph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).check).toBe("cross_file_switch_discriminant");
	});

	it("does not flag when discriminant appears only in the edited file", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g() { return 2; }");
		const graph = makeGraph([a, b]);
		expect(
			checkCrossFileSwitchDiscriminant(a, "a.ts", graph),
		).toEqual([]);
	});

	it("ignores discriminants that do not end in kind/type/tag/variant", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "switch (x.status) { case 1: break; }");
		writeFileSync(b, "switch (x.status) { case 2: break; }");
		const graph = makeGraph([a, b]);
		expect(
			checkCrossFileSwitchDiscriminant(a, "a.ts", graph),
		).toEqual([]);
	});

	it("returns [] when the edited file itself cannot be read (safeRead catch)", () => {
		const missing = join(dir, "nope.ts");
		const graph = makeGraph([missing]);
		expect(
			checkCrossFileSwitchDiscriminant(missing, "nope.ts", graph),
		).toEqual([]);
	});

	it("skips other files that cannot be read without throwing", () => {
		const a = join(dir, "a.ts");
		const missingOther = join(dir, "gone.ts"); // listed in the graph but never written
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		const graph = makeGraph([a, missingOther]);
		expect(
			checkCrossFileSwitchDiscriminant(a, "a.ts", graph),
		).toEqual([]);
	});

	it("caps at 5 other files and lists only the first 3 with an ellipsis", () => {
		const a = join(dir, "a.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		const others: string[] = [];
		for (let i = 0; i < 6; i++) {
			const p = join(dir, `other${i}.ts`);
			writeFileSync(p, `function g${i}(x) { switch (x.kind) { case 'X': return ${i}; } }`);
			others.push(p);
		}
		const graph = makeGraph([a, ...others]);
		const results = checkCrossFileSwitchDiscriminant(
			a,
			"a.ts",
			graph,
		);
		expect(results.length).toBe(1);
		const result = nonNull(results[0]);
		// otherFiles.length >= 5 breaks the scan early, so only 5 of the 6 are recorded.
		expect(result.affectedFiles).toHaveLength(5);
		expect(result.message).toContain(", …");
	});
});

describe("lineOfOffset", () => {
	it("returns 1 for an offset on the first line", () => {
		expect(lineOfOffset("abcdef", 3)).toBe(1);
	});

	it("returns the 1-based line number after N newlines", () => {
		expect(lineOfOffset("one\ntwo\nthree", 5)).toBe(2);
	});

	it("counts every newline strictly before the offset", () => {
		expect(lineOfOffset("one\ntwo\nthree", 9)).toBe(3);
	});
});

describe("checkSingleImplementationInterface", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "single-impl-"));
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
		const graph = makeGraph([iface, impl], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"shape.ts",
			graph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).check).toBe("single_implementation_interface");
	});

	it("passes interface with multiple implementors", () => {
		const iface = join(dir, "shape.ts");
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(a, "class A implements Shape { area() { return 1; } }");
		writeFileSync(b, "class B implements Shape { area() { return 2; } }");
		const graph = makeGraph([iface, a, b], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		expect(
			checkSingleImplementationInterface(iface, "shape.ts", graph),
		).toEqual([]);
	});

	it("passes interface with zero implementors", () => {
		const iface = join(dir, "shape.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		const graph = makeGraph([iface], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		expect(
			checkSingleImplementationInterface(iface, "shape.ts", graph),
		).toEqual([]);
	});

	it("returns [] when the file's exports contain no interfaces at all", () => {
		const mod = join(dir, "util.ts");
		writeFileSync(mod, "export function helper() { return 1; }");
		const graph = makeGraph([mod], {
			[mod]: [{ name: "helper", kind: "function", isTypeOnly: false, line: 1 }],
		});
		expect(
			checkSingleImplementationInterface(mod, "util.ts", graph),
		).toEqual([]);
	});

	it("ignores a file whose implements/extends clause names an unrelated symbol", () => {
		const iface = join(dir, "shape.ts");
		const impl = join(dir, "square.ts");
		const unrelated = join(dir, "widget.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(
			impl,
			"import type { Shape } from './shape'; class Square implements Shape { area() { return 4; } }",
		);
		// Implements a DIFFERENT interface — mentionsAsImpl(oc, "Shape") must be
		// false here (names.includes("Shape") false-branch), so this file is not
		// counted as a Shape implementor and the single-implementor verdict holds.
		writeFileSync(unrelated, "class Widget implements Gadget { render() {} }");
		const graph = makeGraph([iface, impl, unrelated], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"shape.ts",
			graph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).affectedFiles).toEqual([impl]);
	});

	it("skips other files that cannot be read while still finding the real implementor", () => {
		const iface = join(dir, "shape.ts");
		const impl = join(dir, "square.ts");
		const missingOther = join(dir, "ghost.ts"); // in the graph but never written
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(
			impl,
			"import type { Shape } from './shape'; class Square implements Shape { area() { return 4; } }",
		);
		const graph = makeGraph([iface, impl, missingOther], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"shape.ts",
			graph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).affectedFiles).toEqual([impl]);
	});
});
