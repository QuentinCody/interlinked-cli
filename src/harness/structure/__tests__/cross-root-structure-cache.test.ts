// Regression for the 2026-10-23 glossary_residue incident
// (scratch/instruction-files/glossary-residue.md): the daemon held ONE
// structure config and ONE artifact graph for its life, so the first root with
// a `structure.json` (the nested `fixture-declared` test fixture) judged every
// later edit of the outer repository with the fixture's glossary ("agent" is
// deprecated there). Real disk, real project-root resolution, real structure
// pipeline: no module mocks.

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSession } from "../../__tests__/fixtures/evaluator.js";
import { makePerFileCheckCtx, makeServerRuntime } from "../../server/__tests__/fixtures.js";
import { runStructureChecksPhase } from "../../server/post-tool-file-checks-phases.js";
import type { ServerRuntime } from "../../server/runtime-context.js";
import type { CheckResultEntry, SessionTrajectory } from "../../types.js";
import { ArtifactGraph } from "../artifact-graph.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "fixture-declared");

describe("structure cache across project roots (real disk)", () => {
	let outer: string;
	let nested: string;
	let ctx: ServerRuntime;
	let session: SessionTrajectory;

	beforeEach(() => {
		outer = realpathSync(mkdtempSync(join(tmpdir(), "structure-cross-root-")));
		// The outer project: a tsconfig root with no interlinked/structure.json.
		writeFileSync(join(outer, "tsconfig.json"), "{}\n");
		mkdirSync(join(outer, "src"));
		writeFileSync(join(outer, "src", "runner.ts"), 'export const userAgent = "agent";\n');
		// The nested project: a copy of the fixture (its package.json makes it a root).
		nested = join(outer, "vendor", "fixture-declared");
		cpSync(FIXTURE, nested, {
			recursive: true,
			filter: (src) => !src.split(sep).includes(".interlinked"),
		});
		ctx = makeServerRuntime({ cwd: outer });
		session = makeSession();
	});

	afterEach(() => {
		rmSync(outer, { recursive: true, force: true });
	});

	/** One PostToolUse structure phase for `file`, recorded as the session does. */
	function editAndCheck(file: string): CheckResultEntry[] {
		session.files_written.add(relative(outer, file));
		session.files_written.add(file);
		const acc = makePerFileCheckCtx({ postStartMs: Date.now() });
		runStructureChecksPhase(ctx, file, true, session, { decision: "allow" }, acc);
		return acc.allCheckResults.filter((r) => r.source === "structure");
	}

	const glossary = (rs: CheckResultEntry[]) => rs.filter((r) => r.name === "glossary_residue");

	describe("positive (must fire)", () => {
		it("P1: the nested fixture's own edit is judged by the fixture's glossary", () => {
			const findings = glossary(editAndCheck(join(nested, "src", "app.ts")));
			expect(findings.map((f) => f.file)).toEqual(["src/app.ts"]);
			expect(findings[0]?.message).toContain('"agent"');
		});

		it("P2: the nested root keeps its own config after an outer-project run", () => {
			editAndCheck(join(nested, "src", "client.ts"));
			editAndCheck(join(outer, "src", "runner.ts"));
			expect(glossary(editAndCheck(join(nested, "src", "app.ts"))).map((f) => f.file)).toEqual(["src/app.ts"]);
		});
	});

	describe("negative (must not fire)", () => {
		it("N1: after a nested src/client.ts run, an outer file containing \"agent\" gets 0 findings", () => {
			editAndCheck(join(nested, "src", "client.ts"));
			expect(editAndCheck(join(outer, "src", "runner.ts"))).toEqual([]);
			// The outer run really happened (no vacuous pass): it built its own graph.
			const outerGraph = ctx.structureCache.get(outer)?.graph;
			expect(outerGraph).toBeInstanceOf(ArtifactGraph);
			expect(outerGraph).not.toBe(ctx.structureCache.get(nested)?.graph);
		});

		it("N2: the outer root's negative answer survives a second outer edit", () => {
			editAndCheck(join(nested, "src", "client.ts"));
			editAndCheck(join(outer, "src", "runner.ts"));
			expect(editAndCheck(join(outer, "src", "runner.ts"))).toEqual([]);
			expect(ctx.structureCache.get(outer)?.config).toBeNull();
		});
	});
});
