import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHadolint } from "../hadolint.js";

describe("runHadolint", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hadolint-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns an array on an empty tmpdir (no Dockerfile to lint)", () => {
		expect(
			Array.isArray(
				runHadolint({ scope: { projectRoot: tmp, mode: "project" }, timeoutMs: 5_000 }),
			),
		).toBe(true);
	});
});
