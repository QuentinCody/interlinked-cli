// ===========================================
// Trigram Index — Dirty-Layer Mutation companion tests
// ===========================================
// Targets the exempt-file guard in `updateFileInState`: a skip-listed or
// oversized write must drop any prior dirty state for that path and report
// itself as NOT indexed, rather than silently falling through to the
// override/new-file paths that a non-exempt write takes.

import { describe, expect, it } from "vitest";
import { type MutableIndexView, updateFileInState } from "./trigram-index-mutation.js";

function freshView(overrides: Partial<MutableIndexView> = {}): MutableIndexView {
	return {
		fileToId: new Map(),
		dirtyOverrides: new Map(),
		dirtyNewFiles: new Map(),
		allocFileId: () => {
			throw new Error("allocFileId should not be called for an exempt write");
		},
		...overrides,
	};
}

describe("updateFileInState — skip-list/size exemption", () => {
	it("drops the existing file's dirty override and reports it as not indexed", () => {
		const view = freshView({
			fileToId: new Map([["package-lock.json", 7]]),
			dirtyOverrides: new Map([[7, new Set([1, 2, 3])]]),
		});

		const indexed = updateFileInState(view, "package-lock.json", "irrelevant content");

		expect(indexed).toBe(false);
		expect(view.dirtyOverrides.get(7)).toBeNull();
	});

	it("removes an already-dirty new file's entry instead of updating its trigrams", () => {
		const view = freshView({
			dirtyNewFiles: new Map([["vendor/bundle.min.js", { id: 3, trigrams: new Set([9]) }]]),
		});

		const indexed = updateFileInState(view, "vendor/bundle.min.js", "irrelevant content");

		expect(indexed).toBe(false);
		expect(view.dirtyNewFiles.has("vendor/bundle.min.js")).toBe(false);
	});
});
