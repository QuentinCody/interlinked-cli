// Behavioral companion for `pre-tool-helpers-guard-blocks.ts`. Most of this
// module's public surface (collectDirtyDependentWarning, computeFullNewContent,
// evaluateExfilGuards, evaluateReadGuards, ...) is already exercised through
// `pre-tool-helpers.ts`'s own companion, which re-exports these same symbols —
// see `pre-tool-helpers.test.ts`. This file targets the one path that isn't:
// `runGitDiff`'s failure branch, which the memoized `diffOf` closure inside
// `collectDirtyDependentWarning` only reaches once real staged+dirty files
// already exist (every other test that drives a `git diff` failure short-
// circuits earlier, via `listGitDiffPaths`'s own catch).

import { execFileSync as realExecFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectGraph } from "../project-graph.js";

// Selectively fail only the precision-filter `git diff -- <file>` calls
// (`runGitDiff`), while every other `execFileSync` invocation — the repo
// setup below AND `listGitDiffPaths`'s own `git diff --name-only` calls —
// runs for real. This is the only way to reach `runGitDiff`'s catch: making
// ALL git calls fail would trip `listGitDiffPaths`'s earlier catch first and
// return null before `diffOf` is ever invoked.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: vi.fn((file: string, args?: readonly string[], opts?: unknown) => {
			if (file === "git" && Array.isArray(args) && args[0] === "diff" && args[1] !== "--name-only") {
				throw new Error("simulated git failure");
			}
			// SAFETY: forwarding the mock's own parameter types to the real
			// implementation's overloaded signature — the shapes are identical,
			// this only narrows past the mock wrapper's widened `unknown`/optional
			// typing back to what `execFileSync` actually declares.
			return actual.execFileSync(file, args as string[], opts as never);
		}),
	};
});

import { collectDirtyDependentWarning } from "./pre-tool-helpers-guard-blocks.js";

describe("collectDirtyDependentWarning — runGitDiff failure (fail-open)", () => {
	let repo: string;

	function git(...args: string[]): void {
		realExecFileSync("git", args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
	}

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "pth-gb-dd-"));
		git("init", "-q");
		git("config", "user.email", "t@t.test");
		git("config", "user.name", "t");
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("still surfaces the dirty-dependent warning when the precision-filter diff itself errors", () => {
		// A staged production file plus a dirty-unstaged importer, exactly like
		// the healthy case in pre-tool-helpers.test.ts — but here every
		// `git diff -- <file>` the precision filter (`diffOf` → `runGitDiff`)
		// issues throws. If the catch on line 73 were removed, that throw would
		// propagate straight out of `collectDirtyDependentWarning` and this call
		// would never return a value at all — the test would fail with an
		// uncaught exception instead of the assertion below running.
		writeFileSync(join(repo, "prod.ts"), "export function widget() {\n  return 1;\n}\n");
		writeFileSync(join(repo, "prod.test.ts"), "import { widget } from './prod';\nwidget();\n");
		git("add", ".");
		git("commit", "-qm", "base");

		writeFileSync(join(repo, "prod.ts"), "export function widget() {\n  return 2;\n}\n");
		git("add", "prod.ts");
		writeFileSync(
			join(repo, "prod.test.ts"),
			"import { widget } from './prod';\n// touch widget usage\nwidget();\n",
		);

		const graph = new ProjectGraph(repo);
		graph.initialize();
		const warning = collectDirtyDependentWarning(repo, graph);
		// `runGitDiff` caught the thrown error and returned "" for both sides;
		// `looksCoordinated(["", ""])` fails open (no extractable symbols on
		// either side) and keeps the candidate, so the warning still fires and
		// still names the dirty file — the observable a real reviewer reads.
		expect(warning).not.toBeNull();
		expect(warning).toContain("prod.test.ts");
	});
});
