// Unit tests for commit-cadence.ts targeting a branch the existing
// integration/mutation-kill suites (commit-cadence.integration.test.ts,
// commit-cadence.mutation-kill*.test.ts) don't reach: readSessionTokens'
// read-error catch. Those files cover "path missing" (existsSync false) but
// not "path exists yet readFileSync itself throws" — a real directory path
// triggers that (EISDIR) without any mocking.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionTokens } from "./commit-cadence.js";

describe("readSessionTokens — negative (must NOT fire)", () => {
	let tmp: string;

	afterEach(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it("N1: returns null when transcriptPath exists but readFileSync itself throws (EISDIR)", () => {
		tmp = mkdtempSync(join(tmpdir(), "commit-cadence-eisdir-"));
		// `tmp` exists (existsSync => true) but is a directory, so
		// readFileSync throws — this is the read-error catch, distinct from
		// the earlier "path does not exist" early return.
		expect(readSessionTokens(tmp)).toBe(null);
	});
});
