// Coverage backfill for src/harness/pre-checks.ts sites not exercised by the
// two existing companions (__tests__/pre-checks.test.ts and
// pre-checks.coverage.integration.test.ts, both already over the 450-line
// sibling-file threshold):
//
//   - checkLargeFileLineCountWrite / checkProjectedFileSize: the
//     `change.deleted` early return, reached only via an apply_patch
//     "*** Delete File:" section (never via native Write/Edit, which always
//     project `deleted: false`).
//
// checkSelfKill's `Number.isNaN(targetPid)) return null` guard (pre-checks.ts
// line ~99) is NOT covered here: it is genuinely unreachable. The function's
// own regex `/^\s*kill\s+(\d+)\s*$/` requires the captured group to be one or
// more ASCII digits, and `Number.parseInt` of a digits-only string never
// produces NaN (verified: `Number.parseInt("9".repeat(400), 10)` overflows to
// `Infinity`, and `Number.isNaN(Infinity)` is `false` — there is no digit
// string that parses to NaN). No caller passes anything but this function's
// own regex-matched capture into `Number.parseInt`, so the NaN branch has no
// reachable input and is left uncovered per the task's dead-code carve-out.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLargeFileBaselineCache } from "./large-file-policy.js";
import { checkLargeFileLineCountWrite } from "./pre-checks.js";

describe("checkLargeFileLineCountWrite — apply_patch Delete File section", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pre-checks-delete-cov-"));
		resetLargeFileBaselineCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetLargeFileBaselineCache();
	});

	it("allows deleting an existing over-cap file (change.deleted short-circuits before the line-cap math)", () => {
		// An apply_patch "Delete File" section projects to `after: ""` and
		// `deleted: true`. Deleting a file always shrinks it to zero lines, so
		// even an over-cap file must be allowed to go — the deleted guard must
		// fire before the cap comparison, not rely on `after <= before`.
		const path = join(dir, "huge.ts");
		writeFileSync(path, Array.from({ length: 2000 }, () => "const x = 1;").join("\n"));
		const raw = `*** Begin Patch\n*** Delete File: huge.ts\n*** End Patch`;
		const result = checkLargeFileLineCountWrite({ command: raw }, dir);
		expect(result).toBeNull();
	});

	it("mixed patch: a Delete File section for one path does not block an over-cap Add File in the same payload", () => {
		// Exercises checkLargeFileLineCountWrite's per-change loop: the first
		// (deleted) change returns null and the loop must continue to the next
		// section rather than stopping early.
		const existing = join(dir, "old.ts");
		writeFileSync(existing, "const keep = 1;\n");
		const bigBody = Array.from({ length: 2000 }, (_, i) => `+const l${i} = ${i};`).join("\n");
		const raw = [
			"*** Begin Patch",
			"*** Delete File: old.ts",
			"*** Add File: new-big.ts",
			bigBody,
			"*** End Patch",
		].join("\n");
		const result = checkLargeFileLineCountWrite({ command: raw }, dir);
		expect(result?.block).toContain("file-size");
	});
});
