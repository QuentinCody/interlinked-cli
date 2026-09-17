// Backfill for buildGateReachStopWarning's own perEditCoverageDisabledReason
// plumbing (distinct from collectGateReachSnapshot's copy at line ~202 of the
// main companion, which is exercised elsewhere): the "reason present" branch
// of the conditional spread that forwards the caller's disable reason through
// to the collected snapshot.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateReachStopWarning } from "./gate-reach-collect.js";

let repo: string;

function write(rel: string, content: string): void {
	const abs = join(repo, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

beforeEach(() => {
	repo = join(tmpdir(), `gate-reach-backfill-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(repo, { recursive: true });
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("buildGateReachStopWarning — perEditCoverageDisabledReason forwarding", () => {
	it("forwards an explicit disable reason into the recorded per_edit_coverage note", () => {
		write("src/a.ts", "export const a = 1;\n");
		const warning = buildGateReachStopWarning({
			cwd: repo,
			sessionId: "s1",
			perEditCoverageEnabled: false,
			perEditCoverageDisabledReason: "OFF until the incremental index lands",
			now: 1000,
		});
		expect(warning).toContain("OFF until the incremental index lands");
	});

	it("returns null for a read-only session (sessionWroteFiles: false) without collecting a snapshot", () => {
		write("src/a.ts", "export const a = 1;\n");
		const warning = buildGateReachStopWarning({
			cwd: repo,
			sessionId: "s1",
			perEditCoverageEnabled: false,
			sessionWroteFiles: false,
			now: 1000,
		});
		expect(warning).toBeNull();
	});
});
