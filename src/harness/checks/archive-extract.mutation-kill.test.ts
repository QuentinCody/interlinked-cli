import { describe, expect, it } from "vitest";
import { checkArchiveExtractTraversal } from "./archive-extract.js";

// Census fault: `|| ext === ".cjs"` dropped from the JS extension list survived
// the companion test (docs/reviews/kill-proof-census-harness.md).
describe("checkArchiveExtractTraversal — CommonJS sources", () => {
	// test-contract: public-api — a .cjs module is JavaScript; an unguarded tar.x there is the same zip-slip risk
	it("fires on an unguarded tar.x in a .cjs file", () => {
		const source = "tar.x({ file: archive, cwd: dest });";
		expect(checkArchiveExtractTraversal(source, "scripts/unpack.cjs")).toEqual([{ line: 1, text: source }]);
	});

	// test-contract: public-api — extractAllTo in a .cjs file is reported like in any other JS extension
	it("fires on extractAllTo in a .cjs file", () => {
		expect(checkArchiveExtractTraversal("zip.extractAllTo(out, true);", "lib/zip.cjs")).toHaveLength(1);
	});
});
