// ===========================================
// `interlinked caps` — view, set, and explain the quality-metric caps
// ===========================================
// One surface for the six caps/goals the harness enforces (lines / function
// tokens / cyclomatic / cognitive / CRAP / coverage). We ship conservative defaults; every user tunes their own caps
// here, written to the committed `.interlinked/metric-caps.json`. All metric
// definitions come from the single-sourced METRIC_DEFS glossary in
// `metric-caps.ts`, so the command, the block messages, and the generated docs
// describe each metric identically — no agent is ever confused about what a
// metric is or how to change it.

import {
	isComplexityMetric,
	loadFunctionComplexityBaseline,
} from "../harness/function-complexity-baseline.js";
import { loadLargeFileBaseline } from "../harness/large-file-policy.js";
import {
	COVERAGE_SCALE_MAX,
	DEFAULT_MAX_FUNCTION_TOKENS,
	METRIC_DEFS,
	resolveMetricCaps,
} from "../harness/metric-caps.js";
import { type CapsRatchetOpts, capsRatchetAction, writeMetricCapOverride } from "./caps-ratchet.js";

interface CapRow {
	key: string;
	label: string;
	value: number;
	unit: string;
	source: string;
	defaultValue: number;
	stricter: string;
}

/** Resolve every metric's effective cap + provenance, the same way the gates do
 *  (metric-caps.json override → legacy source → shipped default). */
function buildRows(cwd: string): CapRow[] {
	const baseline = loadLargeFileBaseline(cwd)?.max_lines;
	const resolved = resolveMetricCaps(cwd, baseline !== undefined ? { max_lines: baseline } : {});
	return METRIC_DEFS.map((d) => {
		const r = resolved[d.configKey];
		return {
			key: d.key,
			label: d.label,
			value: r.value,
			unit: d.unit,
			source: r.source,
			defaultValue: d.defaultValue,
			stricter: d.stricter,
		};
	});
}

/**
 * Render one `caps` row. Coverage is a GOAL, not a cap (nothing above it is
 * penalized, and it cannot exceed the scale's own 100): the number states
 * where the hold-or-rise ratchet is heading, while `interlinked adopt` seeds
 * today's per-file % as the floor. Same semantics as `formatMetricDefaultRow`
 * in harness/metric-caps.ts (operator reports 2026-08-16/17).
 */
function formatCapShowRow(r: CapRow): string {
	if (r.stricter === "higher") {
		return (
			`${r.key.padEnd(11)} goal ${String(r.value).padStart(3)} %` +
			`     — ratchets rise toward it from your adopted floor [${r.source}; default ${r.defaultValue}]`
		);
	}
	const unit = r.unit ? ` ${r.unit}` : "";
	return (
		`${r.key.padEnd(11)} ≤ ${String(r.value).padStart(3)}${unit.padEnd(9)} ` +
		`[${r.source}; ${r.stricter}-is-stricter; default ${r.defaultValue}]`
	);
}

/** `interlinked caps` — show the six effective caps/goals + where each came from. */
export async function capsShowAction(
	opts: { json?: boolean },
	deps: { cwd?: string } = {},
): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const rows = buildRows(cwd);
	if (opts.json) {
		const obj: Record<string, { value: number; source: string; default: number }> = {};
		for (const r of rows) obj[r.key] = { value: r.value, source: r.source, default: r.defaultValue };
		console.log(JSON.stringify(obj, null, 2));
		return 0;
	}
	console.log("Quality-metric caps  (change: interlinked caps set <metric> <value>):");
	for (const r of rows) console.log(`  ${formatCapShowRow(r)}`);
	console.log("Run `interlinked caps explain` for what each metric means.");
	return 0;
}

function validateFunctionTokenValue(n: number): string | null {
	if (!Number.isInteger(n)) return "function-tokens cap must be an integer";
	if (n < 1 || n > DEFAULT_MAX_FUNCTION_TOKENS) {
		return `function-tokens cap must be between 1 and ${DEFAULT_MAX_FUNCTION_TOKENS}`;
	}
	return null;
}

/** Validate a proposed cap value for `metricKey`; null when valid, else an error. */
function validateValue(metricKey: string, n: number): string | null {
	if (!Number.isFinite(n)) return "value must be a number";
	if (metricKey === "function-tokens") return validateFunctionTokenValue(n);
	if (metricKey === "coverage") {
		return n < 1 || n > COVERAGE_SCALE_MAX
			? "coverage goal must be between 1 and 100 (it is a target, not a cap — 100 is the scale's own ceiling)"
			: null;
	}
	return n <= 0 ? `${metricKey} cap must be a positive number` : null;
}

function functionTokenLoosening(
	metricKey: string,
	n: number,
	cwd: string,
): string | null {
	if (metricKey !== "function-tokens") return null;
	const current = resolveMetricCaps(cwd).max_function_tokens.value;
	return n > current
		? `${n} would loosen the committed ${current}-token water-line; this cap may only tighten`
		: null;
}

/**
 * A cyclomatic/cognitive cap whose grandfather ledger already has a section
 * must not drift from that section: the write gates judge every unlisted
 * function against the EFFECTIVE cap, so a stale ledger turns held functions
 * into blocks on unrelated edits. Hand such a change to `caps ratchet`, which
 * regenerates the section shrink-only (and refuses to loosen). No section ⇒
 * nothing to keep in step ⇒ the plain cap write below.
 */
function ledgerFollowsCap(cwd: string, metricKey: string): boolean {
	return isComplexityMetric(metricKey) && loadFunctionComplexityBaseline(cwd)?.metrics[metricKey] !== undefined;
}

/** `interlinked caps set <metric> <value>` — write one cap to metric-caps.json
 *  (the metric-caps writer itself lives in caps-ratchet.ts, the ONE internal writer). */
export async function capsSetAction(
	metric: string,
	value: string,
	opts: { json?: boolean },
	deps: { cwd?: string } = {},
): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const def = METRIC_DEFS.find((d) => d.key === metric);
	if (!def) {
		console.error(`Unknown metric "${metric}". Valid: ${METRIC_DEFS.map((d) => d.key).join(", ")}.`);
		return 1;
	}
	const n = Number(value);
	const invalid = validateValue(def.key, n);
	if (invalid) {
		console.error(`Cannot set ${def.key}: ${invalid} (got "${value}").`);
		return 1;
	}
	const loosening = functionTokenLoosening(def.key, n, cwd);
	if (loosening) {
		console.error(`Cannot set function-tokens: ${loosening}.`);
		return 1;
	}
	if (ledgerFollowsCap(cwd, def.key)) {
		const ratchetOpts: CapsRatchetOpts = { to: String(n) };
		if (opts.json) ratchetOpts.json = true;
		return capsRatchetAction(def.key, ratchetOpts, { cwd });
	}
	writeMetricCapOverride(cwd, def.configKey, n);
	if (opts.json) {
		console.log(JSON.stringify({ metric: def.key, value: n, configKey: def.configKey }));
		return 0;
	}
	console.log(`Set ${def.label} cap → ${n}  (${def.configKey} in .interlinked/metric-caps.json).`);
	return 0;
}

/** `interlinked caps explain [metric]` — print the glossary for all or one metric. */
export async function capsExplainAction(
	metric: string | undefined,
	opts: { json?: boolean },
	_deps: { cwd?: string } = {},
): Promise<number> {
	const defs = metric ? METRIC_DEFS.filter((d) => d.key === metric) : [...METRIC_DEFS];
	if (metric && defs.length === 0) {
		console.error(`Unknown metric "${metric}". Valid: ${METRIC_DEFS.map((d) => d.key).join(", ")}.`);
		return 1;
	}
	if (opts.json) {
		console.log(
			JSON.stringify(
				defs.map((d) => ({
					key: d.key,
					label: d.label,
					definition: d.definition,
					default: d.defaultValue,
					stricter: d.stricter,
					howToConfigure: d.howToConfigure,
					fixHint: d.fixHint,
				})),
				null,
				2,
			),
		);
		return 0;
	}
	for (const d of defs) {
		const unit = d.unit ? ` ${d.unit}` : "";
		console.log(`${d.label} (${d.key})`);
		console.log(`  ${d.definition}`);
		console.log(`  Default: ${d.defaultValue}${unit} · ${d.stricter} is stricter`);
		console.log(`  Configure: ${d.howToConfigure}`);
		console.log(`  Fix: ${d.fixHint}`);
		console.log("");
	}
	return 0;
}
