import type { Command } from "commander";
import { coworkArtifactCommand, coworkBridgeCommand, coworkCapabilitiesCommand, coworkPackageCommand, coworkProbePromptCommand, coworkReportCommand, coworkVerifyCommand } from "../commands/cowork.js";

export function registerCoworkCommands(program: Command): void {
    const cowork = program.command("cowork").description("Experimental Cowork plugin, native hook evidence, and workspace verification (JSON output)");
    cowork.command("capabilities").description("Compare Claude Code hook declarations with dated Cowork probe evidence").option("--json", "JSON output (default)").action(coworkCapabilitiesCommand);
    cowork.command("package").description("Build an uploadable Cowork plugin; never modifies Desktop or Claude Code settings")
        .requiredOption("--output <directory>", "Fresh package output directory")
        .option("--policy <file>", "Reviewed Cowork policy JSON; credentials stay in environment variables")
        .option("--probe", "Package fault-injection probes for synthetic tasks only")
        .action(coworkPackageCommand);
    cowork.command("probe-prompt").description("Print the synthetic native hook test campaign").action(coworkProbePromptCommand);
    cowork.command("report <receipts>").description("Summarize hook receipts; compare independent synthetic effects when supplied")
        .option("--effects <listing>", "Independent probe listing with PRESENT/ABSENT filename lines").action(coworkReportCommand);
    cowork.command("artifact <file>").description("Check bounded Office/text artifacts for structure, cached spreadsheet errors, and placeholders").action(coworkArtifactCommand);
    cowork.command("verify <workspace>").description("Run tsc, biome, and gitleaks against a version-checked workspace").action(coworkVerifyCommand);
    cowork.command("bridge").description("Serve authenticated file-hook decisions on loopback; no public listener")
        .requiredOption("--workspace <id>", "Explicit workspace identity")
        .requiredOption("--root <directory>", "Host workspace root")
        .requiredOption("--runtime-root <directory>", "Corresponding native Cowork workspace root")
        .requiredOption("--token-env <name>", "Environment variable holding a 32-character minimum token")
        .option("--port <port>", "Loopback port", "9473")
        .action(coworkBridgeCommand);
}
