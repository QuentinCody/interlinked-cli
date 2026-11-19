import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { isJsonObject } from "../../../lib/json-types.js";
import { lintJsonc } from "../../../lib/lint-import/json.js";

function configurationIn(directory: string): string | null {
	return [join(directory, "biome.json"), join(directory, "biome.jsonc")].find(existsSync) ?? null;
}

function ancestorConfiguration(directory: string): string | null {
	for (;;) {
		const path = configurationIn(directory);
		if (path) return path;
		const parent = dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

/** Unknown resolution retains native policy so a CLI override cannot erase an explicit limit. */
function hasConfiguredSize(path: string, seen: Set<string>): boolean {
	const identity = realpathSync(path);
	if (seen.has(identity)) return true;
	const visited = new Set(seen).add(identity);
	const config = lintJsonc(readFileSync(path, "utf8"));
	if (!isJsonObject(config)) return true;
	if (isJsonObject(config.files) && Object.hasOwn(config.files, "maxSize")) return true;
	if (config.root === false) {
		const parent = ancestorConfiguration(dirname(dirname(path)));
		if (!parent || hasConfiguredSize(parent, visited)) return true;
	}
	const inherited = typeof config.extends === "string" ? [config.extends] : config.extends ?? [];
	if (!Array.isArray(inherited)) return true;
	return inherited.some(reference => {
		if (typeof reference !== "string" || reference === "//") return true;
		const local = resolve(dirname(path), reference);
		const inheritedPath = existsSync(local) ? local : createRequire(path).resolve(reference);
		return hasConfiguredSize(inheritedPath, visited);
	});
}

/** The native schema uses positive uint64 size. Its maximum removes the default
 * ceiling within the supported domain while per-file overrides remain native. */
export function biomeForegroundSizeArgs(projectRoot: string): string[] {
	try {
		const selected = process.env.BIOME_CONFIG_PATH;
		let config: string | null;
		if (selected !== undefined) {
			const path = resolve(projectRoot, selected);
			config = statSync(path).isDirectory() ? configurationIn(path) : path;
		} else config = ancestorConfiguration(resolve(projectRoot));
		return config && !hasConfiguredSize(config, new Set()) ? ["--files-max-size=18446744073709551615"] : [];
	} catch {
		// The analyzer still validates the real config and reports unmeasured scopes.
		return [];
	}
}
