import { describe, expect, it } from "vitest";
import { checkGithubActionsInjection } from "./github-actions.js";

describe("checkGithubActionsInjection — one match per line", () => {
	// test-contract: public-api — a line with two dangerous expressions reports once (one InlineMatch per line).
	it("reports a single match when two injectable expressions share one line", () => {
		const content = [
			"jobs:",
			"  a:",
			"    steps:",
			'      - run: echo "${{ github.event.issue.title }} ${{ github.event.issue.body }}"',
		].join("\n");
		const matches = checkGithubActionsInjection(content, ".github/workflows/ci.yml");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(4);
	});
});
