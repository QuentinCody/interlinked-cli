// test-contract: overlayContentFor is the boundary between a proposed
// ChangeSet and what actually gets shipped to the runner — applying the
// changeset to disk content can throw (a stale patch whose oldString is no
// longer present), and the caller must get an explicit null rather than an
// uncaught exception, since it decides "not-measured" from that null.

import { describe, expect, it } from "vitest";
import type { ChangeSet } from "./changeset.js";
import { overlayContentFor } from "./gate-overlays.js";

describe("overlayContentFor", () => {
	it("returns null when applying the changeset to the file throws", () => {
		const changeSet: ChangeSet = {
			ops: [
				{
					kind: "patch",
					path: "src/foo.ts",
					edits: [{ oldString: "no such text on disk", newString: "replacement" }],
				},
			],
		};
		const result = overlayContentFor(changeSet, "src/foo.ts", "actual disk content\n");
		expect(result).toBeNull();
	});
});
