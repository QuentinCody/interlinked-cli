import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { withCheckRoot } from "./check-root.js";
import { detectCommanderOptionAttribute } from "./commander-option-attribute.js";
import { buildAgentSafetyChecks } from "../check-registry/index.js";
import { runAgentSafetyChecks } from "../../commands/verify/file-checks-agent-safety.js";
import { emptyResults } from "../../commands/verify/tool-results-types-keys.js";

const scan = (source: string) => detectCommanderOptionAttribute(source, "cli.ts");
const command = (body: string, flags = "--dry-run") => `import { Command } from "commander";
new Command().option("${flags}").action((opts) => { ${body} });`;

describe("commander_option_attribute MUST-FIRE", () => {
	it("P1: reads the dashed spelling of a declared option", () => {
		expect(scan(command('run(opts["dry-run"]);'))).toEqual([
			expect.objectContaining({ line: 2, text: expect.stringContaining('"dryRun"') }),
		]);
	});
	it("P2: resolves an aliased Commander constructor", () => {
		expect(scan('import { Command as Cli } from "commander"; new Cli().option("--sync-mode <mode>").action(opts => opts["sync-mode"]);')).toHaveLength(1);
	});
	it("P3: resolves the imported program singleton", () => {
		expect(scan('import { program as app } from "commander"; app.option("--dry-run"); app.action(opts => opts["dry-run"]);')).toHaveLength(1);
	});
	it("P4: resolves namespace imports", () => {
		expect(scan('import * as cli from "commander"; new cli.Command().option("--dry-run").action(opts => opts["dry-run"]);')).toHaveLength(1);
	});
	it("P5: tracks separate command variable declarations", () => {
		expect(scan('import { Command } from "commander"; const app = new Command(); const task = app.command("run"); task.option("--dry-run"); task.action(opts => opts["dry-run"]);')).toHaveLength(1);
	});
	it("P6: counts positional arguments before options", () => {
		expect(scan('import { Command } from "commander"; new Command().command("run <file>").option("--dry-run").action((file, opts) => opts["dry-run"]);')).toHaveLength(1);
	});
	it("P7: accounts for argument calls", () => {
		expect(scan('import { Command } from "commander"; new Command().argument("<file>").option("--dry-run").action((file, opts) => opts["dry-run"]);')).toHaveLength(1);
	});
	it("P8: tracks direct opts captures", () => {
		expect(scan('import { Command } from "commander"; const cli = new Command().option("--dry-run"); const opts = cli.opts(); run(opts["dry-run"]);')).toHaveLength(1);
	});
	it("P9: resolves a local named action", () => {
		expect(scan('import { Command } from "commander"; function run(opts) { return opts["dry-run"]; } new Command().option("--dry-run").action(run);')).toHaveLength(1);
	});
	it("P10: normalizes the no- prefix", () => {
		expect(scan(command('use(opts["no-color"]);', "--no-color"))).toHaveLength(1);
	});
	it("P11: resolves a typed registrar parameter", () => {
		expect(scan('import type { Command as Cli } from "commander"; export function register(app: Cli) { app.command("run").option("--dry-run").action(opts => opts["dry-run"]); }')).toHaveLength(1);
	});
	it("P12: resolves standard Option objects and parse().opts()", () => {
		expect(scan('import { Command, Option as Flag } from "commander"; const cli = new Command().addOption(new Flag("--allow-empty").default(false)); const opts = cli.parse(process.argv).opts(); run(opts["allow-empty"]);')).toHaveLength(1);
	});
	it("P13: combines a command synopsis and later argument declarations", () => {
		expect(scan('import { Command } from "commander"; new Command().command("run <first>").argument("<second>").option("--dry-run").action((first, second, opts) => opts["dry-run"]);')).toHaveLength(1);
	});
	it("P14: matches the installed Commander's actual dashed-option output", () => {
		const actual = new Command().exitOverride().option("--dry-run").parse(["node", "cli", "--dry-run"]).opts();
		expect(actual).toEqual({ dryRun: true });
		expect(actual["dry-run"]).toBeUndefined();
		expect(scan(command('run(opts["dry-run"]);'))).toHaveLength(1);
	});
	it("P15: inspects a negated dry-run guard", () => {
		expect(scan(command('if (!opts["dry-run"]) write();'))).toHaveLength(1);
	});
	it("P16: returns matching evidence through PostToolUse and verify dispatch", () => {
		const content = command('run(opts["dry-run"]);');
		const post = buildAgentSafetyChecks(content, "cli.ts", "post").find(check => check.name === "commander_option_attribute");
		const results = emptyResults();
		runAgentSafetyChecks({ content, file: "cli.ts", relPath: "cli.ts", cwd: process.cwd(), r: results, piiOpts: {} });
		expect(post?.fn()).toEqual(scan(content));
		expect(results.commanderOptionAttribute).toEqual([
			{ check: "commander_option_attribute", file: "cli.ts", line: 2, message: scan(content)[0]?.text },
		]);
	});
});

describe("commander_option_attribute MUST-NOT-FIRE", () => {
	it.each([
		'opts.normalize(); return opts["dry-run"];',
		'[opts["dry-run"]] = [true]; return opts["dry-run"];',
		'({ legacy: opts["dry-run"] } = { legacy: true }); return opts["dry-run"];',
	])("N22: options mutation through methods or assignment patterns is unsupported %s", body => {
		expect(scan(command(body))).toEqual([]);
	});
	it("N23: dynamic positional declarations keep action parameter layout unknown", () => {
		expect(scan('import { Command } from "commander"; new Command().argument(spec).option("--dry-run").action(opts => opts["dry-run"]);')).toEqual([]);
	});
	it("N24: options declared after parsing cannot establish the dispatch mapping", () => {
		expect(scan('import { Command } from "commander"; const cli = new Command(); cli.action(opts => opts["dry-run"]); cli.parse(); cli.option("--dry-run");')).toEqual([]);
	});
	it("N1: accepts Commander camelCase attributes", () => {
		expect(scan(command("run(opts.dryRun);"))).toEqual([]);
	});
	it("N2: leaves unrelated libraries alone", () => {
		expect(scan('import { Command } from "other-cli"; new Command().option("--dry-run").action(opts => opts["dry-run"]);')).toEqual([]);
	});
	it("N3: does not combine sibling option declarations", () => {
		expect(scan('import { Command } from "commander"; const app = new Command(); app.command("a").option("--dry-run"); app.command("b").action(opts => opts["dry-run"]);')).toEqual([]);
	});
	it("N4: respects a shadowed options parameter", () => {
		expect(scan(command('function nested(opts) { return opts["dry-run"]; }'))).toEqual([]);
	});
	it("N5: leaves normalization wrapper outputs alone", () => {
		expect(scan(command('const normalized = normalize(opts); run(normalized["dry-run"]);'))).toEqual([]);
	});
	it("N6: accepts explicit canonical-key compatibility fallback", () => {
		expect(scan(command('run(opts.dryRun ?? opts["dry-run"]);'))).toEqual([]);
	});
	it("N7: defers dynamic/custom Option objects", () => {
		const result = withCheckRoot(process.cwd(), () => scan('import { Command, Option } from "commander"; new Command().option("--dry-run").addOption(new Option("--special").attributeName("dry-run")).action(opts => opts["dry-run"]);'));
		expect(result.result).toEqual([]);
		expect(result.notMeasured.join("\n")).toContain("custom or dynamic");
	});
	it("N8: defers legacy storeOptionsAsProperties", () => {
		expect(scan('import { Command } from "commander"; new Command().option("--dry-run").storeOptionsAsProperties().action(opts => opts["dry-run"]);')).toEqual([]);
	});
	it("N9: leaves dynamic option names unresolved", () => {
		expect(scan('import { Command } from "commander"; new Command().option(flags).action(opts => opts["dry-run"]);')).toEqual([]);
	});
	it("N10: leaves options objects with explicit writes unresolved", () => {
		expect(scan(command('opts["dry-run"] = opts.dryRun; run(opts["dry-run"]);'))).toEqual([]);
	});
	it("N11: excludes comments and string contents", () => {
		expect(scan(command('// opts["dry-run"]\nrun("opts[\\"dry-run\\"]");'))).toEqual([]);
	});
	it("N12: does not treat positional data as options", () => {
		expect(scan('import { Command } from "commander"; new Command().argument("<file>").option("--dry-run").action(file => file["dry-run"]);')).toEqual([]);
	});
	it("N13: reports imported action evidence as unavailable", () => {
		const result = withCheckRoot(process.cwd(), () => scan('import { Command } from "commander"; import { run } from "./handler.js"; new Command().option("--dry-run").action(run);'));
		expect(result.result).toEqual([]);
		expect(result.notMeasured.join("\n")).toContain("action body");
	});
	it("N14: reports forwarded handler evidence as unavailable", () => {
		const result = withCheckRoot(process.cwd(), () => scan(command("run(opts);")));
		expect(result.result).toEqual([]);
		expect(result.notMeasured.join("\n")).toContain("forwarded");
	});
	it("N15: leaves shadowed Commander constructor bindings alone", () => {
		expect(scan('import { Command } from "commander"; function test(Command) { return new Command().option("--dry-run").action(opts => opts["dry-run"]); }')).toEqual([]);
	});
	it("N16: leaves mutable command variables unresolved", () => {
		expect(scan('import { Command } from "commander"; let cli = new Command(); cli = other; cli.option("--dry-run").action(opts => opts["dry-run"]);')).toEqual([]);
	});
	it("N17: defers forwarded options that can be mutated by the callee", () => {
		expect(scan(command('normalizeInPlace(opts); run(opts["dry-run"]);'))).toEqual([]);
	});
	it("N18: reports an unresolved JSDoc-only registrar", () => {
		const result = withCheckRoot(process.cwd(), () => scan('/** @param {import("commander").Command} app */ function register(app) { app.option("--dry-run").action(opts => opts["dry-run"]); }'));
		expect(result.result).toEqual([]);
		expect(result.notMeasured.join("\n")).toContain("receiver");
	});
	it("N19: defers options-object aliases that may acquire custom keys", () => {
		expect(scan(command('const alias = opts; alias["dry-run"] = true; run(opts["dry-run"]);'))).toEqual([]);
	});
	it("N20: defers in-place update operations", () => {
		expect(scan(command('opts["dry-run"]++; run(opts["dry-run"]);'))).toEqual([]);
	});
	it("N21: defers reassigned action parameters", () => {
		expect(scan(command('opts = readLegacyOptions(); run(opts["dry-run"]);'))).toEqual([]);
	});
});
