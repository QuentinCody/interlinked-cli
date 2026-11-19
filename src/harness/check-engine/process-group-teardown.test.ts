import { describe, expect, it } from "vitest";
import { descendantGroupsFromTable } from "./process-group-teardown.js";

describe("supervised descendant process-group ownership", () => {
	it("retains descendant-led detached groups before their parents exit", () => {
		const table = "600 100 600\n610 600 610\n620 610 610\n630 600 600\n640 620 640\n999 100 999";
		expect(descendantGroupsFromTable(table, 600)).toEqual([610, 640]);
	});
	it("does not signal a group whose leader belongs to another process tree", () => {
		expect(descendantGroupsFromTable("600 100 600\n610 600 100\n100 1 100", 600)).toEqual([]);
	});
	it("handles an empty snapshot without inventing ownership", () => {
		expect(descendantGroupsFromTable("", 600)).toEqual([]);
	});
	it.each(["600 100", "600 invalid 600", "600 100 600 extra"])("rejects malformed ownership evidence %s", table => {
		expect(() => descendantGroupsFromTable(table, 600)).toThrow("Invalid process ownership snapshot");
	});
});
