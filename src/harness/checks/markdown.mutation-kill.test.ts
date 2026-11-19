// Mutation-kill tests for markdown.ts — kill-proof census row 06
// (docs/reviews/kill-proof-census-harness.md): tilde fences.
import { describe, expect, it } from "vitest";
import { checkPlaceholderMarkdownLinks } from "./markdown.js";

describe("checkPlaceholderMarkdownLinks — tilde fences", () => {
	// test-contract: public-api — a placeholder link inside a ~~~ fenced block is documentation, not a finding; one after the fence still fires
	it("ignores placeholder links inside a ~~~ fence", () => {
		const content = "intro\n~~~md\nSee [example]() here\n~~~\nReal [bad]() link\n";
		const matches = checkPlaceholderMarkdownLinks(content, "docs/guide.md");
		expect(matches.map((m) => m.line)).toEqual([5]);
	});
});
