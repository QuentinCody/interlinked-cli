import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runActionlint } from "../actionlint.js";

describe("runActionlint", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "actionlint-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns an array on an empty tmpdir (no .github/workflows to lint)", () => {
		expect(
			Array.isArray(
				runActionlint({ scope: { projectRoot: tmp, mode: "project" }, timeoutMs: 5_000 }),
			),
		).toBe(true);
	});
});
