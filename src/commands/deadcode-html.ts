// A static HTML page loads scripts by path (`<script src="learn.js">`) and a preview page may list module
// paths in an inline script. Neither is an import statement, so the import scan cannot see it. This reads
// those paths as text and keeps only the ones that name a known source file.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

const QUOTED_CODE_PATH = /["']([^"'\s<>]+\.[cm]?[jt]sx?)(?:[?#][^"'\s]*)?["']/g;

function resolvePath(htmlRel: string, target: string): string {
	const base = target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(htmlRel), target);
	return posix.normalize(base);
}

/** Tracked and untracked-but-not-ignored `.html` files; empty outside a git tree. */
function gitHtmlFiles(cwd: string): string[] {
	try {
		const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.html"], {
			cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
		});
		return raw.split("\0").filter(Boolean);
	} catch {
		return [];
	}
}

/** Per HTML page, the source files among `known` that it names. A page with no such reference is left out. */
export function htmlReferences(cwd: string, known: ReadonlySet<string>): { html: string; targets: string[] }[] {
	const rows: { html: string; targets: string[] }[] = [];
	for (const html of gitHtmlFiles(cwd)) {
		let text: string;
		try {
			text = readFileSync(join(cwd, html), "utf-8");
		} catch {
			continue;
		}
		const targets = htmlReferencedPaths(text, html, known);
		if (targets.length) rows.push({ html, targets });
	}
	return rows;
}

/** Source files among `known` that the HTML text names by a quoted relative or root-absolute path. */
export function htmlReferencedPaths(html: string, htmlRel: string, known: ReadonlySet<string>): string[] {
	const found: string[] = [];
	for (const match of html.matchAll(QUOTED_CODE_PATH)) {
		const target = match[1] ?? "";
		if (/^[a-z][\w+.-]*:|^\/\//.test(target)) continue;
		const path = resolvePath(htmlRel, target);
		if (known.has(path) && !found.includes(path)) found.push(path);
	}
	return found;
}
