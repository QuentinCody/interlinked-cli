import type { Command } from "commander";
import type {
	SimplifyCommandOptions,
	SimplifyStatusOptions,
} from "../commands/simplify.js";

async function runSimplify(
	command: "scan" | "review" | "audit",
	options: SimplifyCommandOptions,
): Promise<void> {
	const { simplifyCommand } = await import("../commands/simplify.js");
	process.exitCode = await simplifyCommand(command, options);
}

async function runSimplifyStatus(options: SimplifyStatusOptions): Promise<void> {
	const { simplifyStatusCommand } = await import("../commands/simplify.js");
	process.exitCode = simplifyStatusCommand(options);
}

export function registerSimplifyCommands(program: Command): void {
	const simplify = program
		.command("simplify")
		.description("Simplification evidence, explicit recording, and Agent CI handoff preparation");

	simplify
		.command("scan")
		.description("Compose deterministic local simplification evidence for the repository")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--record", "Persist a local run receipt and upsert findings into the common corpus")
		.option("--json", "Canonical machine-readable report with evidence and coverage receipts")
		.action(async (options: SimplifyCommandOptions) => {
			await runSimplify("scan", options);
		});

	simplify
		.command("review")
		.description("Review changed, staged, or explicit git-range files using full repository context")
        .option("--diagnostics <profile>", "Include iterative diagnostic candidates: js-ts or python (explicit full census)")
		.option("--changed", "Review tracked and untracked worktree changes (default)")
		.option("--staged", "Review only paths staged in the git index")
		.option("--range <base..head>", "Review paths changed by an explicit validated git range")
		.option("--deep-handoff", "Include a portable, not-submitted Agent CI deep-review request")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--record", "Persist a local run receipt and upsert findings into the common corpus")
		.option("--json", "Canonical machine-readable report with evidence and coverage receipts")
		.action(async (options: SimplifyCommandOptions) => {
			await runSimplify("review", options);
		});

	simplify
		.command("audit")
		.description("Run the local deterministic repository audit; never invokes an LLM")
		.option("--deep-handoff", "Include a portable, not-submitted Agent CI deep-review request")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--record", "Persist a local run receipt and upsert findings into the common corpus")
		.option("--json", "Canonical machine-readable report with evidence and coverage receipts")
		.action(async (options: SimplifyCommandOptions) => {
			await runSimplify("audit", options);
		});

	simplify
		.command("status")
		.description("Show locally recorded simplification runs and common-corpus materialization")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable local recorded-run view")
		.action(async (options: SimplifyStatusOptions) => {
			await runSimplifyStatus(options);
		});
}
