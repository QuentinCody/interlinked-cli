// Pins the mutation ENGINE's operator coverage.
//
// Part of the verification-density program, Track A lane 3
// (docs/design/verification-density-program.md).
//
// Why this test exists: a mutation score is only as strong as the operator set
// that produced it. If Stryker's defaults shrink across a version bump, or
// someone quietly adds an entry to `excludedMutations`, every score in the repo
// rises without a single baseline number changing — the mutation ratchet would
// report improvement while actually testing less. That is the same class of
// silent erosion the baseline-integrity gate blocks for water-lines, so the
// operator set gets the same treatment: declared explicitly and pinned.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

interface StrykerConfig {
	mutate?: string[];
	mutator?: { excludedMutations?: string[] };
	ignorePatterns?: string[];
	testRunner?: string;
}

function loadConfig(): StrykerConfig {
	// SAFETY: this repository fixture is the Stryker config exercised below; its mutation lists and test-runner fields are asserted by this suite.
	return JSON.parse(readFileSync(resolve(REPO_ROOT, "stryker.conf.json"), "utf8")) as StrykerConfig;
}

describe("stryker.conf.json — operator coverage", () => {
	it("declares the mutator section explicitly rather than inheriting defaults", () => {
		expect(loadConfig().mutator).toBeDefined();
	});

	it("excludes NO mutation operators", () => {
		// Adding an entry here weakens every mutation score in the repo without
		// changing any baseline number. If an operator genuinely must go, say why
		// in the config comment and update this pin in the same diff.
		expect(loadConfig().mutator?.excludedMutations).toEqual([]);
	});

	it("keeps the harness socket out of the sandbox", () => {
		// Stryker sandboxes by copying the tree and crashes on the Unix socket
		// under .interlinked/ (found live 2026-07-02). Accept either the bare
		// name or the root-anchored `/.interlinked` form — entries were anchored
		// 2026-08-05 because an unanchored pattern also strips same-named
		// directories out of test fixtures.
		expect(loadConfig().ignorePatterns).toEqual(
			expect.arrayContaining([expect.stringMatching(/^\/?\.interlinked$/)]),
		);
	});

	it("runs the project's actual test runner", () => {
		expect(loadConfig().testRunner).toBe("vitest");
	});

	it("keeps a narrow default mutate target", () => {
		// Every real run overrides `--mutate`; a broad default would turn a bare
		// `npx stryker run` into a whole-repo job.
		const mutate = loadConfig().mutate ?? [];
		expect(mutate.length).toBeGreaterThan(0);
		expect(mutate.length).toBeLessThanOrEqual(3);
	});
});
