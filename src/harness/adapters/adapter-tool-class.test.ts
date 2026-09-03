import { describe, expect, it } from "vitest";

import { adapterToolClassifier } from "./adapter-tool-class.js";
import type { ClassifierOverrides } from "../tool-class-classifier.js";

describe("adapterToolClassifier", () => {
	it("classifies a known write tool as modify when no overrides are configured", () => {
		const classify = adapterToolClassifier(undefined);
		expect(classify("Write", { file_path: "a.ts", content: "x" })).toBe("modify");
	});

	it("classifies a known read tool as read when no overrides are configured", () => {
		const classify = adapterToolClassifier(undefined);
		expect(classify("Read", { file_path: "a.ts" })).toBe("read");
	});

	it("honors a user tool-name override", () => {
		const overrides: ClassifierOverrides = { tool_name_classes: { Read: "modify" }, command_substrings: [] };
		const classify = adapterToolClassifier(overrides);
		expect(classify("Read", { file_path: "a.ts" })).toBe("modify");
	});

	it("keeps non-overridden tools on the shared classification when overrides exist", () => {
		const overrides: ClassifierOverrides = { tool_name_classes: { Read: "modify" }, command_substrings: [] };
		const classify = adapterToolClassifier(overrides);
		expect(classify("Write", { file_path: "a.ts", content: "x" })).toBe("modify");
		expect(classify("Bash", { command: "rm -rf /tmp/x" })).toBe("side-effect");
	});

	it("returns a stable classifier that can be called many times", () => {
		const classify = adapterToolClassifier(undefined);
		expect(classify("Read", { file_path: "a.ts" })).toBe(
			classify("Read", { file_path: "b.ts" }),
		);
	});

	it("tolerates a non-object tool input", () => {
		const classify = adapterToolClassifier(undefined);
		expect(() => classify("Read", undefined)).not.toThrow();
	});
});
