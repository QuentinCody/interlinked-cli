import { expect, it } from "vitest";
import { analyzeCommanderModule, sameFileCommanderMatches } from "./commander-option-attribute-model.js";

it("MUST-FIRE: extracted module evidence preserves direct Commander option mapping", () => {
	const analysis = analyzeCommanderModule('import { Command } from "commander"; new Command().option("--dry-run").action(opts => opts["dry-run"]);', "cli.ts");
	expect(analysis && sameFileCommanderMatches(analysis)).toHaveLength(1);
});

it("MUST-NOT-FIRE: extracted module evidence preserves canonical fallback", () => {
	const analysis = analyzeCommanderModule('import { Command } from "commander"; new Command().option("--dry-run").action(opts => opts.dryRun ?? opts["dry-run"]);', "cli.ts");
	expect(analysis && sameFileCommanderMatches(analysis)).toEqual([]);
});
