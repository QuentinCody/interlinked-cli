import { describe, expect, it } from "vitest";
import { checkRawControlBytes } from "./control-bytes.js";

describe("checkRawControlBytes — page breaks", () => {
	// test-contract: public-api — a line holding only a form feed in a program source file is an allowed page break.
	it("does not flag a form-feed-only line in a .ts file", () => {
		expect(checkRawControlBytes("const a = 1;\n\f\nconst b = 2;\n", "src/page.ts")).toEqual([]);
	});
});
