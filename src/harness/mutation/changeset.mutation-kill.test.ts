import { describe, expect, it } from "vitest";
import { normalizeChangeSet } from "./changeset.js";

describe("changeset mutation-kill", () => {
	// test-contract: boundary — a MultiEdit entry without old_string rejects the whole change set
	it("rejects a MultiEdit whose entry has new_string but no old_string", () => {
		const input = { file_path: "src/a.ts", edits: [{ new_string: "y" }] };
		expect(normalizeChangeSet("MultiEdit", input)).toBeNull();
	});

	// test-contract: boundary — a MultiEdit entry with a non-string old_string rejects the whole change set
	it("rejects a MultiEdit whose entry has a non-string old_string", () => {
		const input = { file_path: "src/a.ts", edits: [{ old_string: 7, new_string: "y" }] };
		expect(normalizeChangeSet("MultiEdit", input)).toBeNull();
	});
});
