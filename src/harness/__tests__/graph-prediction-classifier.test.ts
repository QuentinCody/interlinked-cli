// ===========================================
// graph-prediction case classifier
// ===========================================
// Two layers:
//   1. workspaceSupermodelActive(cwd) — does this repo run Supermodel's
//      daemon? Cached by sentinel-mtime; FP-suppressed against fixture/
//      vendored/dist directories.
//   2. classifyCase(filePath, cwd) — returns A/B/C/D/E-fresh/E-stale per
//      §3 of the design doc, only meaningful when workspace is active.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyCase,
	resetWorkspaceActiveCache,
	workspaceSupermodelActive,
} from "../graph-prediction-classifier.js";

// Helpers
let dir: string;
const deferredCleanup: string[] = [];

function setMtime(path: string, mtimeIsoOrEpochMs: string | number): void {
	const ms = typeof mtimeIsoOrEpochMs === "number" ? mtimeIsoOrEpochMs : Date.parse(mtimeIsoOrEpochMs);
	const seconds = ms / 1000;
	utimesSync(path, seconds, seconds);
}

// Every hook and describe block below carries an explicit 60s timeout,
// double vitest.stryker.config.ts's 30s default. Locally each case finishes
// in low single-digit ms (all work is synchronous real-fs I/O via mkdtempSync/
// mkdirSync/writeFileSync/rmSync against the OS tmpdir), but under the
// mutation runner's sandbox cold-cache/load conditions that same I/O can run
// far slower than on a warm dev box — the exact "Test timed out in 30000ms ->
// ConfigError -> no report -> ENOENT" failure mode diagnosed for
// commit-parse.ts / env-extractor.ts / verify-parity.ts
// (scratch/fleet-r3/repair-followups.txt bug #13). This is headroom only:
// no assertion changes.
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "graph-pred-classifier-"));
	resetWorkspaceActiveCache();
}, 60_000);

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const extra of deferredCleanup.splice(0)) {
		rmSync(extra, { recursive: true, force: true });
	}
	resetWorkspaceActiveCache();
}, 60_000);

describe("workspaceSupermodelActive", { timeout: 60_000 }, () => {
	it("returns false in an empty repo (no shards anywhere)", () => {
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	it("returns true when at least one shard-near-source pair exists", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "foo.ts"), "export {}");
		writeFileSync(join(dir, "src", "foo.graph.ts"), "// @generated supermodel-sidecar");
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});

	it("returns false when shards exist ONLY under fixture paths", () => {
		// Without exclusion, this repo (which has fixtures under
		// __tests__/fixtures/supermodel/) would always test active.
		mkdirSync(join(dir, "src", "harness", "__tests__", "fixtures", "supermodel"), {
			recursive: true,
		});
		writeFileSync(
			join(dir, "src", "harness", "__tests__", "fixtures", "supermodel", "fake.ts"),
			"export {}",
		);
		writeFileSync(
			join(dir, "src", "harness", "__tests__", "fixtures", "supermodel", "fake.graph.ts"),
			"// @generated supermodel-sidecar",
		);
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	it("excludes reference-repos/, node_modules/, dist/, build/, out/", () => {
		for (const sub of ["reference-repos", "node_modules", "dist", "build", "out"]) {
			mkdirSync(join(dir, sub, "pkg"), { recursive: true });
			writeFileSync(join(dir, sub, "pkg", "vendored.ts"), "export {}");
			writeFileSync(join(dir, sub, "pkg", "vendored.graph.ts"), "// @generated");
		}
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	it("returns false when shard exists but the named source does NOT (orphan shard)", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "ghost.graph.ts"), "// @generated");
		// no ghost.ts beside it
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	it("respects an explicit `supermodel.enabled: false` config opt-out", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, "src", "foo.ts"), "export {}");
		writeFileSync(join(dir, "src", "foo.graph.ts"), "// @generated");
		writeFileSync(
			join(dir, ".interlinked", "config.json"),
			JSON.stringify({ supermodel: { enabled: false } }),
		);
		expect(workspaceSupermodelActive(dir)).toBe(false);
	});

	it("treats a malformed config.json as no opt-out and keeps scanning", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, "src", "foo.ts"), "export {}");
		writeFileSync(join(dir, "src", "foo.graph.ts"), "// @generated");
		// Invalid JSON: JSON.parse throws, configOptOut's catch must swallow
		// it and report "not opted out" rather than propagating or treating
		// the malformed file as an opt-out.
		writeFileSync(join(dir, ".interlinked", "config.json"), "{ not valid json");
		expect(workspaceSupermodelActive(dir)).toBe(true);
	});
});

describe("classifyCase", { timeout: 60_000 }, () => {
	beforeEach(() => {
		// Make the workspace look active for these tests
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "anchor.ts"), "export {}");
		writeFileSync(join(dir, "src", "anchor.graph.ts"), "// @generated");
	}, 60_000);

	it("returns A when workspace is not active (overrides per-target classification)", () => {
		const inactiveDir = mkdtempSync(join(tmpdir(), "graph-pred-inactive-"));
		deferredCleanup.push(inactiveDir);
		expect(classifyCase(join(inactiveDir, "anything.ts"), inactiveDir).case).toBe("A");
	});

	it("returns B when target source does not exist and content has imports", () => {
		const result = classifyCase(join(dir, "src", "new-with-imports.ts"), dir, {
			toolInputContent: 'import { foo } from "./helper.js";\nexport const x = 1;',
		});
		expect(result.case).toBe("B");
	});

	it("returns C when target source does not exist and content has no imports", () => {
		const result = classifyCase(join(dir, "src", "greenfield.ts"), dir, {
			toolInputContent: "export const x = 1;",
		});
		expect(result.case).toBe("C");
	});

	it("returns D when target source exists but no shard exists", () => {
		writeFileSync(join(dir, "src", "no-shard.ts"), "export {}");
		const result = classifyCase(join(dir, "src", "no-shard.ts"), dir);
		expect(result.case).toBe("D");
	});

	it("returns E-fresh when shard mtime is within 60s grace of source mtime", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "fresh.ts"), "export {}");
		writeFileSync(join(dir, "src", "fresh.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "fresh.ts"), t);
		setMtime(join(dir, "src", "fresh.graph.ts"), t + 30_000); // shard is 30s newer

		const result = classifyCase(join(dir, "src", "fresh.ts"), dir);
		expect(result.case).toBe("E-fresh");
		expect(result.shardPath).toContain("fresh.graph.ts");
	});

	it("returns E-fresh when shard mtime equals source mtime (boundary)", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "eq.ts"), "export {}");
		writeFileSync(join(dir, "src", "eq.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "eq.ts"), t);
		setMtime(join(dir, "src", "eq.graph.ts"), t);
		expect(classifyCase(join(dir, "src", "eq.ts"), dir).case).toBe("E-fresh");
	});

	it("returns E-fresh when shard is older than source by less than 60s grace", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "grace.ts"), "export {}");
		writeFileSync(join(dir, "src", "grace.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "grace.ts"), t);
		setMtime(join(dir, "src", "grace.graph.ts"), t - 30_000);
		expect(classifyCase(join(dir, "src", "grace.ts"), dir).case).toBe("E-fresh");
	});

	it("returns E-stale when shard is older than source by more than 60s grace", () => {
		const t = Date.parse("2026-05-10T12:00:00Z");
		writeFileSync(join(dir, "src", "stale.ts"), "export {}");
		writeFileSync(join(dir, "src", "stale.graph.ts"), "// @generated");
		setMtime(join(dir, "src", "stale.ts"), t);
		setMtime(join(dir, "src", "stale.graph.ts"), t - 120_000); // 2 min older

		const result = classifyCase(join(dir, "src", "stale.ts"), dir);
		expect(result.case).toBe("E-stale");
	});
});

describe("classifyCase result shape", { timeout: 60_000 }, () => {
	it("returns sourcePath as the canonical absolute target path", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "anchor.ts"), "export {}");
		writeFileSync(join(dir, "src", "anchor.graph.ts"), "// @generated");
		writeFileSync(join(dir, "src", "x.ts"), "export {}");
		const result = classifyCase(join(dir, "src", "x.ts"), dir);
		expect(result.sourcePath).toBe(join(dir, "src", "x.ts"));
		expect(result.case).toBe("D");
	});

	it("returns the shard path on E-fresh / E-stale, null otherwise", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "anchor.ts"), "export {}");
		writeFileSync(join(dir, "src", "anchor.graph.ts"), "// @generated");

		const dResult = classifyCase(join(dir, "src", "no-shard.ts"), dir, {
			toolInputContent: "",
		});
		expect(dResult.shardPath).toBeNull();

		writeFileSync(join(dir, "src", "with-shard.ts"), "export {}");
		writeFileSync(join(dir, "src", "with-shard.graph.ts"), "// @generated");
		const eResult = classifyCase(join(dir, "src", "with-shard.ts"), dir);
		expect(eResult.shardPath).toContain("with-shard.graph.ts");
	});
});
