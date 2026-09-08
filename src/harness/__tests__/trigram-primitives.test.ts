import { describe, expect, it } from "vitest";
import {
	binarySearchU32,
	DEFAULT_MAX_FILE_SIZE,
	DEFAULT_STOP_THRESHOLD,
	EARLY_TERMINATION_THRESHOLD,
	extractTrigrams,
	extractTrigramsWithMasks,
	FLAG_LOWERCASE,
	FLAG_MASKS,
	fnv1a,
	isBinaryContent,
	isControlChar,
	MAGIC_LOOKUP,
	nextCharBit,
	packTrigram,
	popcount8,
	shouldSkipFile,
	trigramToString,
	unpackTrigram,
	VERSION,
} from "../trigram-primitives.js";

// Companion tests for the primitives module, importing the SUT directly.
// The encoding/extraction/binary/skip-file functions are also covered via the
// re-export in trigram-encoding.test.ts; these tests additionally pin the
// formerly-private helpers (fnv1a, nextCharBit, binarySearchU32, popcount8,
// extractTrigramsWithMasks) and the on-disk format constants.

describe("format constants", () => {
	it("pins the on-disk header magic and version", () => {
		expect(MAGIC_LOOKUP).toBe(0x54524c4b); // "TRLK"
		expect(VERSION).toBe(2);
		expect(FLAG_LOWERCASE).toBe(1);
		expect(FLAG_MASKS).toBe(2);
	});

	it("pins index build defaults", () => {
		expect(DEFAULT_MAX_FILE_SIZE).toBe(1_048_576);
		expect(DEFAULT_STOP_THRESHOLD).toBeCloseTo(0.4);
		expect(EARLY_TERMINATION_THRESHOLD).toBe(20);
	});
});

describe("fnv1a", () => {
	it("returns a deterministic unsigned 32-bit hash", () => {
		const packed = packTrigram(0x61, 0x62, 0x63); // "abc"
		const h = fnv1a(packed);
		expect(h).toBe(fnv1a(packed)); // deterministic
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);
		expect(Number.isInteger(h)).toBe(true);
	});

	it("produces different hashes for different trigrams (no trivial collision)", () => {
		const a = fnv1a(packTrigram(0x61, 0x62, 0x63)); // abc
		const b = fnv1a(packTrigram(0x61, 0x62, 0x64)); // abd
		const c = fnv1a(packTrigram(0x62, 0x61, 0x63)); // bac
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
	});

	it("hashes zero without throwing", () => {
		// fnv1a is a pure function of its input; the hash of 0 is fixed.
		expect(fnv1a(0)).toBe(1253111735);
	});
});

describe("nextCharBit", () => {
	it("always returns a single set bit in the low byte (0..7 positions)", () => {
		for (let code = 0; code < 128; code++) {
			const bit = nextCharBit(code);
			// exactly one bit set
			expect(popcount8(bit)).toBe(1);
			// within the low 8 bits
			expect(bit & 0xff).toBe(bit);
		}
	});

	it("is deterministic for a given char code", () => {
		expect(nextCharBit(0x61)).toBe(nextCharBit(0x61));
	});
});

describe("binarySearchU32", () => {
	it("finds existing elements and reports correct indices", () => {
		const arr = new Uint32Array([1, 3, 5, 7, 9, 11]);
		expect(binarySearchU32(arr, 1)).toBe(0);
		expect(binarySearchU32(arr, 7)).toBe(3);
		expect(binarySearchU32(arr, 11)).toBe(5);
	});

	it("returns -1 for missing elements", () => {
		const arr = new Uint32Array([2, 4, 6, 8]);
		expect(binarySearchU32(arr, 5)).toBe(-1);
		expect(binarySearchU32(arr, 1)).toBe(-1);
		expect(binarySearchU32(arr, 9)).toBe(-1);
	});

	it("handles empty and single-element arrays", () => {
		expect(binarySearchU32(new Uint32Array([]), 1)).toBe(-1);
		expect(binarySearchU32(new Uint32Array([42]), 42)).toBe(0);
		expect(binarySearchU32(new Uint32Array([42]), 7)).toBe(-1);
	});
});

describe("popcount8", () => {
	it("counts set bits for representative bytes", () => {
		expect(popcount8(0x00)).toBe(0);
		expect(popcount8(0x01)).toBe(1);
		expect(popcount8(0x03)).toBe(2);
		expect(popcount8(0xff)).toBe(8);
		expect(popcount8(0b10101010)).toBe(4);
	});

	it("ignores bits above the low byte", () => {
		// 0x1ff masks to 0xff → 8 bits
		expect(popcount8(0x1ff)).toBe(8);
	});
});

describe("extractTrigramsWithMasks", () => {
	it("returns empty map for strings shorter than 3 chars", () => {
		expect(extractTrigramsWithMasks("").size).toBe(0);
		expect(extractTrigramsWithMasks("ab").size).toBe(0);
	});

	it("produces one entry per unique trigram with location masks set", () => {
		const masks = extractTrigramsWithMasks("abcabc");
		// trigrams: abc(0), bca(1), cab(2), abc(3) → unique: abc, bca, cab
		const abc = masks.get(packTrigram(0x61, 0x62, 0x63));
		expect(abc).toBeDefined();
		// "abc" occurs at positions 0 and 3 → locMask bits 1<<0 and 1<<3
		expect((abc!.locMask & (1 << 0)) !== 0).toBe(true);
		expect((abc!.locMask & (1 << 3)) !== 0).toBe(true);
	});

	it("records a next-char bloom bit for non-final trigrams", () => {
		const masks = extractTrigramsWithMasks("abcd");
		// "abc" is followed by "d"
		const abc = masks.get(packTrigram(0x61, 0x62, 0x63));
		expect(abc).toBeDefined();
		expect(abc!.nextMask & nextCharBit(0x64)).not.toBe(0);
	});

	it("agrees with extractTrigrams on which trigrams exist", () => {
		const content = "export function handleAuth(req) {}";
		const plain = extractTrigrams(content);
		const withMasks = extractTrigramsWithMasks(content);
		expect(withMasks.size).toBe(plain.size);
		for (const tri of plain) {
			expect(withMasks.has(tri)).toBe(true);
		}
	});

	it("skips control and non-ASCII characters like extractTrigrams", () => {
		expect(extractTrigramsWithMasks("\x01\x02\x03").size).toBe(0);
	});
});

// Smoke coverage for the re-exported pure functions when imported directly
// from the primitives module (rather than via trigram-index.js).
describe("re-exported pure functions (direct import)", () => {
	it("packTrigram / unpackTrigram / trigramToString roundtrip", () => {
		const packed = packTrigram(0x66, 0x6f, 0x6f); // "foo"
		expect(unpackTrigram(packed)).toEqual([0x66, 0x6f, 0x6f]);
		expect(trigramToString(packed)).toBe("foo");
	});

	it("isControlChar flags control bytes but allows tab/newline/CR", () => {
		expect(isControlChar(0x01)).toBe(true);
		expect(isControlChar(0x1f)).toBe(true);
		expect(isControlChar(0x09)).toBe(false); // tab
		expect(isControlChar(0x0a)).toBe(false); // newline
		expect(isControlChar(0x0d)).toBe(false); // CR
		expect(isControlChar(0x41)).toBe(false); // 'A'
	});

	it("isBinaryContent detects null bytes in the first 8KB only", () => {
		expect(isBinaryContent("hello\x00world")).toBe(true);
		expect(isBinaryContent("clean text")).toBe(false);
		expect(isBinaryContent(`${"x".repeat(9000)}\x00`)).toBe(false);
	});

	it("shouldSkipFile rejects lock/minified/map files, keeps source", () => {
		expect(shouldSkipFile("package-lock.json")).toBe(true);
		expect(shouldSkipFile("a/b/bundle.min.js")).toBe(true);
		expect(shouldSkipFile("app.js.map")).toBe(true);
		expect(shouldSkipFile("src/index.ts")).toBe(false);
	});
});
