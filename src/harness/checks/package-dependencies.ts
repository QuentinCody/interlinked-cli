import { isJsonObject } from "../../lib/json-types.js";

/** Retain only declared dependency names whose version/range is a string. */
export function stringDependencies(value: unknown): Record<string, string> {
	if (!isJsonObject(value)) return {};
	const dependencies: Record<string, string> = {};
	for (const [name, version] of Object.entries(value)) {
		if (typeof version === "string") dependencies[name] = version;
	}
	return dependencies;
}
