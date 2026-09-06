import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	measureToolInputBytes,
	TOOL_INPUT_MAX_DEPTH,
	TOOL_INPUT_MAX_NODES,
} from "./tool-input-bytes.js";

const CAP = 1_048_576;

/** The ONE oracle this module is judged against: the walk must agree with
 *  `JSON.stringify` to the byte, for every value it accepts. */
function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Code points whose serialized width differs from their raw UTF-8 width, or
 *  sits on a UTF-8 boundary. Built by code point rather than written as
 *  literals so the fixture carries no raw control byte. */
const ESCAPE_CODE_POINTS: readonly number[] = [
	0x00, // NUL — a six-byte u-escape
	0x01,
	0x08, // backspace, tab, newline, form feed, carriage return: two bytes each
	0x09,
	0x0a,
	0x0c,
	0x0d,
	0x1f, // last control character
	0x20, // first character escaping never touches
	0x22, // quote — two bytes
	0x5c, // backslash — two bytes
	0x7f, // DEL: NOT escaped by JSON.stringify, and one raw byte
	0xe9, // é — two raw bytes
	0x65e5, // 日 — three raw bytes
	0xd800, // a LONE high surrogate — six bytes, no UTF-8 encoding of its own
	0xdfff, // a lone LOW surrogate
	0x1f600, // an astral code point — a surrogate PAIR, four raw bytes
];

const ESCAPE_CASES: readonly string[] = [
	"",
	...ESCAPE_CODE_POINTS.map((code) => String.fromCodePoint(code)),
	ESCAPE_CODE_POINTS.map((code) => String.fromCodePoint(code)).join("mixed"),
	String.fromCodePoint(0x0a).repeat(3),
];

/** A left-nested array chain `[[[…]]]` of the requested depth, built
 *  ITERATIVELY so the fixture itself cannot blow the JS stack. */
function nest(depth: number): unknown {
	let value: unknown = 0;
	for (let index = 0; index < depth; index += 1) value = [value];
	return value;
}

describe("measureToolInputBytes — positive (must accept)", () => {
	it("P1: an empty object costs its two structural braces", () => {
		expect(measureToolInputBytes({}, CAP)).toEqual({ ok: true, bytes: 2 });
	});

	it("P2: a string is measured in UTF-8 bytes plus its two quotes", () => {
		// `{"k":"é"}` — braces 2, key "k" 1+2 quotes +1 colon, value 2 utf8 + 2 quotes.
		expect(measureToolInputBytes({ k: "é" }, CAP)).toEqual({ ok: true, bytes: 2 + 4 + 4 });
	});

	it("P3: primitives and structure are counted, unlike a string-only walk", () => {
		const measured = measureToolInputBytes({ a: true, b: null, c: 12 }, CAP);
		// braces 2 + 2 commas, three 1-byte keys (1 + 2 quotes + 1 colon each),
		// true 4, null 4, 12 → 2.
		expect(measured).toEqual({ ok: true, bytes: 2 + 2 + 12 + 4 + 4 + 2 });
	});

	it("P4: a realistic Write payload sits far under the cap and reports its size", () => {
		const measured = measureToolInputBytes({ file_path: "src/a.ts", content: "export const a = 1;\n" }, CAP);
		expect(measured.ok).toBe(true);
		// SAFETY: the assertion above proves the ok arm.
		expect(measured.ok && measured.bytes).toBeLessThan(200);
	});

	it("P5: a payload just under the cap is accepted", () => {
		const content = "x".repeat(CAP - 200);
		const measured = measureToolInputBytes({ file_path: "src/a.ts", content }, CAP);
		expect(measured.ok).toBe(true);
		// SAFETY: the assertion above proves the ok arm.
		expect(measured.ok && measured.bytes).toBeLessThanOrEqual(CAP);
	});

	it("P6: nesting exactly at the depth bound is still accepted", () => {
		expect(measureToolInputBytes(nest(TOOL_INPUT_MAX_DEPTH), CAP).ok).toBe(true);
	});

	it("P7: every escaped character costs its SERIALIZED width, as a value AND as a key", () => {
		for (const text of ESCAPE_CASES) {
			expect(measureToolInputBytes(text, CAP)).toEqual({ ok: true, bytes: serializedBytes(text) });
			const record = { [text]: text };
			expect(measureToolInputBytes(record, CAP)).toEqual({ ok: true, bytes: serializedBytes(record) });
		}
	});

	it("P8: the measurement is EXACT — it equals JSON.stringify's byte length for random JSON", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				expect(measureToolInputBytes(value, CAP)).toEqual({ ok: true, bytes: serializedBytes(value) });
			}),
			{ numRuns: 1_000 },
		);
	});

	it("P8b: exactness holds for arbitrary UTF-16 text, lone surrogates included", () => {
		// `unit: "binary"` draws raw code units, so the generator reaches the
		// escape paths a printable-ASCII arbitrary never would.
		const text = fc.string({ unit: "binary" });
		fc.assert(
			fc.property(fc.dictionary(text, text), (record) => {
				expect(measureToolInputBytes(record, CAP)).toEqual({ ok: true, bytes: serializedBytes(record) });
			}),
			{ numRuns: 1_000 },
		);
	});

	it("P9: number shapes JSON.stringify writes verbatim are counted verbatim", () => {
		for (const value of [0, -0, 1, -1.5, 1e21, 1e-7, Number.MAX_SAFE_INTEGER, Number.EPSILON]) {
			expect(measureToolInputBytes(value, CAP)).toEqual({ ok: true, bytes: serializedBytes(value) });
		}
	});
});

describe("measureToolInputBytes — negative (must reject)", () => {
	it("N1: the reproduced boolean-heavy payload is rejected, not silently passed", () => {
		const pad = Array.from({ length: 250_000 }, () => true);
		const measured = measureToolInputBytes({ pad }, CAP);
		expect(measured.ok).toBe(false);
		// SAFETY: the assertion above proves the failure arm.
		expect(!measured.ok && measured.detail.length).toBeGreaterThan(0);
	});

	it("N2: 20 000 nested arrays reject WITHOUT throwing — no RangeError", () => {
		const deep = nest(20_000);
		expect(() => measureToolInputBytes(deep, CAP)).not.toThrow();
		const measured = measureToolInputBytes(deep, CAP);
		expect(measured.ok).toBe(false);
		// SAFETY: the assertion above proves the failure arm.
		expect(!measured.ok && measured.detail).toContain(String(TOOL_INPUT_MAX_DEPTH));
	});

	it("N3: an over-cap string rejects by bytes", () => {
		const measured = measureToolInputBytes({ content: "x".repeat(CAP + 1) }, CAP);
		expect(measured.ok).toBe(false);
		// SAFETY: the assertion above proves the failure arm.
		expect(!measured.ok && measured.detail).toContain(String(CAP));
	});

	it("N4: a multi-byte string that a UTF-16 length check would pass rejects by bytes", () => {
		// 600 000 two-byte characters = 1 200 000 UTF-8 bytes, length 600 000.
		const measured = measureToolInputBytes({ content: "é".repeat(600_000) }, CAP);
		expect(measured.ok).toBe(false);
	});

	it("N5: a wide payload over the node bound rejects by nodes, naming the bound", () => {
		const pad = Array.from({ length: TOOL_INPUT_MAX_NODES + 10 }, () => 0);
		const measured = measureToolInputBytes({ pad }, CAP);
		expect(measured.ok).toBe(false);
		// SAFETY: the assertion above proves the failure arm.
		expect(!measured.ok && measured.detail).toContain(String(TOOL_INPUT_MAX_NODES));
	});

	it("N6: nesting one level past the depth bound rejects", () => {
		expect(measureToolInputBytes(nest(TOOL_INPUT_MAX_DEPTH + 1), CAP).ok).toBe(false);
	});

	it("N7: REPRODUCTION — 600 000 newlines cost two bytes each and blow the cap", () => {
		// Review 2026-09-04: the content field alone serializes to 1 200 002
		// bytes and the previous "conservative lower bound" measured 600 002,
		// admitting 1.2 MiB past a 1 MiB cap. Undercounting is the one direction
		// a size gate may not take.
		const payload = { file_path: "src/a.ts", content: String.fromCodePoint(0x0a).repeat(600_000) };
		expect(serializedBytes(payload)).toBeGreaterThan(CAP);
		const measured = measureToolInputBytes(payload, CAP);
		expect(measured.ok).toBe(false);
		// SAFETY: the assertion above proves the failure arm.
		expect(!measured.ok && measured.reason).toBe("limits");
	});

	it("N8: a 10-million-wide array is refused in bounded memory and time", () => {
		// A HOLEY array: length only, no element storage — so the fixture proves
		// the walk refuses on CARDINALITY, before it reads a single element.
		const wide = new Array(10_000_000);
		const started = Date.now();
		const measured = measureToolInputBytes({ pad: wide }, CAP);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(measured.ok).toBe(false);
		// SAFETY: the assertion above proves the failure arm.
		expect(!measured.ok && measured.detail).toContain(String(TOOL_INPUT_MAX_NODES));
	});

	it("N9: values JSON.stringify drops, throws on, or coerces are projection failures", () => {
		const notJson: readonly unknown[] = [
			undefined,
			() => 0,
			Symbol("s"),
			BigInt(1),
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			new Date(0),
			new Number(1),
			new Map(),
			{ at: new Date(0) },
			{ fn: () => 0 },
			[undefined],
			{ absent: undefined },
		];
		for (const value of notJson) {
			const measured = measureToolInputBytes(value, CAP);
			expect(measured.ok).toBe(false);
			// SAFETY: the assertion above proves the failure arm.
			expect(!measured.ok && measured.reason).toBe("projection");
		}
	});

	it("N10: a hostile getter is a rejection, never a throw on the hook path", () => {
		const hostile = {
			get boom(): unknown {
				throw new Error("no");
			},
		};
		expect(() => measureToolInputBytes(hostile, CAP)).not.toThrow();
		const measured = measureToolInputBytes(hostile, CAP);
		expect(measured.ok).toBe(false);
		// SAFETY: the assertion above proves the failure arm.
		expect(!measured.ok && measured.reason).toBe("projection");
	});
});
