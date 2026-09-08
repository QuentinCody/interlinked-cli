import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isJsonObject } from "../../../lib/json-types.js";
import { lintJsonc } from "../../../lib/lint-import/json.js";
import { proposedFileContent } from "../../checks/proposed-files.js";

/** A sibling overlay preserves directories and the final extension, not the basename.
 * Accept only selectors invariant under that transformation, without another glob matcher. */
function basenameInvariant(pattern: unknown): boolean {
	if (typeof pattern !== "string") return false;
	const plain = pattern.replace(/^!{1,2}/, "");
	if (!/^[\w./*\-]+$/.test(plain)) return false;
	const leaf = plain.slice(plain.lastIndexOf("/") + 1);
	return leaf === "*" || leaf === "**" || /^\*\.[\w]+$/.test(leaf);
}

function selectorIssue(key: string, value: unknown): string | null {
	if (["includes", "include", "ignore"].includes(key) &&
		(!Array.isArray(value) || !value.every(basenameInvariant))) {
		return `${key} contains a selector that may depend on the filename`;
	}
	if ((key === "extends" || key === "plugins") && (!Array.isArray(value) || value.length > 0)) {
		return `${key} cannot be reproduced by a sibling overlay`;
	}
	if (key === "root" && value === false) return "inherited configuration cannot be reproduced by a sibling overlay";
	return null;
}

function identityIssue(key: string, value: unknown): string | null {
	if (key === "vcs" && isJsonObject(value) && value.enabled === true && value.useIgnoreFile !== false) {
		return "VCS ignore rules may depend on the filename";
	}
	if (["useFilenamingConvention", "noImportCycles"].includes(key) && value !== null && value !== "off") {
		if (!isJsonObject(value) || value.level !== "off") return `${key} depends on the original file identity`;
	}
	if (key === "all" && value === true) return "the all-rules preset can enable filename-sensitive rules";
	return null;
}

function configurationIssue(value: unknown): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const issue = configurationIssue(item);
			if (issue) return issue;
		}
		return null;
	}
	if (!isJsonObject(value)) return null;
	for (const [key, child] of Object.entries(value)) {
		const issue = selectorIssue(key, child) ?? identityIssue(key, child) ?? configurationIssue(child);
		if (issue) return issue;
	}
	return null;
}

/** Unsupported config semantics are unavailable, never a verdict from another filename.
 * Biome still validates its schema; this only proves the supported selectors invariant.
 * Nested inheritance, plugins and VCS ignores need an on-disk check. */
export type BiomeOverlayConfiguration =
	| { status: "ok" }
	| { status: "unavailable" | "skipped"; reason: string };

/** The subprocess reads disk. A changed config in the proposal cannot supply its verdict. */
function configChangedInProposal(path: string): boolean {
	const proposed = proposedFileContent(path);
	if (proposed === undefined) return false;
	const disk = existsSync(path) ? readFileSync(path, "utf-8") : null;
	return proposed !== disk;
}

function inspectDirectoryConfiguration(dir: string): BiomeOverlayConfiguration | null {
	const candidates = [join(dir, "biome.json"), join(dir, "biome.jsonc")];
	const rewritten = candidates.find(configChangedInProposal);
	if (rewritten) return { status: "unavailable", reason: `Biome configuration ${rewritten} is changed by this proposal; the subprocess reads disk` };
	const path = candidates.find(existsSync);
	if (!path) return null;
	const config = lintJsonc(readFileSync(path, "utf-8"));
	if (!isJsonObject(config)) return { status: "unavailable", reason: `Biome configuration ${path} is not an object` };
	const issue = configurationIssue(config);
	return issue ? { status: "unavailable", reason: `Biome overlay unavailable: ${path}: ${issue}` } : { status: "ok" };
}

export function inspectBiomeOverlayConfig(filePath: string): BiomeOverlayConfiguration {
	if (process.env.BIOME_CONFIG_PATH !== undefined) {
		return { status: "unavailable", reason: "Biome overlay does not reproduce BIOME_CONFIG_PATH configuration" };
	}
	let dir = dirname(resolve(filePath));
	try {
		for (let depth = 0; depth < 64; depth++) {
			const configuration = inspectDirectoryConfiguration(dir);
			if (configuration) return configuration;
			const parent = dirname(dir);
			if (parent === dir) return { status: "skipped", reason: "no Biome configuration" };
			dir = parent;
		}
		return { status: "unavailable", reason: "Biome configuration discovery exceeded 64 ancestors" };
	} catch (error) {
		return { status: "unavailable", reason: `Biome configuration could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
}
