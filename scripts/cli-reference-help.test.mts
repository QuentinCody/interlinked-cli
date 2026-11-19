import { readFileSync } from "node:fs";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerNetworkCommands } from "../src/registrars/network.js";
import { cliReferenceHelp } from "./cli-reference-help.js";

function commandTree(write: (text: string) => void): Command {
	const root = new Command("example").exitOverride()
		.configureOutput({ writeOut: write, getOutHelpWidth: () => 80 })
		.configureHelp({ showGlobalOptions: true })
		.option("--global", "Root option")
		.addHelpText("afterAll", "\nInterface boundaries:\nShared footer");
	const group = root.command("group").alias("g").option("--parent", "Group option");
	group.command("show").alias("s").description("Show the current project")
		.addHelpText("after", () => `Project directory: ${process.cwd()}`)
		.action(() => { throw new Error("help executed the command"); });
	return root;
}

describe("CLI reference help", () => {
	it("reproduces the published network group and two leaf help blocks byte for byte", () => {
		const reference = readFileSync(new URL("../docs/generated/cli-reference.md", import.meta.url), "utf8");
		const tree = new Command("interlinked");
		registerNetworkCommands(tree);
		for (const path of [["network"], ["network", "check"], ["network", "codex-profile"]]) {
			const heading = path.length === 1 ? "## Network" : "### " + path.join(" ");
			const block = reference.split(heading + "\n\n```\n")[1]?.split("\n```")[0];
			expect(cliReferenceHelp(tree, path)).toBe(block);
		}
	});

	it("matches parsed CLI help for root, nested commands and aliases across repeated renders", () => {
		let leaked = "";
		const tree = commandTree(text => { leaked += text; });
		for (const path of [[], ["group"], ["g", "s"], ["group", "show"], []]) {
			let raw = "";
			const cli = commandTree(text => { raw += text; });
			expect(() => cli.parse([...path, "--help"], { from: "user" })).toThrow("(outputHelp)");
			const expected = raw.split("\nInterface boundaries:")[0]!.trim().replaceAll(process.cwd(), "<cwd>");
			expect(cliReferenceHelp(tree, path)).toBe(expected);
		}
		const nested = cliReferenceHelp(tree, ["g", "s"]);
		expect(nested).toContain("--global");
		expect(nested).toContain("--parent");
		expect(nested).toContain("Project directory: <cwd>");
		expect(leaked).toBe("");
		tree.outputHelp();
		expect(leaked).toContain("Shared footer");
	});

	it("reports the entire unknown path, even when a parent or leaf exists", () => {
		const tree = commandTree(() => {});
		for (const path of [["missing"], ["g", "missing"], ["group", "show", "missing"]]) {
			expect(() => cliReferenceHelp(tree, path)).toThrow(`Unknown documentation command: example ${path.join(" ")}`);
		}
	});
});
