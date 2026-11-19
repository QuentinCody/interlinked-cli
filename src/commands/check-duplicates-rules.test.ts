import { describe, expect, it } from "vitest";
import { duplicateGroup } from "./check-duplicates-rules.js";

describe("duplicateGroup", () => {
	it("P1: two modules with different names that export one name are a group", () => {
		expect(duplicateGroup(["/p/a.ts", "/p/b.ts"])).toEqual(["/p/a.ts", "/p/b.ts"]);
	});
	it("P2: two modules with one file name are still a group", () => {
		expect(duplicateGroup(["/p/a/utils.ts", "/p/b/utils.ts"])).toEqual(["/p/a/utils.ts", "/p/b/utils.ts"]);
	});
	it("P3: an index module and an ordinary module are a group", () => {
		expect(duplicateGroup(["/p/a/index.ts", "/p/b/root.ts"])).toEqual(["/p/a/index.ts", "/p/b/root.ts"]);
	});
	it("N1: a declaration file beside its implementation drops out, which leaves one file and no group", () => {
		expect(duplicateGroup(["/p/Badge.d.ts", "/p/Badge.jsx"])).toEqual([]);
	});
	it("N2: only index modules make no group", () => {
		expect(duplicateGroup(["/p/a/index.ts", "/p/b/index.js"])).toEqual([]);
	});
	it("N3: three modules with one file name are a convention and drop out", () => {
		expect(duplicateGroup(["/p/a/fields.ts", "/p/b/fields.ts", "/p/c/fields.ts", "/p/d/row-fields.ts"])).toEqual([]);
	});
	it("N4: a single file is no group", () => {
		expect(duplicateGroup(["/p/a.ts"])).toEqual([]);
	});
});
