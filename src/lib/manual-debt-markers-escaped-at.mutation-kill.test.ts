import { describe, expect, it } from "vitest";
import { advanceSlashLanguageState } from "./manual-debt-markers-escaped-at.js";

describe("manual-debt-markers-escaped-at mutation kills", () => {
	// test-contract: boundary — an even run of backslashes before a backtick leaves the backtick unescaped, so it closes the template
	it("closes a template at a backtick preceded by two backslashes", () => {
		expect(advanceSlashLanguageState("`a\\\\`", "normal")).toBe("normal");
	});

	// test-contract: boundary — an odd run of backslashes escapes the backtick, so the template stays open
	it("keeps a template open at a backtick preceded by one backslash", () => {
		expect(advanceSlashLanguageState("`a\\`", "normal")).toBe("template");
	});
});
