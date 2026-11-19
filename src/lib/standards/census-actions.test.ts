import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectStandardsReport } from "./census.js";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import { hashBytes } from "../metrics/inventory.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = realpathSync(mkdtempSync(join(process.cwd(), "scratch", "standards-actions-")));
	roots.push(root);
	writeFileSync(join(root, "source.ts"), 'export const left: any = 1, right: any = 2;\nexport const state = new Map();\nexport function fail() {\nthrow "failure";\n}\n');
	return root;
}

it("P1 reaches every real syntax, deterministic and semantic occurrence through the action export", () => {
	const report = collectStandardsReport(fixture());
	expect(new Set(report.occurrences.map(row => row.kind))).toEqual(new Set(["ast_occurrence", "detector_match", "semantic_candidate"]));
	const refs = new Set(report.actions.actions.flatMap(action => action.evidence.flatMap(row => row.evidenceRefs ?? [])));
	expect(report.occurrences.filter(row => !refs.has(row.id))).toEqual([]);
	expect(report.actions.actions.every(row => ["measurement", "candidate", "evidence_gap"].includes(row.classification))).toBe(true);
	expect(report.actions.actions.every(row => row.enforcement === "report" && row.inferenceCostUsd === 0)).toBe(true);
});

it("P2 preserves separate same-line syntax anchors with their source and unit references", () => {
	const report = collectStandardsReport(fixture());
	const rows = report.occurrences.filter(row => row.rule === "explicit_any");
	expect(rows).toHaveLength(2);
	const actions = rows.map(row => report.actions.actions.find(action => action.evidence.some(evidence => evidence.evidenceRefs?.includes(row.id))));
	expect(actions.every(Boolean)).toBe(true);
	expect(new Set(actions.map(action => action?.id)).size).toBe(2);
	for (const [index, row] of rows.entries()) expect(actions[index]?.evidence).toContainEqual(expect.objectContaining({
		classification: "measurement", sourceHash: row.sourceHash, startOffset: row.startOffset, endOffset: row.endOffset,
		evidenceRefs: expect.arrayContaining([row.id, ...row.unitIds]),
	}));
});

it("P3 retains inline/file suppression while preserving the original observation classification", () => {
	const root = fixture();
	writeFileSync(join(root, "inline.ts"), 'export function fail() {\n// interlinked-ignore: throw_literal — deliberate fixture\nthrow "failure";\n}\n');
	writeFileSync(join(root, "file.ts"), 'export function fail() {\nthrow "failure";\n}\n');
	writeFileSync(join(root, "candidate.ts"), '// interlinked-ignore: fuzzy_responsibility_name — deliberate fixture\nclass EntityManager {}\n');
	mkdirSync(join(root, ".interlinked"));
	writeFileSync(join(root, ".interlinked/verify-suppressions.json"), JSON.stringify({ "file.ts": { throw_literal: { reason: "deliberate fixture", by: "test", at: "2026-11-12" } } }));
	const report = collectStandardsReport(root);
	for (const row of report.occurrences.filter(row => row.suppressed)) {
		const observation = report.actions.actions.flatMap(action => action.evidence).find(evidence => evidence.evidenceRefs?.includes(row.id));
		expect(observation).toMatchObject({ suppressed: true, suppression: row.suppression,
			classification: row.kind === "semantic_candidate" ? "candidate" : "measurement" });
	}
	expect(new Set(report.occurrences.filter(row => row.suppressed).map(row => row.suppression))).toEqual(new Set(["inline", "file"]));
});

it("P4 exports actual registry, unresolved discovery and missing compiler evidence separately", () => {
	const root = fixture();
	writeFileSync(join(root, "consumer.ts"), 'import { value } from "./index.js";\nexternalCall();\n');
	const report = collectStandardsReport(root), observations = report.actions.actions.flatMap(action => action.evidence);
	expect(report.notMeasured.some(reason => reason.includes("import_from_own_barrel"))).toBe(true);
	for (const [index] of report.notMeasured.entries()) expect(observations.some(row => row.classification === "evidence_gap" && row.producerRefs?.includes(`/notMeasured/${index}`))).toBe(true);
	expect(report.discovery.unresolvedCalls).toBeGreaterThan(0);
	expect(observations.some(row => row.classification === "evidence_gap" && row.producerRefs?.includes("/discovery/unresolvedCalls"))).toBe(true);
	expect(report.compiler.state).toBe("missing");
	expect(observations.some(row => row.classification === "evidence_gap" && row.producerRefs?.includes("/compiler/state"))).toBe(true);
});

it.each([false, true])("P5 freezes applied suppression bytes across policy mutation, restore=%s", restore => {
	const root = fixture(), directory = join(root, ".interlinked"); mkdirSync(directory);
	const policy = JSON.stringify({ "*.ts": { throw_literal: { reason: "fixture contract", by: "test", at: "2026-11-12" } } });
	const path = join(directory, "verify-suppressions.json"); writeFileSync(path, policy);
	writeFileSync(join(root, "second.ts"), 'export function fail() {\nthrow "failure";\n}\n');
	const check = CHECK_REGISTRY.find(row => row.id === "throw_literal")!, original = check.fn;
	let calls = 0;
	vi.spyOn(check, "fn").mockImplementation((content, file) => {
		calls++;
		writeFileSync(path, restore && calls > 1 ? policy : "{}");
		return original(content, file);
	});
	const report = collectStandardsReport(root), rows = report.occurrences.filter(row => row.rule === "throw_literal");
	expect(rows).toHaveLength(2);
	expect(rows.every(row => row.suppressed && row.suppression === "file")).toBe(true);
	expect(report.suppressionPolicy).toMatchObject({ state: "read", sha256: hashBytes(policy),
		consistency: restore ? "stable_capture" : "changed", final: { state: "read", sha256: hashBytes(restore ? policy : "{}") } });
	const observation = report.actions.actions.flatMap(action => action.evidence).find(evidence => evidence.evidenceRefs?.includes(rows[0]!.id));
	expect(observation?.producerRefs).toEqual(expect.arrayContaining([`suppressionPolicy:read:${hashBytes(policy)}`,
		`finalSuppressionPolicy:read:${hashBytes(restore ? policy : "{}")}`]));
});

it("P6 keeps invalid capture as unknown suppression evidence", () => {
	const root = fixture(), directory = join(root, ".interlinked"); mkdirSync(directory);
	writeFileSync(join(directory, "verify-suppressions.json"), "{ invalid");
	const report = collectStandardsReport(root);
	expect(report.suppressionPolicy.state).toBe("invalid");
	const row = report.occurrences.find(row => row.rule === "throw_literal")!;
	expect(row).toMatchObject({ suppressionState: "unknown" });
	const observation = report.actions.actions.flatMap(action => action.evidence).find(evidence => evidence.evidenceRefs?.includes(row.id));
	expect(observation?.suppressed).toBeUndefined();
	expect(observation?.suppression).toBe("unavailable");
	expect(observation?.suppressionState).toBe("unknown");
	expect(report.actions.actions.some(action => action.classification === "evidence_gap" && action.evidence.some(evidence => evidence.producerRefs?.includes("/suppressionPolicy")))).toBe(true);
});
