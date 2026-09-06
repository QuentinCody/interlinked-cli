import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectAdvisoryOpportunityEvidence } from "./simplify-opportunity-detectors.js";

const roots: string[] = [];

function fixture(files: Record<string, string>): { cwd: string; paths: string[] } {
	const cwd = mkdtempSync(join(tmpdir(), "simplify-opportunities-"));
	roots.push(cwd);
	const paths: string[] = [];
	for (const [relative, content] of Object.entries(files)) {
		const absolute = join(cwd, relative);
		mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
		writeFileSync(absolute, content, "utf-8");
		if (/\.[cm]?[jt]sx?$/.test(relative)) paths.push(absolute);
	}
	return { cwd, paths };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("advisory simplification opportunities", () => {
	it("finds bounded private wrappers, one-product factories, config fields, and unused runtime deps", () => {
		const project = fixture({
			"package.json": JSON.stringify({
				dependencies: { used: "1.0.0", unused: "1.0.0" },
			}),
			"src/a.ts": [
				'import { run } from "used";',
				"function local(value: string) { return run(value); }",
				"function createStore() { return new Store(); }",
				"export function publicAdapter(value: string) { return run(value); }",
				"export interface RuntimeOptions {",
				"    neverRead?: boolean;",
				"}",
				"class Store {}",
			].join("\n"),
		});
		const report = collectAdvisoryOpportunityEvidence(project.cwd, project.paths);
		const sources = report.drafts.map((draft) => draft.source);
		expect(sources).toContain("opportunity.delegate_only_wrapper");
		expect(sources).toContain("opportunity.one_product_factory");
		expect(sources).toContain("opportunity.never_read_configuration");
		expect(
			report.drafts.find((draft) => draft.key === "unused")?.estimatedDependenciesRemoved,
		).toEqual(["unused"]);
		expect(report.drafts.some((draft) => draft.summary.includes("publicAdapter"))).toBe(false);
		expect(report.drafts.every((draft) => draft.evidenceState !== "proven")).toBe(true);
	});

	it("does not treat wrappers containing validation or multiple products as the narrow patterns", () => {
		const project = fixture({
			"package.json": JSON.stringify({ dependencies: {} }),
			"src/a.ts": [
				"function guarded(value: string) { if (!value) throw new Error('x'); return run(value); }",
				"function createStore(kind: string) { if (kind) return new A(); return new B(); }",
			].join("\n"),
		});
		const report = collectAdvisoryOpportunityEvidence(project.cwd, project.paths);
		expect(report.drafts.some((draft) => draft.summary.includes("guarded"))).toBe(false);
		expect(report.drafts.some((draft) => draft.summary.includes("createStore"))).toBe(false);
	});

	it("flags a function whose measured cyclomatic complexity exceeds the hotspot threshold", () => {
		const branches = Array.from(
			{ length: 30 },
			(_, i) => `    if (value === "${i}") { return ${i}; }`,
		).join("\n");
		const project = fixture({
			"package.json": JSON.stringify({ dependencies: {} }),
			"src/a.ts": [
				"export function tangled(value: string): number {",
				branches,
				"    return -1;",
				"}",
			].join("\n"),
		});
		const report = collectAdvisoryOpportunityEvidence(project.cwd, project.paths);
		const hotspot = report.drafts.find((draft) => draft.source === "metrics.cyclomatic_hotspot");
		expect(hotspot?.summary).toBe(
			"`tangled` has measured cyclomatic complexity 31; inspect for a smaller clear implementation.",
		);
	});

	it("treats a function at or under the complexity threshold as not a hotspot", () => {
		const branches = Array.from(
			{ length: 5 },
			(_, i) => `    if (value === "${i}") { return ${i}; }`,
		).join("\n");
		const project = fixture({
			"package.json": JSON.stringify({ dependencies: {} }),
			"src/a.ts": [
				"export function mild(value: string): number {",
				branches,
				"    return -1;",
				"}",
			].join("\n"),
		});
		const report = collectAdvisoryOpportunityEvidence(project.cwd, project.paths);
		expect(report.drafts.some((draft) => draft.source === "metrics.cyclomatic_hotspot")).toBe(false);
	});

	it("treats an unparseable package.json as no manifest instead of surfacing unused-dependency findings", () => {
		const project = fixture({
			"package.json": "{ this is not valid json",
			"src/a.ts": 'import { run } from "used";\nexport function callIt() { return run(1); }\n',
		});
		const report = collectAdvisoryOpportunityEvidence(project.cwd, project.paths);
		expect(report.drafts.some((draft) => draft.source === "opportunity.unused_runtime_dependency")).toBe(
			false,
		);
	});
});
