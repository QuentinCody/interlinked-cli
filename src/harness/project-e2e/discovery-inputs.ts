import { readBoundedTextFile } from "../../lib/bounded-file-core.js";
import { parseJsonObjectText } from "../../lib/json-types.js";

export function discoveryInputs(byteLimit: number) {
	const readText = (path: string) => readBoundedTextFile(path, byteLimit);
	const readJson = (path: string): Record<string, unknown> | null => {
		const text = readText(path);
		return text === null ? null : parseJsonObjectText(text);
	};
	return { readText, readJson };
}
