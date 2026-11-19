import { describe, expect, it } from "vitest";
import type { ChangeSet } from "./changeset.js";
import { buildMutationOverlays } from "./gate-overlays.js";

describe("buildMutationOverlays — co-edited files", () => {
	// test-contract: bug — a file co-edited with the target must ship in the runner overlays with its proposed content
	it("includes a non-target file written by the same changeset", () => {
		const changeSet: ChangeSet = {
			ops: [
				{ kind: "write", path: "src/a.ts", content: "export const a = 2;\n" },
				{ kind: "write", path: "src/b.ts", content: "export const b = 3;\n" },
			],
		};
		const overlays = buildMutationOverlays({
			changeSet,
			target: "src/a.ts",
			overlayContent: "export const a = 2;\n",
			readDisk: () => null,
		});
		expect(overlays).toEqual([
			{ path: "src/a.ts", content: "export const a = 2;\n" },
			{ path: "src/b.ts", content: "export const b = 3;\n" },
		]);
	});
});
