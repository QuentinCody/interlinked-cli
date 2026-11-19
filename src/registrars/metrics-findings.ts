import type { Command } from "commander";
import { findingAction, type FindingsOptions } from "../commands/metrics-findings.js";

export function registerFindingCommands(decisions: Command): void {
	const group = decisions.command("findings").description("Experimental advisory review of frozen code evidence; never gates edits");
	for (const [spec, description] of [
		["catalog", "Show explicit semantic finding contracts"],
		["discover <input>", "Collect advisory parser, resource, initialization and typed discarded-outcome candidates from an explicit files array"],
		["prepare <input>", "Freeze a JSON case plan into bounded, redacted source evidence locally"],
		["questions <input>", "Freeze versioned alternative question instructions and criteria locally"],
		["plan <input>", "Preview selected frozen requests, exact semantic context, provider identity and labeled cost estimates"],
		["assess <input>", "Assess an explicitly approved or estimate-authorized frozen plan through an optional provider"],
		["show <input>", "View a saved bundle, plan or assessment locally without inference"],
		["labels <input>", "Create a blind reviewer template from an evidence bundle"],
		["review <input>", "Compare a retained run against reviewer labels by direction"],
	]) {
		const name = spec!.split(" ")[0]!;
		const command = group.command(spec!).description(description!)
			.option("--cwd <path>", "Project root")
			.option("--output <file>", "Write immutable JSON; required for assessment")
			.option("--dry-run", "Prepare output without inference or writes")
			.option("--json", "Machine-readable output")
			.option("--short", "One-line summary")
			.option("--full", "Full retained evidence");
		if (name === "assess" || name === "plan") {
			command
				.option("--provider <name>", "typesafe (default), ollama, liquid, openrouter or perplexity")
				.option("--config <file>", "Existing decision adapter configuration")
				.option("--model <id>", "Pinned provider model identity (TypeSafe default jev-1.14.0)")
				.option("--model-identity <id>", "Explicit model identity; local model digest is otherwise read without inference")
				.option("--url <url>", "Provider API base URL")
				.option("--command <path>", "Existing ThinkThen adapter executable")
				.option("--select <ids>", "Explicit comma-separated case IDs; omitted cases remain unassessed")
				.option("--question-profile <file>", "Immutable alternate question profile; exact text and criteria are bound to request identity")
				.option("--max-request-bytes <n>", "Reject oversized requests visibly; never truncate context")
				.option("--timeout-ms <n>", "Per-request deadline, 1..60000 (default 10000)");
		}
		if (name === "assess") {
			command
				.option("--max-calls <n>", "Request admission budget, 0..200 (default 50); external adapter retries remain capability-dependent")
				.option("--max-usd <n>", "Admission spend stop, 0..10 (default 0.25); estimates cannot guarantee a monetary ceiling")
				.option("--approve-plan <id>", "Authorize the exact frozen plan identity, including its disclosed unknown costs")
				.option("--estimate-allowance-usd <n>", "Explicitly accept estimated-cost admission, 0..10; no provider quote or hard ceiling")
				.option("--reuse <file>", "Reuse validated matching observations from a saved v2 run without inference");
		}
		if (name === "review") command.option("--labels <file>", "Complete source-backed reviewer labels");
		if (spec!.includes("<input>")) {
			command.action(async (input: string, options: FindingsOptions, leaf: Command) => {
				process.exitCode = await findingAction(name, input, { ...leaf.optsWithGlobals(), ...options });
			});
		} else {
			command.action(async (options: FindingsOptions, leaf: Command) => {
				process.exitCode = await findingAction(name, undefined, { ...leaf.optsWithGlobals(), ...options });
			});
		}
	}
}
