import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { detectCommanderOptionAttribute } from "./commander-option-attribute.js";
import { withCommanderOptionEvidence } from "./commander-option-evidence.js";
import { getProjectCheckEvidence, withProjectCheckEvidence } from "./project-check-evidence.js";
import { withCheckRoot } from "./check-root.js";
import { buildAgentSafetyChecks } from "../check-registry/index.js";
import { runAgentSafetyChecks } from "../../commands/verify/file-checks-agent-safety.js";
import { emptyResults } from "../../commands/verify/tool-results-types-keys.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bad = 'export function run(options) { const dry = options["dry-run"]; consume(options); return dry; }';
const fixed = 'export function run(options) { return options.dryRun ?? options["dry-run"]; }';
const registrar = (action = "run", extra = 'import { run } from "./handler.js";') => `import { Command } from "commander"; ${extra}\nnew Command().option("--dry-run").action(${action});`;
function project(reg = registrar(), handler = bad) {
	const root = mkdtempSync(join(resolve("scratch"), "commander-project-")); roots.push(root);
	const registration = join(root, "registrar.ts"), target = join(root, "handler.ts");
	writeFileSync(registration, reg); writeFileSync(target, handler);
	const gaps = vi.fn();
	const query = { root, importers: () => ({ files: [registration], complete: false, reason: "existing regex importer index" }), onUnavailable: gaps };
	return { root, registration, target, gaps, query, reg, handler };
}

it.each([
	registrar(),
	registrar("opts => run(opts)"),
	registrar('async opts => { const { run } = await import("./handler.js"); await run(opts); }', ""),
	registrar("opts => invoke(opts)", 'import { run as invoke } from "./handler.js";'),
])("MUST-FIRE: handler-only edits follow resolved direct/static/dynamic forwarding %s", reg => {
	const p = project(reg);
	const matches = withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(bad, p.target));
	expect(matches).toHaveLength(1);
	expect(matches[0]?.text).toContain("dryRun");
	expect(matches[0]?.text).toContain("registrar.ts");
	expect(p.gaps).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/partial|inventory/) }));
});

// Faithful boundary excerpt from ec85adc60497c80ccca037f83a9a3bad7c8c572d.
// Original init.ts SHA256 bc025fab8a652f835610b2a2fdac24d376ce9ed41d8cdf0643b6f3fcab37f122.
// Original setup.ts SHA256 ee0afe02d35ea8cda649a02288dd05743065f3741b6834a6735b5e69220cea43.
// The original effects reproduction is retained in scratch/cli-surface-mutation-probe.test.ts.
const originalRegistration = `import type { Command } from "commander";
export function register(program: Command) {
 program.command("init").option("--dry-run").option("--sync-mode <mode>").action(async opts => {
  const { initCommand } = await import("./handler.js");
  await initCommand(opts);
 });
}`;
const originalHandler = `export async function initCommand(options) {
 const dryRun = options["dry-run"] || false;
 await resolveServerUrl(options);
 const syncMode = parseSyncMode(options["sync-mode"] || "realtime");
 return { dryRun, syncMode };
}`;
it("MUST-FIRE: preserves the original setup/init early dry-run failure boundary", () => {
	const p = project(originalRegistration, originalHandler);
	const matches = withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(originalHandler, p.target));
	expect(matches).toContainEqual(expect.objectContaining({ line: 2, text: expect.stringContaining("dryRun") }));
	expect(matches.some(match => match.text.includes("syncMode"))).toBe(false);
	expect(p.gaps).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining("escape") }));
});

it("MUST-NOT-FIRE: fixed handler boundary keeps canonical/legacy fallback", () => {
	const handler = originalHandler.replace('options["dry-run"] || false', 'options.dryRun ?? options["dry-run"] ?? false').replace('options["sync-mode"] || "realtime"', 'options.syncMode ?? options["sync-mode"] ?? "realtime"');
	const p = project(originalRegistration, handler);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(handler, p.target))).toEqual([]);
});

it("overlays the edited handler and refreshes registrar contents between invocations", () => {
	const p = project(registrar(), fixed);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(bad, p.target))).toHaveLength(1);
	writeFileSync(p.registration, registrar("opts => run(normalize(opts))"));
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(bad, p.target))).toEqual([]);
	writeFileSync(p.registration, registrar());
	unlinkSync(p.registration);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(bad, p.target))).toEqual([]);
	expect(p.gaps).toHaveBeenCalledWith(expect.objectContaining({ file: p.registration, reason: expect.stringMatching(/read|ENOENT/) }));
});

it.each([
	'export function run(options) { normalize(options); return options["dry-run"]; }',
	'export function run(options) { options["dry-run"] = options.dryRun; return options["dry-run"]; }',
	'export function run(options) { const copy = normalize(options); return copy["dry-run"]; }',
	'export function run(options) { options.normalize(); return options["dry-run"]; }',
	'export function run(options) { [options["dry-run"]] = [true]; return options["dry-run"]; }',
	'export function run(options) { ({ legacy: options["dry-run"] } = { legacy: true }); return options["dry-run"]; }',
	'export function run(options) { const later = () => options["dry-run"]; normalize(options); return later(); }',
	'export function run(options) { const carry = { options }; normalize(carry); return options["dry-run"]; }',
	'export let run = options => { return options["dry-run"]; }; run = legacyHandler;',
	'export function run(options) { return options["dry-run"]; } run = legacyHandler;',
	fixed,
])("MUST-NOT-FIRE: normalization, mutation before read and fallback preserve uncertainty %s", handler => {
	const p = project(registrar(), handler);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(handler, p.target))).toEqual([]);
});

it.each([
	registrar('opts => run(opts, normalize(opts))'),
	registrar('opts => run(opts, (opts["dry-run"] = true))'),
	registrar('async opts => { let { run } = await import("./handler.js"); run = normalize; return run(opts); }', ""),
])("MUST-NOT-FIRE: argument effects and mutable imported aliases are unresolved %s", reg => {
	const p = project(reg);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(bad, p.target))).toEqual([]);
	expect(p.gaps).toHaveBeenCalled();
});

it("tracks every raw options argument when the same object is forwarded twice", () => {
	const handler = 'export function run(first, options) { return options["dry-run"]; }';
	const p = project(registrar('opts => run(opts, opts)'), handler);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(handler, p.target))).toHaveLength(1);
});

it("keeps mutation through an alternate forwarded parameter unknown", () => {
	const handler = 'export function run(alias, options) { normalize(alias); return options["dry-run"]; }';
	const p = project(registrar('opts => run(opts, opts)'), handler);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(handler, p.target))).toEqual([]);
});

it("retains deferred captured-read uncertainty in complete foreground evidence", () => {
	const handler = 'export function run(options) { const later = () => options["dry-run"]; normalize(options); return later(); }';
	const p = project(registrar(), handler);
	withProjectCheckEvidence(p.root, [p.registration, p.target], () => expect(detectCommanderOptionAttribute(handler, p.target)).toEqual([]), p.gaps);
	expect(p.gaps).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/closure|deferred/) }));
});

it("retains concise exported arrow handlers", () => {
	const handler = 'export const run = options => options["dry-run"];';
	const p = project(registrar(), handler);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(handler, p.target))).toHaveLength(1);
});

it("retains incoming handler evidence when the handler also imports Commander", () => {
	const handler = 'import type { Command } from "commander"; export function run(options) { return options["dry-run"]; }';
	const p = project(registrar(), handler);
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(handler, p.target))).toHaveLength(1);
});

it("retains known findings with an explicitly incomplete reverse inventory", () => {
	const p = project();
	expect(withCommanderOptionEvidence({ ...p.query, importers: () => ({ files: [], complete: false, reason: "inventory unavailable" }) }, () => detectCommanderOptionAttribute(bad, p.target))).toEqual([]);
	expect(p.gaps).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining("inventory unavailable") }));
});

it("reports registrar-only forwarding with the target location in its evidence", () => {
	const p = project();
	const matches = withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(p.reg, p.registration));
	expect(matches).toHaveLength(1);
	expect(matches[0]?.text).toContain("handler.ts");
});

it("retains matching handler evidence through verify and registry dispatch without a Commander keyword", () => {
	const p = project();
	withProjectCheckEvidence(p.root, [p.registration, p.target], () => {
		const direct = detectCommanderOptionAttribute(bad, p.target);
		const post = buildAgentSafetyChecks(bad, p.target, "post").find(check => check.name === "commander_option_attribute");
		const result = emptyResults();
		runAgentSafetyChecks({ content: bad, file: p.target, relPath: "handler.ts", cwd: p.root, r: result, piiOpts: {} });
		expect(direct).toHaveLength(1);
		expect(post?.fn()).toEqual(direct);
		expect(result.commanderOptionAttribute.map(row => row.message)).toEqual(direct.map(row => row.text));
	}, p.gaps);
});

it("standalone invocation never invents reverse importer evidence", () => {
	const result = withCheckRoot(process.cwd(), () => detectCommanderOptionAttribute(bad, "handler.ts"));
	expect(result.result).toEqual([]);
	expect(result.notMeasured.join("\n")).toContain("reverse");
});

it("does not query dependencies for quoted or commented dashed-read text", () => {
	const p = project(), importers = vi.fn(() => ({ files: [p.registration], complete: false }));
	const content = 'export const example = \'options["dry-run"]\'; // options["dry-run"]';
	expect(withCommanderOptionEvidence({ ...p.query, importers }, () => detectCommanderOptionAttribute(content, p.target))).toEqual([]);
	expect(importers).not.toHaveBeenCalled();
	expect(p.gaps).not.toHaveBeenCalled();
});

it.each([
	'/** @param {import("commander").Command} program */ export function register(program) { program.option("--dry-run").action(opts => opts["dry-run"]); }',
	'import { Command } from "commander"; customFactory().option("--dry-run").action(opts => opts["dry-run"]);',
])("retains unresolved model receiver notices in complete foreground evidence %s", content => {
	const p = project(content);
	withProjectCheckEvidence(p.root, [p.registration, p.target], () => expect(detectCommanderOptionAttribute(content, p.registration)).toEqual([]), p.gaps);
	expect(p.gaps).toHaveBeenCalledWith(expect.objectContaining({ check: "commander_option_attribute", file: p.registration, reason: expect.stringContaining("receiver") }));
});

it("reports a failed dependency AST once through the scoped model reporter", () => {
	const p = project(registrar(), 'export function run(options) { options["dry-run"];');
	expect(withCommanderOptionEvidence(p.query, () => detectCommanderOptionAttribute(p.reg, p.registration))).toEqual([]);
	expect(p.gaps.mock.calls.filter(([gap]) => gap.file === p.target)).toHaveLength(1);
});

it.each([
	'opts.normalize(); return opts["dry-run"];',
	'[opts["dry-run"]] = [true]; return opts["dry-run"];',
	'({ legacy: opts["dry-run"] } = { legacy: true }); return opts["dry-run"];',
])("retains concrete unsafe local reads as scoped missing evidence %s", body => {
	const content = `import { Command } from "commander"; new Command().option("--dry-run").action(opts => { ${body} });`;
	const p = project(content);
	withProjectCheckEvidence(p.root, [p.registration, p.target], () => {
		getProjectCheckEvidence()?.sources();
		expect(getProjectCheckEvidence()?.complete).toBe(true);
		expect(detectCommanderOptionAttribute(content, p.registration)).toEqual([]);
	}, p.gaps);
	expect(p.gaps).toHaveBeenCalledWith(expect.objectContaining({ check: "commander_option_attribute", file: p.registration, reason: expect.stringMatching(/dry-run.*mutation|dry-run.*escape/) }));
});

it.each([
	'[opts["dry-run"]] = [true];',
	'({ legacy: opts["dry-run"] } = { legacy: true });',
	'opts.normalize(); return opts.dryRun ?? opts["dry-run"];',
])("keeps assignment-only targets and canonical fallbacks free of local read gaps %s", body => {
	const content = `import { Command } from "commander"; new Command().option("--dry-run").action(opts => { ${body} });`;
	const p = project(content);
	withProjectCheckEvidence(p.root, [p.registration, p.target], () => expect(detectCommanderOptionAttribute(content, p.registration)).toEqual([]), p.gaps);
	expect(p.gaps).not.toHaveBeenCalled();
});

it("keeps resolved forwarding without local raw reads free of legacy escape notices", () => {
	const p = project(registrar("opts => run(opts)"), fixed);
	withProjectCheckEvidence(p.root, [p.registration, p.target], () => {
		expect(detectCommanderOptionAttribute(p.reg, p.registration)).toEqual([]);
		expect(detectCommanderOptionAttribute(fixed, p.target)).toEqual([]);
	}, p.gaps);
	expect(p.gaps).not.toHaveBeenCalled();
});
