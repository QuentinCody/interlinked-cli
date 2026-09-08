import { describe, expect, it } from "vitest";
import { reconstructProposedBaseline } from "./baseline-integrity-proposal.js";
import { extractPermissionPattern } from "./permission-patterns.js";
import { projectAfterContent } from "./spec-pre-gates.js";

describe("untrusted evaluator input", () => {
	it.each([null, 42, {}, [], false])("does not derive a shell permission from nonstring command %j", (command) => {
		expect(extractPermissionPattern("Bash", { command })).toBeNull();
	});

	it.each([null, 42, {}, [], false])("rejects malformed spec edit %j without projecting a partial write", (entry) => {
		expect(projectAfterContent("MultiEdit", { edits: [{ old_string: "before", new_string: "after" }, entry] }, "before")).toBeNull();
	});

	it("skips malformed baseline edits and still reconstructs valid later replacements", () => {
		expect(reconstructProposedBaseline("before", { edits: [null, 42, { old_string: "before", new_string: "after" }] })).toBe("after");
	});
});
