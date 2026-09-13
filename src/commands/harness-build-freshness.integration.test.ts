import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDistFresh } from "./harness-process.js";

const OLD = new Date("2020-01-01T00:00:00Z");
const EDITED = new Date("2020-01-01T01:00:00Z");
const REBUILT = new Date("2020-01-01T02:00:00Z");

describe("ensureDistFresh — real filesystem recursion", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
		roots.length = 0;
	});

	function checkout(): {
		root: string;
		distIndex: string;
		distServer: string;
		sourceDir: string;
		sourceFile: string;
	} {
		const root = mkdtempSync(join(tmpdir(), "interlinked-freshness-"));
		roots.push(root);
		const distDir = join(root, "dist");
		const distHarness = join(distDir, "harness");
		const sourceDir = join(root, "src", "harness", "nested");
		mkdirSync(distHarness, { recursive: true });
		mkdirSync(sourceDir, { recursive: true });
		const distIndex = join(distDir, "index.js");
		const distServer = join(distHarness, "server.js");
		const sourceFile = join(sourceDir, "existing.ts");
		writeFileSync(distIndex, "// old build\n");
		writeFileSync(distServer, "// old daemon\n");
		writeFileSync(sourceFile, "export const version = 1;\n");
		return { root, distIndex, distServer, sourceDir, sourceFile };
	}

	it.each([
		{ path: "src/harness/server.ts", recognized: true },
		{ path: "other/harness/server.ts", recognized: false },
		{ path: "src/other/server.ts", recognized: false },
	])("checks source freshness only for the owned source layout: $path", ({ path, recognized }) => {
		const files = checkout();
		const server = join(files.root, path);
		mkdirSync(join(server, ".."), { recursive: true });
		writeFileSync(server, "export {};\n");
		const readStaleness = vi.fn(() => null);
		const runBuild = vi.fn();
		ensureDistFresh({ quiet: true, resolveServerPath: () => server, readStaleness, runBuild });
		expect(readStaleness.mock.calls).toEqual(recognized ? [[files.root]] : []);
		expect(runBuild).not.toHaveBeenCalled();
	});

	// test-contract: bug — editing an existing nested file does not update its
	// parent directory mtime, so freshness must walk files rather than stat dirs.
	it("rebuilds for an existing nested source edit even when its directory stays old", () => {
		const files = checkout();
		utimesSync(files.distIndex, OLD, OLD);
		utimesSync(files.distServer, OLD, OLD);
		utimesSync(files.sourceDir, OLD, OLD);
		utimesSync(files.sourceFile, EDITED, EDITED);

		const runBuild = vi.fn(() => {
			utimesSync(files.distIndex, REBUILT, REBUILT);
			utimesSync(files.distServer, REBUILT, REBUILT);
		});
		ensureDistFresh({
			quiet: true,
			resolveServerPath: () => files.distServer,
			runBuild,
		});

		expect(runBuild).toHaveBeenCalledOnce();
		expect(runBuild).toHaveBeenCalledWith(files.root);
	});

	// test-contract: boundary — an installed package has runtime artifacts but
	// no source checkout, so startup must not attempt a local npm build.
	it("leaves an installed-package layout without src unchanged", () => {
		const files = checkout();
		rmSync(join(files.root, "src"), { recursive: true, force: true });
		const runBuild = vi.fn();

		ensureDistFresh({
			quiet: true,
			resolveServerPath: () => files.distServer,
			runBuild,
		});

		expect(runBuild).not.toHaveBeenCalled();
	});

	// test-contract: security — a standalone managed artifact does not imply
	// that any ancestor directory is the Interlinked source checkout.
	it("does not infer a source root from .interlinked/harness-server", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-managed-runtime-"));
		roots.push(root);
		const managedDir = join(root, ".interlinked");
		mkdirSync(managedDir, { recursive: true });
		const managedServer = join(managedDir, "harness-server");
		writeFileSync(managedServer, "standalone runtime\n");
		const readStaleness = vi.fn(() => ({ stale: true, newestSrcMs: 2, buildMs: 1 }));
		const runBuild = vi.fn();

		ensureDistFresh({
			quiet: true,
			resolveServerPath: () => managedServer,
			readStaleness,
			runBuild,
		});

		expect(readStaleness).not.toHaveBeenCalled();
		expect(runBuild).not.toHaveBeenCalled();
	});
});
