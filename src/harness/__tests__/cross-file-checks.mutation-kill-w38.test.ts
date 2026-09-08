import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol } from "../types.js";

// `vi.spyOn(fsModule, "readFileSync")` can't redefine a live ESM named export
// (Vitest/Node throw "Cannot redefine property"), so route the call-count spy
// through a mocked module instead — same spy-through pattern used elsewhere
// in this suite (see scratchpad-archive.mutation-kill-w38.test.ts).
const readFileSyncSpy = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			readFileSyncSpy(...args);
			return actual.readFileSync(...args);
		},
	};
});

const { checkCrossFileSwitchDiscriminant, checkSingleImplementationInterface } = await import(
	"../cross-file-checks.js"
);

// Minimal fake ProjectGraph, matching the companion test file's shape.
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

describe("checkCrossFileSwitchDiscriminant — exact message format", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xfile-msg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — pins the full message shape (severity, join
	// separator, no-ellipsis branch) against every string/conditional mutant.
	it("produces the exact message and result shape with 2 other files (no ellipsis)", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		const c = join(dir, "c.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kind) { case 'B': return 2; } }");
		writeFileSync(c, "function h(x) { switch (x.kind) { case 'C': return 3; } }");
		const graph = makeGraph([a, b, c]);
		const results = checkCrossFileSwitchDiscriminant(a, "a.ts", graph);
		const relB = graph.toRelative(b);
		const relC = graph.toRelative(c);
		expect(results).toEqual([
			{
				check: "cross_file_switch_discriminant",
				severity: "warning",
				message: `a.ts switches on \`x.kind\` — also seen in 2 other file(s): ${relB}, ${relC}. Consider a polymorphic dispatch or strategy registry.`,
				file: a,
				affectedFiles: [b, c],
			},
		]);
	});

	// test-contract: public-api — pins the `> 3` vs `>= 3` boundary: exactly 3
	// other files must NOT trigger the ellipsis branch.
	it("produces the exact message with exactly 3 other files (still no ellipsis)", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		const c = join(dir, "c.ts");
		const d = join(dir, "d.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kind) { case 'B': return 2; } }");
		writeFileSync(c, "function h(x) { switch (x.kind) { case 'C': return 3; } }");
		writeFileSync(d, "function i(x) { switch (x.kind) { case 'D': return 4; } }");
		const graph = makeGraph([a, b, c, d]);
		const results = checkCrossFileSwitchDiscriminant(a, "a.ts", graph);
		const relB = graph.toRelative(b);
		const relC = graph.toRelative(c);
		const relD = graph.toRelative(d);
		expect(results).toEqual([
			{
				check: "cross_file_switch_discriminant",
				severity: "warning",
				message: `a.ts switches on \`x.kind\` — also seen in 3 other file(s): ${relB}, ${relC}, ${relD}. Consider a polymorphic dispatch or strategy registry.`,
				file: a,
				affectedFiles: [b, c, d],
			},
		]);
	});

	// test-contract: public-api — pins the slice-to-3 display cap (message text)
	// against the full affectedFiles list (4 entries) when the ellipsis fires.
	it("caps the displayed names at 3 but keeps all 4 in affectedFiles when >3 match", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		const c = join(dir, "c.ts");
		const d = join(dir, "d.ts");
		const e = join(dir, "e.ts");
		writeFileSync(a, "function f(x) { switch (x.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kind) { case 'B': return 2; } }");
		writeFileSync(c, "function h(x) { switch (x.kind) { case 'C': return 3; } }");
		writeFileSync(d, "function i(x) { switch (x.kind) { case 'D': return 4; } }");
		writeFileSync(e, "function j(x) { switch (x.kind) { case 'E': return 5; } }");
		const graph = makeGraph([a, b, c, d, e]);
		const results = checkCrossFileSwitchDiscriminant(a, "a.ts", graph);
		const relB = graph.toRelative(b);
		const relC = graph.toRelative(c);
		const relD = graph.toRelative(d);
		expect(results).toEqual([
			{
				check: "cross_file_switch_discriminant",
				severity: "warning",
				message: `a.ts switches on \`x.kind\` — also seen in 4 other file(s): ${relB}, ${relC}, ${relD}, …. Consider a polymorphic dispatch or strategy registry.`,
				file: a,
				affectedFiles: [b, c, d, e],
			},
		]);
	});
});

describe("checkCrossFileSwitchDiscriminant — regex robustness", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xfile-regex-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: bug — a discriminant that merely CONTAINS "kind" (e.g.
	// `kindOfThing`) must not match the tail anchor; guards a false-positive class.
	it("does not treat a property whose name merely contains 'kind' as a discriminant", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(x) { switch (x.kindOfThing) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kindOfThing) { case 'B': return 2; } }");
		const graph = makeGraph([a, b]);
		expect(
			checkCrossFileSwitchDiscriminant(a, "a.ts", graph),
		).toEqual([]);
	});

	// test-contract: boundary — extra whitespace directly inside the switch
	// parens (both after `(` and before `)`) must still be tolerated.
	it("still matches a switch discriminant with extra space inside the parens", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(x) { switch ( x.kind ) { case 'A': return 1; } }");
		writeFileSync(b, "function g(x) { switch (x.kind) { case 'B': return 2; } }");
		const graph = makeGraph([a, b]);
		const results = checkCrossFileSwitchDiscriminant(a, "a.ts", graph);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).check).toBe("cross_file_switch_discriminant");
	});

	// test-contract: boundary — a multi-character property name segment before
	// the dot (e.g. `myObj.kind`, not just `x.kind`) must still be captured.
	it("matches a discriminant whose object identifier has more than one character", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(y) { switch (myObj.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(y) { switch (myObj.kind) { case 'B': return 2; } }");
		const graph = makeGraph([a, b]);
		const results = checkCrossFileSwitchDiscriminant(a, "a.ts", graph);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).affectedFiles).toEqual([b]);
	});

	// test-contract: boundary — two dotted segments (e.g. `obj.state.kind`) must
	// still be captured by the repeated `(?:\.ident)+` group.
	it("matches a discriminant with two dotted segments before the tail", () => {
		const a = join(dir, "a.ts");
		const b = join(dir, "b.ts");
		writeFileSync(a, "function f(y) { switch (obj.state.kind) { case 'A': return 1; } }");
		writeFileSync(b, "function g(y) { switch (obj.state.kind) { case 'B': return 2; } }");
		const graph = makeGraph([a, b]);
		const results = checkCrossFileSwitchDiscriminant(a, "a.ts", graph);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).affectedFiles).toEqual([b]);
	});
});

describe("checkSingleImplementationInterface — regex + logic robustness", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "single-impl-w38-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	// test-contract: boundary — a comma-separated implements clause
	// (`implements Foo, Widget`) must still resolve "Widget" as an implementor,
	// including trimming the leading space off the split name.
	it("resolves a comma-separated implements clause and trims the split names", () => {
		const iface = join(dir, "widget.ts");
		const impl = join(dir, "square.ts");
		writeFileSync(iface, "export interface Widget { area(): number; }");
		writeFileSync(
			impl,
			"import type { Widget } from './widget'; class Square implements Foo, Widget { area() { return 4; } }",
		);
		const graph = makeGraph([iface, impl], {
			[iface]: [{ name: "Widget", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"widget.ts",
			graph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).affectedFiles).toEqual([impl]);
	});

	// test-contract: public-api — pins the exact severity and message template
	// (including the parenthesized relative-path substitution) for this check.
	it("produces the exact severity and message for a single-implementor interface", () => {
		const iface = join(dir, "shape.ts");
		const impl = join(dir, "square.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(impl, "class Square implements Shape { area() { return 4; } }");
		const graph = makeGraph([iface, impl], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"shape.ts",
			graph,
		);
		const relImpl = graph.toRelative(impl);
		expect(results).toEqual([
			{
				check: "single_implementation_interface",
				severity: "info",
				message: `Interface \`Shape\` has exactly one implementor (${relImpl}). Premature abstraction? Consider inlining or making it concrete.`,
				file: iface,
				affectedFiles: [impl],
			},
		]);
	});

	// test-contract: boundary — an implements clause with NO whitespace at all
	// around the comma (`Foo,Widget`) must still resolve "Widget".
	it("resolves an implements clause with no whitespace around the comma", () => {
		const iface = join(dir, "widget.ts");
		const impl = join(dir, "square.ts");
		writeFileSync(iface, "export interface Widget { area(): number; }");
		writeFileSync(impl, "class Square implements Foo,Widget { area() { return 4; } }");
		const graph = makeGraph([iface, impl], {
			[iface]: [{ name: "Widget", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"widget.ts",
			graph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).affectedFiles).toEqual([impl]);
	});

	// test-contract: boundary — `\s+` between "implements" and the name must
	// tolerate MORE than one whitespace character, not exactly one.
	it("resolves an implements clause with two spaces before the interface name", () => {
		const iface = join(dir, "widget.ts");
		const impl = join(dir, "square.ts");
		writeFileSync(iface, "export interface Widget { area(): number; }");
		writeFileSync(impl, "class Square implements  Widget { area() { return 4; } }");
		const graph = makeGraph([iface, impl], {
			[iface]: [{ name: "Widget", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		const results = checkSingleImplementationInterface(
			iface,
			"widget.ts",
			graph,
		);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).affectedFiles).toEqual([impl]);
	});

	// test-contract: invariant — only true `kind === "interface"` exports may be
	// treated as candidate interfaces; a function export must never masquerade
	// as one even if some other file's implements clause happens to name it.
	it("does not treat a non-interface export as a candidate interface", () => {
		const mod = join(dir, "mod.ts");
		const other = join(dir, "helperImpl.ts");
		writeFileSync(mod, "export function Helper() { return 1; }");
		writeFileSync(other, "class C implements Helper {}");
		const graph = makeGraph([mod, other], {
			[mod]: [{ name: "Helper", kind: "function", isTypeOnly: false, line: 1 }],
		});
		expect(
			checkSingleImplementationInterface(mod, "mod.ts", graph),
		).toEqual([]);
	});

	// test-contract: invariant — the file declaring the interface must be
	// excluded from its own implementor search, even when its own text happens
	// to contain an "implements <SameName>" mention.
	it("excludes the interface's own file from the implementor count", () => {
		const iface = join(dir, "shape.ts");
		const impl = join(dir, "square.ts");
		writeFileSync(
			iface,
			"export interface Shape { area(): number; } class Weird implements Shape {}",
		);
		writeFileSync(impl, "class Square implements Shape {}");
		const graph = makeGraph([iface, impl], {
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

	// test-contract: boundary — once more than one implementor is found the
	// scan must stop (break), not keep reading every remaining file in the graph.
	it("stops reading files once a second implementor is found", () => {
		const iface = join(dir, "shape.ts");
		const a = join(dir, "a-impl.ts");
		const b = join(dir, "b-impl.ts");
		const c = join(dir, "c-extra.ts");
		const d = join(dir, "d-extra.ts");
		writeFileSync(iface, "export interface Shape { area(): number; }");
		writeFileSync(a, "class A implements Shape { area() { return 1; } }");
		writeFileSync(b, "class B implements Shape { area() { return 2; } }");
		writeFileSync(c, "class C {}");
		writeFileSync(d, "class D {}");
		const graph = makeGraph([iface, a, b, c, d], {
			[iface]: [{ name: "Shape", kind: "interface", isTypeOnly: false, line: 1 }],
		});
		readFileSyncSpy.mockClear();
		const results = checkSingleImplementationInterface(
			iface,
			"shape.ts",
			graph,
		);
		// Two real implementors -> not exactly 1 -> no finding is emitted.
		expect(results).toEqual([]);
		// Only `a` and `b` should be read before the >1-implementor break fires;
		// `c` and `d` (after `b` in file order) must never be touched.
		expect(readFileSyncSpy).toHaveBeenCalledTimes(2);
		expect(readFileSyncSpy).toHaveBeenNthCalledWith(1, a, "utf-8");
		expect(readFileSyncSpy).toHaveBeenNthCalledWith(2, b, "utf-8");
	});
});
