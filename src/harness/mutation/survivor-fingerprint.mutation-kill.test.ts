import { describe, expect, it } from "vitest";
import { fingerprintAt, indexSource, type SourceIndex } from "./survivor-fingerprint.js";

function fingerprintOfCondition(tail: string): string | null {
	const content = [
		"export function f(a: number, b: number, c: boolean): void {",
		"\tif (a > b) {",
		"\t\tif (c) {",
		"\t\t\tg();",
		"\t\t}",
		`\t\t${tail}`,
		"\t}",
		"}",
		"",
	].join("\n");
	const index: SourceIndex | null = indexSource({ file: "src/example.ts", content });
	if (index === null) throw new Error("typescript unavailable");
	return fingerprintAt(index, content.indexOf("a > b"), "a > b");
}

describe("survivor-fingerprint mutation-kill", () => {
	// test-contract: invariant — a change after a doubly nested block, inside the outer block, does not change the fingerprint
	it("ignores text that follows an inner block within the outer block interior", () => {
		const first = fingerprintOfCondition("h();");
		expect(first).not.toBeNull();
		expect(fingerprintOfCondition("k(1, 2, 3);")).toBe(first);
	});
});
