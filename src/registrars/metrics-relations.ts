import type { Command } from "commander";
import { relationsAction, type RelationsOptions } from "../commands/metrics-relations.js";

export function registerRelationCommands(decisions: Command): void {
    const group = decisions.command("relations").description("Experimental invariant, coupling, and before/after judgments over pinned graph evidence");
    for (const [spec, description] of [
        ["catalog", "Show v2 relation contracts and separate group populations"],
        ["prepare", "Prepare pinned graph evidence with explicit history and engines"],
        ["freeze <input>", "Freeze evidence, policy, contracts, runner sources, and tool policy"],
        ["assess <input>", "Assess a frozen single or paired plan with independent named arms"],
        ["compare [before]", "Create paired remeasurement or report a completed paired run"],
        ["export <input>", "Export a self-contained immutable result bundle"],
        ["labels <input>", "Create blind Astra review packets without judge predictions"],
        ["audit <input>", "Report candidate recall, model reference agreement, uncertainty, and cost"],
    ]) {
        const name = spec!.split(" ")[0]!;
        const command = group.command(spec!).description(description!).option("--cwd <path>", "Project root").option("--output <path>", "Immutable JSON output or freeze/export directory").option("--json", "JSON output (always enabled)");
        if (name === "prepare") command.option("--revision <ref>", "Pinned source revision").option("--policy-revision <ref>", "Committed registry revision (defaults to source)").option("--exploratory", "Use an uncommitted local registry, explicitly exploratory").option("--engines <file>", "Explicit D/J/H engine array, identities and budgets").option("--history-tip <ref>", "Pinned pre-change ancestry tip").option("--since <date>", "Absolute history lower bound").option("--until <date>", "Absolute history upper bound").option("--max-history <n>", "Ancestry traversal budget (default 10000)").option("--files <paths...>", "Source file/directory scope").option("--max-files <n>", "Source file budget").option("--mode <kind>", "curated or retrieved").option("--method <kind>", "shared_rules or lexical").option("--k <n>", "Candidates per anchor (2..12)").option("--kinds <ids>", "Comma-separated relation contracts").option("--max-packets <n>", "Packet assessment budget; omissions remain visible");
        if (name === "assess") command.option("--fresh", "Bypass retained exact-evidence observations");
        if (name === "compare") command.option("--after <file>", "Second single-snapshot run").option("--output-plan <file>", "Paired plan consumed by freeze and assess").option("--assessment-run <file>", "Completed paired run; exclusive with positional arguments");
        if (name === "audit") command.option("--labels <file>", "Fixture or blind Astra reference labels");
        if (spec!.includes("input") || name === "compare") command.action(async (input: string | undefined, options: RelationsOptions, leaf: Command) => { process.exitCode = await relationsAction(name, input, { ...leaf.optsWithGlobals(), ...options }); });
        else command.action(async (options: RelationsOptions, leaf: Command) => { process.exitCode = await relationsAction(name, undefined, { ...leaf.optsWithGlobals(), ...options }); });
    }
}
