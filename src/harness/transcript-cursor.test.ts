import { expect, it } from "vitest";
import { numericOffsets, transcriptOffset, updatedCursor } from "./transcript-cursor.js";

it("keeps only valid byte offsets and treats every filename as data", () => {
	const incoming: unknown = JSON.parse('{"__proto__":7,"bad":-1,"fraction":1.5,"zero":0}');
	const offsets = numericOffsets(incoming);
	expect(Object.keys(offsets)).toEqual(["__proto__", "zero"]);
	const next = updatedCursor({ path: "zero", offset: 0, offsets }, "__proto__", 8);
	expect(Object.entries(next.offsets)).toEqual([["zero", 0], ["__proto__", 8]]);
	expect(transcriptOffset(next, "__proto__")).toBe(8);
	expect(transcriptOffset(next, "toString")).toBe(0);
	expect(offsets["__proto__"]).toBe(7);
});

it("refreshes the current transcript before evicting the oldest entry", () => {
	const offsets = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`file-${i}`, i]));
	const previous = updatedCursor({ path: "", offset: 0, offsets }, "file-0", 10);
	const next = updatedCursor(previous, "new", 11);
	expect(next).toMatchObject({ path: "new", offset: 11, offsets: { "file-0": 10, new: 11 } });
	expect(Object.keys(next.offsets)).toHaveLength(32);
	expect(next.offsets).not.toHaveProperty("file-1");
	expect(previous.offsets).toHaveProperty("file-1", 1);
});
