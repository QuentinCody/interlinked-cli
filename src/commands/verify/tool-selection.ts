import { TOOL_CATALOG } from "../../harness/check-engine/tool-catalog.js";
import type { ToolId } from "../../harness/check-engine/types.js";

/** Resolve explicit selection through the canonical catalog without inventing fallback tools. */
export function resolveVerifyToolIds(names: Iterable<string>): ToolId[] {
	const selected = new Set<ToolId>();
	for (const name of names) {
		const normalized = name.replaceAll("_", "-");
		for (const tool of TOOL_CATALOG) {
			if (tool.id === normalized || tool.configNames?.includes(name) || tool.configNames?.includes(normalized)) selected.add(tool.id);
		}
	}
	return [...selected];
}
