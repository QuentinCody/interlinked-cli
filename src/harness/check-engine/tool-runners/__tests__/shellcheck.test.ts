import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShellcheck } from "../shellcheck.js";

describe("runShellcheck", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "sh-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns an array on an empty tmpdir (no .sh files to scan)", () => {
		expect(
			Array.isArray(
				runShellcheck({ scope: { projectRoot: tmp, mode: "project" }, timeoutMs: 5_000 }),
			),
		).toBe(true);
	});
});
