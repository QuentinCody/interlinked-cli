import { expect, it } from "vitest";
import { isScoreInput, sourceRole } from "./inventory-roles.js";

// test-contract: public-api — documentation is one of the four roles the score reads (product, test, configuration, documentation); vendored files are not
it("counts documentation as a score input and excludes vendored files", () => {
	expect(isScoreInput(sourceRole("docs/guide.md"))).toBe(true);
	expect(isScoreInput(sourceRole("node_modules/pkg/index.js"))).toBe(false);
});
