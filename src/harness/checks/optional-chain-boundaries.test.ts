import { describe, expect, it } from "vitest";
import { checkUnsafeOptionalChaining } from "./agent-safety-js-correctness.js";

describe("optional-chain grouping boundaries", () => {
	it.each([
		"const saved = new Map(previous?.entries.filter(retainProfile).map(entry => [entry.id, entry]));",
		"const result = normalize(value?.field).name;",
		"const result = (value?.field ?? fallback).name;",
		"const result = (value?.field)?.name;",
	])("does not mistake safe calls or fallbacks for broken grouping: %s", (content) => {
		expect(checkUnsafeOptionalChaining(content, "src/selection.ts")).toEqual([]);
	});

	it.each([
		"const result = (value?.field).name;",
		"const result = (value?.method()).name;",
		"const result = ((value?.field)).name;",
		"const result = (value?.field ?? fallback).name + (other?.field).name;",
	])("retains a real broken grouping boundary: %s", (content) => {
		expect(checkUnsafeOptionalChaining(content, "src/selection.ts")).toEqual([
			{ line: 1, text: content },
		]);
	});
});
