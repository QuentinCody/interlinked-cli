import { describe, expect, it } from "vitest";
import { isTestFile } from "./quality-feedback.js";

describe("isTestFile — mutation-directed", () => {
	// test-contract: public-api — Go _test.go files are recognised as test files
	it("treats a Go _test.go file as a test file", () => {
		expect(isTestFile("pkg/server/handler_test.go")).toBe(true);
		expect(isTestFile("pkg/server/handler.go")).toBe(false);
	});
});
