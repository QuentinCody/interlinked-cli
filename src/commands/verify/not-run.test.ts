import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogSources } from "../../lib/metrics/catalog-sources.js";
import { buildVerifyJson } from "./output-json.js";
import { emptyResults } from "./tool-results-types.js";
import { createScanLedger } from "./scan-ledger.js";
import { computeNotRun, notRunContextFor, NOT_RUN_REASONS, placementFor, resultLocation, type NotRunContext } from "./not-run.js";
import { SWEEP_INLINE_IDS } from "./registry-sweep.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const base: NotRunContext = { allChecks: false, suggestions: false, structure: false, skipChecks: new Set(), toolsRun: [] };
const contexts: Array<[string, NotRunContext]> = [
	["default", base],
	["all-checks", { ...base, allChecks: true }],
	["all-checks + suggestions + structure", { ...base, allChecks: true, suggestions: true, structure: true }],
	["only tsc", { ...base, only: "tsc", toolsRun: ["tsc"] }],
	["tools ran", { ...base, allChecks: true, toolsRun: ["tsc", "biome", "eslint", "shellcheck", "gitleaks", "semgrep"] }],
];

function jsonFor(ctx: NotRunContext): Record<string, unknown> {
	const ledger = createScanLedger();
	return buildVerifyJson({
		tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [], gitleaksResults: [], auditResult: null,
		cq: emptyResults(), suggestions: ctx.suggestions ? new Map() : null, totalFiles: 0, scanLedger: ledger,
		notRun: computeNotRun(ctx), runContext: ctx,
		checkCoverage: { toolsRun: ctx.toolsRun.map((id) => ({ id })) as never, skipped: [] },
	}) as Record<string, unknown>;
}

function at(json: Record<string, unknown>, location: string): unknown {
	let node: unknown = json;
	for (const part of location.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

describe("catalog placement — every check id appears exactly once", () => {
	it("records effective exclusions and distinguishes unavailable tools from failed or deferred executions", () => {
		const ctx: NotRunContext = { ...base, skipChecks: new Set(["omitted_private_parameter"]), skipped: [
			{ check: "semgrep", category: "error", reason: "malformed report" },
			{ check: "gitleaks", category: "timeout", reason: "deadline expired" },
			{ check: "eslint", category: "tool_missing", reason: "not installed" },
			{ check: "tsc", category: "resource_busy", reason: "resource lease held" },
			{ check: "ruff", category: "file_type_mismatch", reason: "no applicable inputs" },
		] };
		const entries = computeNotRun(ctx);
		expect(entries["inline:omitted_private_parameter"]?.reason).toBe("not_selected");
		expect(entries["tool_quality:semgrep"]).toEqual({ reason: "external_tool_error", detail: "malformed report" });
		expect(entries["tool_quality:gitleaks"]?.reason).toBe("external_tool_timeout");
		expect(entries["tool_quality:eslint"]?.reason).toBe("external_tool_missing");
		expect(entries["tool_quality:typescript"]?.reason).toBe("resource_busy");
		expect(entries["tool_quality:ruff_lint"]?.reason).toBe("not_applicable");
		expect(entries["tool_quality:actionlint"]?.reason).toBe("execution_unavailable");
		expect(computeNotRun({ ...ctx, only: "typescript" })["tool_quality:semgrep"]?.reason).toBe("not_selected");
	});
	it("retains exclusions from discovery and an unavailable external phase without inventing an absent executable", () => {
		const ctx = notRunContextFor({ only: undefined, skipChecks: new Set(["semgrep"]), opts: {}, toolsRun: [], skipped: [
			{ check: "external_tools", category: "timeout", reason: "phase deadline" },
		], diagnostics: [] });
		expect(computeNotRun(ctx)["tool_quality:semgrep"]?.reason).toBe("not_selected");
		expect(computeNotRun(ctx)["tool_quality:gitleaks"]).toEqual({ reason: "external_tool_timeout", detail: "phase deadline" });
	});
	for (const [name, ctx] of contexts) {
		it(`P1: [${name}] each catalog row is a result or a not_run entry, never both, never neither`, () => {
			const json = jsonFor(ctx);
			const notRun = json.not_run as Record<string, { reason: string; detail: string }>;
			let results = 0;
			for (const source of catalogSources()) {
				const placement = placementFor(source, ctx);
				const inNotRun = Object.hasOwn(notRun, source.key);
				if (placement.kind === "result") {
					results++;
					expect(inNotRun, `${source.key} is placed as a result and also listed in not_run`).toBe(false);
					expect(at(json, resultLocation(source, ctx)), `${source.key} has no result at ${resultLocation(source, ctx)}`).toBeDefined();
				} else {
					expect(inNotRun, `${source.key} is neither a result nor in not_run`).toBe(true);
					expect(notRun[source.key]?.reason).toBe(placement.reason);
				}
			}
			expect(results + Object.keys(notRun).length).toBe(catalogSources().length);
		});
	}
	it("P2: every not_run reason is one of the published codes and carries a detail", () => {
		const notRun = computeNotRun(base);
		for (const entry of Object.values(notRun)) {
			expect(NOT_RUN_REASONS).toContain(entry.reason);
			expect(entry.detail.length).toBeGreaterThan(5);
		}
	});
	it("P3: not_run holds no id that is not in the catalog", () => {
		const keys = new Set(catalogSources().map((source) => source.key));
		for (const key of Object.keys(computeNotRun(base))) expect(keys.has(key)).toBe(true);
	});
	it("N1: --all-checks turns every sweep id from opt_in_only into a result", () => {
		const off = computeNotRun(base);
		const on = computeNotRun({ ...base, allChecks: true });
		for (const id of SWEEP_INLINE_IDS) {
			expect(off[`inline:${id}`]?.reason).toBe("opt_in_only");
			expect(on[`inline:${id}`]).toBeUndefined();
		}
	});
});

describe("inline checks are wired into verify (a new registry id cannot be added without a place)", () => {
	const sources = readdirSync(HERE)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.map((name) => readFileSync(join(HERE, name), "utf8"))
		.join("\n");
	const sweepSet = new Set(SWEEP_INLINE_IDS);
	const inline = catalogSources().filter((source) => source.family === "inline");
	for (const source of inline.filter((entry) => !sweepSet.has(entry.id))) {
		it(`N2: ${source.id} is named in the per-file battery or the output code`, () => {
			expect(sources.includes(`"${source.id}"`) || sources.includes(`'${source.id}'`), `${source.id} has no place in src/commands/verify`).toBe(true);
		});
	}
});
