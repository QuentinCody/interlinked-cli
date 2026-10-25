// ===========================================
// Software Version Regression — pip requirement pins
// ===========================================
// Leaf helpers split out of software-version-regression.ts: which files carry
// pip-style pins, and how one pin line becomes a reference. The pin grammar
// also matches any `name = value` line, so it runs only on requirements-style
// files: before that gate, `count = state.count(old)` in a .py file became
// "Python package count" and its `old` raised a legacy-wording freshness
// concern (2026-10-21).

import type { SoftwareVersionReference } from "./software-version-regression.js";

const REQUIREMENT_RE =
	/^\s*(?<name>[A-Za-z0-9_.-]+)\s*(?:==|~=|>=|<=|=)\s*(?<version>[^\s;#]+)/;

/** Pip requirement / constraint files (`requirements-dev.txt`, `requirements/base.in`), Pipfile and setup.cfg. */
export function isRequirementsFile(filePath: string, base: string): boolean {
	if (base === "pipfile" || base === "setup.cfg") return true;
	if (!/\.(?:txt|in)$/.test(base)) return false;
	return /(?:requirements|constraints)/.test(base) || /(?:^|\/)requirements\//.test(filePath.replaceAll("\\", "/"));
}

export function collectRequirementRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = REQUIREMENT_RE.exec(line);
	const name = match?.groups?.name;
	const version = match?.groups?.version;
	if (!name || !version) return undefined;
	return {
		anchor: `package:${name.toLowerCase()}`,
		label: `Python package ${name}`,
		kind: "package",
		version,
		line: lineNo,
		text: line.trim(),
	};
}
