import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectTypePredicateDrift } from "./type-predicate-drift.js";

const F = "src/x.ts";

describe("detectTypePredicateDrift — positive (must fire)", () => {
	it("P1: guard checks two of three required properties", () => {
		const src = `
interface Foo {
	name: string;
	count: number;
	owner: string;
}
function isFoo(v: unknown): v is Foo {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return typeof o.name === "string" && typeof o.count === "number";
}
`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("unchecked: owner");
	});

	it("P2: the real RpcError shape — `id` is required and never checked", () => {
		const src = `
export interface RpcError {
	id: string;
	error: { code: string; message: string; recoverable: boolean };
}
export function isError(msg: unknown): msg is RpcError {
	return typeof (msg as RpcError).error === "object" && (msg as RpcError).error !== null;
}
`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("unchecked: id");
	});

	it("P3: object-literal `type` alias, not just `interface`", () => {
		const src = `
type Job = {
	kind: string;
	riskTier: string;
	timeoutMs: number;
};
function isJob(v: unknown): v is Job {
	const o = v as Record<string, unknown>;
	return typeof o.kind === "string" && typeof o.timeoutMs === "number";
}
`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("unchecked: riskTier");
	});

	it("P4: a `readonly` required member is still required", () => {
		const src = `
interface Rec {
	readonly id: string;
	readonly seq: number;
	label: string;
}
function isRec(v: unknown): v is Rec {
	const o = v as Record<string, unknown>;
	return typeof o.id === "string" && typeof o.label === "string";
}
`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("unchecked: seq");
	});

	it("P5: reports only the drifting guard when a complete one sits beside it", () => {
		const src = `
interface A { a: string; b: string; }
interface B { c: string; d: string; }
function isA(v: unknown): v is A {
	const o = v as Record<string, unknown>;
	return typeof o.a === "string" && typeof o.b === "string";
}
function isB(v: unknown): v is B {
	const o = v as Record<string, unknown>;
	return typeof o.c === "string";
}
`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("isB");
		expect(out[0]?.text).toContain("unchecked: d");
	});
});

describe("detectTypePredicateDrift — negative (must not fire)", () => {
	it("N1: guard checks every required property", () => {
		const src = `
interface Foo { name: string; count: number; }
function isFoo(v: unknown): v is Foo {
	const o = v as Record<string, unknown>;
	return typeof o.name === "string" && typeof o.count === "number";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N2: the unchecked property is OPTIONAL", () => {
		const src = `
interface Foo { name: string; count: number; note?: string; }
function isFoo(v: unknown): v is Foo {
	const o = v as Record<string, unknown>;
	return typeof o.name === "string" && typeof o.count === "number";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N3: the type has fewer than two required properties", () => {
		const src = `
interface Foo { name: string; }
function isFoo(v: unknown): v is Foo {
	const o = v as Record<string, unknown>;
	return typeof o === "object";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N4: guard runs no runtime shape test (discriminant/delegation only)", () => {
		const src = `
interface Foo { name: string; count: number; }
function isFoo(v: unknown): v is Foo {
	return validateFoo(v);
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N5: guard mentions none of the required properties — delegating, not drifting", () => {
		const src = `
interface Foo { name: string; count: number; }
function isFoo(v: unknown): v is Foo {
	return typeof v === "object" && v !== null && schema.check(v);
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N6: the asserted type is neither declared here nor resolvable (import target absent)", () => {
		const src = `
import type { Foo } from "./foo.js";
function isFoo(v: unknown): v is Foo {
	const o = v as Record<string, unknown>;
	return typeof o.name === "string";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N7: destructured access counts as checking the field", () => {
		const src = `
interface Foo { name: string; count: number; owner: string; }
function isFoo(v: unknown): v is Foo {
	const { name, count, owner } = v as Foo;
	return typeof name === "string" && typeof count === "number" && typeof owner === "string";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N8: an interface that `extends` is skipped — parent members are invisible here", () => {
		const src = `
interface Base { id: string; }
interface Foo extends Base { name: string; count: number; }
function isFoo(v: unknown): v is Foo {
	const o = v as Record<string, unknown>;
	return typeof o.name === "string";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N9: test files are exempt", () => {
		const src = `
interface Foo { name: string; count: number; }
function isFoo(v: unknown): v is Foo {
	const o = v as Record<string, unknown>;
	return typeof o.name === "string";
}
`;
		expect(detectTypePredicateDrift(src, "src/x.test.ts")).toEqual([]);
	});

	it("N10: non-TypeScript files are exempt", () => {
		const src = `
interface Foo { name: string; count: number; }
function isFoo(v) { return typeof v.name === "string"; }
`;
		expect(detectTypePredicateDrift(src, "src/x.js")).toEqual([]);
	});

	it("N11: an index signature is not a required named property", () => {
		const src = `
interface Bag { [key: string]: unknown; }
function isBag(v: unknown): v is Bag {
	return typeof v === "object" && v !== null;
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N15: an interface whose opening brace never closes yields an unresolvable shape", () => {
		// `matchBrace` scans from the interface's own `{` and returns -1 when
		// depth never returns to 0 — here the interface body runs straight
		// into the function's own `{` without a closing `}` of its own, so
		// depth never rebalances even though the FUNCTION body (opened later,
		// scanned independently) closes cleanly. collectDeclaredShapes then
		// never registers "Foo", so the predicate's target type is unresolvable
		// and evaluatePredicateSite bails before comparing any properties —
		// were matchBrace to instead report a false close, "count" would read
		// as required-and-unchecked and this would report a finding.
		const src = `
interface Foo {
	name: string;
	count: number;
function isFoo(v: unknown): v is Foo {
	const o = v as Record<string, unknown>;
	return typeof o.name === "string";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});
});

describe("detectTypePredicateDrift — bounds", () => {
	it("caps output at 10 findings per file", () => {
		const blocks = Array.from({ length: 14 }, (_, i) => {
			return `interface T${i} { a${i}: string; b${i}: string; }
function is${i}(v: unknown): v is T${i} {
	const o = v as Record<string, unknown>;
	return typeof o.a${i} === "string";
}`;
		}).join("\n");
		expect(detectTypePredicateDrift(blocks, F)).toHaveLength(10);
	});

	it("returns [] for a file containing no predicates at all", () => {
		expect(detectTypePredicateDrift("export const x = 1;\n", F)).toEqual([]);
	});
});

// Widening (R2-5, 2026-08-10): arrow-form predicates and one-hop cross-file
// type resolution through RELATIVE import specifiers. Both were documented
// false-negative lanes; `import { Foo } from "./types.js"` + `v is Foo` is the
// most common real-world predicate shape, so same-file-only made the drift-0
// ratchet narrower than its rhetoric.
describe("detectTypePredicateDrift — widening (arrow + cross-file)", () => {
	it("P6: arrow predicate with block body drifts like a function declaration", () => {
		const src = `
interface Pair { left: string; right: string; }
const isPair = (v: unknown): v is Pair => {
	const o = v as Record<string, unknown>;
	return typeof o.left === "string";
};
`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("right");
	});

	it("P7: arrow predicate with EXPRESSION body drifts too", () => {
		const src = `
interface Pair { left: string; right: string; }
const isPair = (v: unknown): v is Pair =>
	typeof (v as Record<string, unknown>).left === "string";
`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("right");
	});

	it("P9: arrow EXPRESSION-body predicate with no trailing `;`/newline still drifts", () => {
		// `arrowExpressionBody` returns as soon as it sees a `;` or `\n` at
		// depth <= 0 (the normal case, exercised by P7's trailing `;\n`). When
		// the predicate is the very last thing in the file with neither —
		// exactly this fixture, whose template literal ends right after the
		// closing quote — the scan runs out of characters and falls through
		// to the budget-exhausted `return stripped.slice(start, end)`. A
		// mutant that returned "" there instead would yield a body with no
		// tokens, `checked` would be 0, and this would report nothing.
		const src = `
interface Pair { left: string; right: string; }
const isPair = (v: unknown): v is Pair =>
	typeof (v as Record<string, unknown>).left === "string"`;
		const out = detectTypePredicateDrift(src, F);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("right");
	});

	it("P8: asserted type imported from a sibling file resolves and drifts", () => {
		const dir = mkdtempSync(join(tmpdir(), "tpd-xfile-"));
		try {
			writeFileSync(
				join(dir, "shapes.ts"),
				"export interface Job { kind: string; riskTier: string; file: string; }\n",
			);
			const guardPath = join(dir, "guard.ts");
			const src = `
import type { Job } from "./shapes.js";
export function isJob(v: unknown): v is Job {
	const o = v as Record<string, unknown>;
	return typeof o.kind === "string" && typeof o.file === "string";
}
`;
			writeFileSync(guardPath, src);
			const out = detectTypePredicateDrift(src, guardPath);
			expect(out).toHaveLength(1);
			expect(out[0]?.text).toContain("riskTier");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("N12: a complete guard against an imported type stays clean", () => {
		const dir = mkdtempSync(join(tmpdir(), "tpd-xfile-"));
		try {
			writeFileSync(
				join(dir, "shapes.ts"),
				"export interface Job { kind: string; file: string; }\n",
			);
			const src = `
import type { Job } from "./shapes.js";
export function isJob(v: unknown): v is Job {
	const o = v as Record<string, unknown>;
	return typeof o.kind === "string" && typeof o.file === "string";
}
`;
			expect(detectTypePredicateDrift(src, join(dir, "guard.ts"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("N13: package-specifier imports stay unresolvable — no fire", () => {
		const src = `
import type { ZodShape } from "some-package";
function isShape(v: unknown): v is ZodShape {
	const o = v as Record<string, unknown>;
	return typeof o.name === "string";
}
`;
		expect(detectTypePredicateDrift(src, F)).toEqual([]);
	});

	it("N14: `import { A as B }` resolves through the SOURCE name's declaration", () => {
		const dir = mkdtempSync(join(tmpdir(), "tpd-xfile-"));
		try {
			writeFileSync(
				join(dir, "shapes.ts"),
				"export interface Wire { seq: number; body: string; }\n",
			);
			const src = `
import type { Wire as Frame } from "./shapes.js";
export function isFrame(v: unknown): v is Frame {
	const o = v as Record<string, unknown>;
	return typeof o.seq === "number" && typeof o.body === "string";
}
`;
			expect(detectTypePredicateDrift(src, join(dir, "guard.ts"))).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
