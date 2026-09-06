import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonical.js";
import {
	computeOverlayBytesHash,
	computePostImageSetHash,
	DELETE_DIGEST_BYTES,
	DELETE_MODE,
	type TaggedEntryInput,
	type TaggedWriteEntry,
} from "./tagged-set.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ZERO_DIGEST_HEX = "0".repeat(64);

function digestOf(content: string): string {
	return sha256Hex(Buffer.from(content, "utf8"));
}

function write(path: string, content: string, mode = "100644"): TaggedWriteEntry {
	const blob = Buffer.from(content, "utf8");
	return { tag: "W", path, mode, blob_digest: sha256Hex(blob), bytes: blob.length };
}

function del(path: string): TaggedEntryInput {
	return { tag: "D", path };
}

/** The tagged grammar, re-implemented from the memo's prose in the TEST:
 *  tag ‖ 0x20 ‖ mode ‖ 0x20 ‖ path ‖ 0x00 ‖ digest32. */
function record(spec: { tag: "W" | "D"; mode: string; path: string; digestHex: string }): Buffer {
	return Buffer.concat([
		Buffer.from(spec.tag, "ascii"),
		Buffer.from([0x20]),
		Buffer.from(spec.mode, "ascii"),
		Buffer.from([0x20]),
		Buffer.from(spec.path, "utf8"),
		Buffer.from([0x00]),
		Buffer.from(spec.digestHex, "hex"),
	]);
}

function wRecord(path: string, content: string, mode = "100644"): Buffer {
	return record({ tag: "W", mode, path, digestHex: digestOf(content) });
}

function dRecord(path: string): Buffer {
	return record({ tag: "D", mode: "000000", path, digestHex: ZERO_DIGEST_HEX });
}

function expectedHash(records: readonly Buffer[]): string {
	return sha256Hex(Buffer.concat([...records]));
}

function hashOf(entries: readonly TaggedEntryInput[]): string {
	const result = computePostImageSetHash(entries);
	if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
	return result.hash;
}

describe("shadow tagged set (postimages/overlay) — positive (must accept)", () => {
	it("P1: fixed known vector — one W record carries the real mode and digest", () => {
		expect(hashOf([write("src/a.ts", "hello")])).toBe(expectedHash([wRecord("src/a.ts", "hello")]));
	});

	it("P2: fixed known vector — a D record uses mode 000000 and 32 ZERO bytes", () => {
		expect(DELETE_MODE).toBe("000000");
		expect(DELETE_DIGEST_BYTES).toBe(32);
		expect(hashOf([del("src/gone.ts")])).toBe(expectedHash([dRecord("src/gone.ts")]));
	});

	it("P3: a rename is D(source) + W(destination), sorted bytewise", () => {
		const entries = [write("src/new.ts", "moved"), del("src/old.ts")];
		expect(hashOf(entries)).toBe(expectedHash([wRecord("src/new.ts", "moved"), dRecord("src/old.ts")]));
	});

	it("P4: W and D for the same path hash differently — the tag is in the record", () => {
		expect(hashOf([write("a.ts", "")])).not.toBe(hashOf([del("a.ts")]));
	});

	it("P5: order independence — the input array order does not change the hash", () => {
		const entries = [write("a.ts", "1"), del("m/n.ts"), write("z.ts", "3", "100755")];
		const shuffled = [entries[2], entries[0], entries[1]].filter((e): e is TaggedEntryInput => e !== undefined);
		expect(hashOf(shuffled)).toBe(hashOf(entries));
	});

	it("P6: ordering is BYTEWISE and case-sensitive — uppercase sorts before lowercase", () => {
		expect(hashOf([write("a.ts", "l"), del("Z.ts")])).toBe(expectedHash([dRecord("Z.ts"), wRecord("a.ts", "l")]));
	});

	it("P7: a multi-byte UTF-8 path orders by its UTF-8 bytes", () => {
		expect(hashOf([write("é.ts", "e"), write("z.ts", "z")])).toBe(
			expectedHash([wRecord("z.ts", "z"), wRecord("é.ts", "e")]),
		);
	});

	it("P8: an empty set hashes the empty byte string", () => {
		expect(hashOf([])).toBe(EMPTY_SHA256);
	});

	it("P9: overlay and post-image sets share ONE grammar (two algorithm ids, same bytes)", () => {
		const entries = [write("a.ts", "x"), del("b.ts")];
		const overlay = computeOverlayBytesHash(entries);
		expect(overlay.ok && overlay.hash).toBe(hashOf(entries));
	});

	it("P10: the W mode is part of the record — 100755 differs from 100644", () => {
		expect(hashOf([write("a.ts", "x", "100755")])).not.toBe(hashOf([write("a.ts", "x", "100644")]));
	});
});

describe("shadow tagged set (postimages/overlay) — negative (must reject)", () => {
	it("N1: a W and a D for the same path is a duplicate — record order would be ambiguous", () => {
		const result = computePostImageSetHash([write("a.ts", "x"), del("a.ts")]);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
		expect(result.ok ? "" : result.detail).toContain("a.ts");
	});

	it("N2: two W records for the same path are rejected", () => {
		expect(computePostImageSetHash([write("a.ts", "x"), write("a.ts", "y")])).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
	});

	it("N3: two D records for the same path are rejected", () => {
		expect(computeOverlayBytesHash([del("a.ts"), del("a.ts")])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N4: a symlink mode on a W record is unavailable(symlink_escape)", () => {
		expect(computePostImageSetHash([{ ...write("link", "t"), mode: "120000" }])).toMatchObject({
			ok: false,
			reason: "symlink_escape",
		});
	});

	it("N5: a submodule mode on a W record is unavailable(invalid_tree)", () => {
		expect(computePostImageSetHash([{ ...write("sub", "t"), mode: "160000" }])).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
	});

	it("N6: mode 000000 is not admitted on a W record — only D carries it", () => {
		expect(computePostImageSetHash([{ ...write("a.ts", "t"), mode: "000000" }])).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
	});

	it("N7: a traversal path on a D record is rejected", () => {
		expect(computeOverlayBytesHash([del("../escape.ts")])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N8: an absolute path on a W record is rejected", () => {
		expect(computePostImageSetHash([write("/etc/passwd", "t")])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N9: a non-hex digest is rejected", () => {
		expect(computePostImageSetHash([{ ...write("a.ts", "x"), blob_digest: "zz" }])).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
	});

	it("N10: an uppercase-hex digest is rejected (the grammar is lowercase hex)", () => {
		const bad: TaggedEntryInput = { ...write("a.ts", "x"), blob_digest: digestOf("x").toUpperCase() };
		expect(computePostImageSetHash([bad])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N11: rejection never throws — it returns the discriminated failure", () => {
		expect(() => computePostImageSetHash([del("../x")])).not.toThrow();
	});
});
