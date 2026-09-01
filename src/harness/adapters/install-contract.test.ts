// Cross-runner install contract.
// Catches the class of bugs Copilot found on OpenCode v2: advertised events
// that the install artifact never registers, documented paths that drift from
// renderSettingsFragment, and cold `rm -rf` detectors that miss `rm -fr`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDestructiveCommand } from "../../lib/hook-template-chunks/destructive-command-guard.js";
import { opencode2ColdBlockReason } from "../../lib/opencode-tool-map.js";
import { buildAllAdapters } from "./index.js";
import { installedEventNames } from "./provider-capabilities.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function walkTs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === ".git") continue;
		const path = join(dir, name);
		const st = statSync(path);
		if (st.isDirectory()) walkTs(path, out);
		else if (name.endsWith(".ts")) out.push(path);
	}
	return out;
}

function artifactHaystack(adapterId: string): string {
	const adapter = buildAllAdapters().find((a) => a.id === adapterId);
	if (!adapter) throw new Error(`missing adapter ${adapterId}`);
	const frag = adapter.renderSettingsFragment("/bin/hook", "project");
	return `${frag.fileContent ?? ""}\n${JSON.stringify(frag.fragment)}`;
}

/** Needles that prove an installed event is actually registered, not just listed. */
function eventNeedles(name: string): string[] {
	const full = name.startsWith("event:") ? name.slice("event:".length) : name;
	const leaf = full.includes(".") ? full.slice(full.lastIndexOf(".") + 1) : full;
	return [full, `hook("${leaf}"`, `"${full}":`];
}

function artifactContainsEvent(haystack: string, name: string): boolean {
	return eventNeedles(name).some((needle) => haystack.includes(needle));
}

const COLD_BLOCKERS: Array<{ id: string; blocks: (cmd: string) => boolean }> = [
	{
		id: "checkDestructiveCommand",
		blocks: (cmd) => checkDestructiveCommand(cmd) !== null,
	},
	{
		id: "opencode2ColdBlockReason",
		blocks: (cmd) => opencode2ColdBlockReason("Bash", { command: cmd }) !== null,
	},
];

describe("every runner's install artifact registers every installed event", () => {
	it("nativeEventNames is the capability install list, and each name is in the fragment or plugin source", () => {
		for (const adapter of buildAllAdapters()) {
			const installed = installedEventNames(adapter.capabilities);
			expect(adapter.nativeEventNames, adapter.id).toEqual(installed);
			const haystack = artifactHaystack(adapter.id);
			for (const name of installed) {
				expect(
					artifactContainsEvent(haystack, name),
					`${adapter.id} install artifact missing ${name}`,
				).toBe(true);
			}
		}
	});
});

describe("documented hook paths match renderSettingsFragment", () => {
	it("capabilities.project_hook_path is the project fragment path", () => {
		for (const adapter of buildAllAdapters()) {
			expect(adapter.capabilities.project_hook_path, adapter.id).toBe(
				adapter.renderSettingsFragment("/bin/hook", "project").path,
			);
		}
	});

	it("setup-skill hook-file paths resolve to an adapter fragment path", () => {
		const known = new Set<string>();
		for (const adapter of buildAllAdapters()) {
			known.add(adapter.capabilities.project_hook_path);
			known.add(adapter.renderSettingsFragment("/bin/hook", "project").path);
			known.add(adapter.renderSettingsFragment("/bin/hook", "user").path);
		}
		const skill = readFileSync(join(REPO_ROOT, "skills", "interlinked-setup", "SKILL.md"), "utf8");
		const mentioned = skill.match(
			/`(?:\.|~\/)[^`]*(?:plugins|hooks\.json|settings\.json|extensions)[^`]*`/g,
		) ?? [];
		const unknown = mentioned
			.map((tick) => tick.slice(1, -1))
			.filter((path) => ![...known].some((k) => path === k || path.endsWith(k) || k.endsWith(path)));
		expect(unknown).toEqual([]);
	});
});

describe("cold recursive-rm detectors", () => {
	it("every cold blocker refuses both -rf and -fr of / and ~", () => {
		const mustBlock = ["rm -rf /", "rm -fr /", "rm -fr ~", "rm -rf ~"];
		const mustAllow = ["ls", "pwd"];
		for (const { id, blocks } of COLD_BLOCKERS) {
			for (const cmd of mustBlock) {
				expect(blocks(cmd), `${id} must block ${cmd}`).toBe(true);
			}
			for (const cmd of mustAllow) {
				expect(blocks(cmd), `${id} must allow ${cmd}`).toBe(false);
			}
		}
	});

	it("any source that encodes rm -rf flag order also encodes rm -fr", () => {
		const rfOnly = /rm\\s\+-\[a-zA-Z\]\*r\[a-zA-Z\]\*f/;
		const frAlt = /f\[a-zA-Z\]\*r/;
		const failures: string[] = [];
		for (const file of walkTs(join(REPO_ROOT, "src"))) {
			if (file.endsWith(".test.ts")) continue;
			const text = readFileSync(file, "utf8");
			if (rfOnly.test(text) && !frAlt.test(text)) failures.push(file);
		}
		expect(failures).toEqual([]);
	});
});
