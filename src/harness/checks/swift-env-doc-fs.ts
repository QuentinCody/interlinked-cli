// Env-var documentation discovery (P0: agent-specific failure modes).
// Extracted from swift.ts (large-file-policy split, exporter-first).

import { nonNull } from "../../lib/non-null.js";

/** fs surface `parseEnvDocumentation` and its helpers need, injected by the caller. */
type EnvDocFs = {
	existsSync: (p: string) => boolean;
	readFileSync: (p: string, e: BufferEncoding) => string;
	readdirSync: (p: string) => string[];
};
type PathJoin = (...parts: string[]) => string;

/**
 * In a monorepo, env-docs often live at the workspace root, not in the
 * sub-package being verified (e.g. `cli/` inside a parent repo). Walk
 * ancestor directories so `.env.example`, wrangler configs, and workflow
 * files are discovered wherever they sit — mirroring how git locates
 * `.git/` upward from the cwd. Capped to avoid unbounded walks.
 */
function computeEnvDocRoots(projectRoot: string): string[] {
	const roots: string[] = [];
	let current = projectRoot;
	for (let i = 0; i < 8; i++) {
		roots.push(current);
		const parent = current.replace(/\/[^/]+\/?$/, "");
		if (!parent || parent === current || parent === "/") break;
		current = parent;
	}
	return roots;
}

/** Scan `.env.example` / `.env.sample` / `.env.template` across every root. */
function scanEnvExampleFiles(
	roots: string[],
	fs: EnvDocFs,
	join: PathJoin,
	documented: Set<string>,
): void {
	const { existsSync, readFileSync } = fs;
	for (const root of roots) {
		for (const name of [".env.example", ".env.sample", ".env.template"]) {
			const envPath = join(root, name);
			if (existsSync(envPath)) {
				try {
					const content = readFileSync(envPath, "utf-8");
					for (const line of content.split("\n")) {
						const m = line.match(/^#?\s*([A-Z][A-Z0-9_]+)\s*=/);
						if (m) documented.add(nonNull(m[1]));
					}
				} catch {
					/* intentional: unreadable env docs should not break env discovery */
				}
			}
		}
	}
}

/**
 * Extract `[vars]`-block keys and top-level `binding`/`name` values from the
 * body of a wrangler.toml file, adding each to `documented` in place.
 */
function extractWranglerTomlVars(content: string, documented: Set<string>): void {
	let inVars = false;
	for (const line of content.split("\n")) {
		const binding = line.match(/^\s*(?:binding|name)\s*=\s*"([A-Z][A-Z0-9_]+)"/);
		if (binding) documented.add(nonNull(binding[1]));
		if (/^\[vars\]/.test(line.trim())) {
			inVars = true;
			continue;
		}
		if (/^\[/.test(line.trim())) {
			inVars = false;
			continue;
		}
		if (inVars) {
			const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=/);
			if (m) documented.add(nonNull(m[1]));
		}
	}
}

/**
 * Extract env-var-shaped keys and `binding`/`name` values from the body of a
 * wrangler.jsonc file, adding each to `documented` in place.
 */
function extractWranglerJsoncVars(content: string, documented: Set<string>): void {
	for (const line of content.split("\n")) {
		const m = line.match(/"([A-Z][A-Z0-9_]+)"\s*:/);
		if (m) documented.add(nonNull(m[1]));
		const binding = line.match(/"(?:binding|name)"\s*:\s*"([A-Z][A-Z0-9_]+)"/);
		if (binding) documented.add(nonNull(binding[1]));
	}
}

/**
 * wrangler.toml / wrangler.jsonc [vars] + binding names, across ancestor roots
 * AND the immediate subdirectories of `projectRoot` (Worker bindings frequently
 * live in a sibling sub-app, e.g. `landing/wrangler.jsonc`, that the upward
 * ancestor walk never reaches — bounded to one level deep, skipping vendored /
 * build / dot dirs so it stays a small, fixed-cost scan).
 */
function scanWranglerConfigs(
	projectRoot: string,
	roots: string[],
	fs: EnvDocFs,
	join: PathJoin,
	documented: Set<string>,
): void {
	const { existsSync, readFileSync, readdirSync } = fs;

	// Parse one config file, adding any var keys / binding names it declares to `documented`.
	const parseWranglerFile = (wranglerPath: string, isToml: boolean): void => {
		if (!existsSync(wranglerPath)) return;
		try {
			const content = readFileSync(wranglerPath, "utf-8");
			if (isToml) extractWranglerTomlVars(content, documented);
			else extractWranglerJsoncVars(content, documented);
		} catch {
			/* intentional: unreadable Wrangler config should not break env discovery */
		}
	};

	// Ancestor dirs (monorepo root + walk upward), same as the env-docs scan.
	for (const root of roots) {
		parseWranglerFile(join(root, "wrangler.toml"), true);
		parseWranglerFile(join(root, "wrangler.jsonc"), false);
	}

	// Immediate subdirectories of projectRoot.
	try {
		for (const entry of readdirSync(projectRoot)) {
			if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
			const subdir = join(projectRoot, entry);
			parseWranglerFile(join(subdir, "wrangler.toml"), true);
			parseWranglerFile(join(subdir, "wrangler.jsonc"), false);
		}
	} catch {
		/* intentional: unreadable project root should not break env discovery */
	}
}

/** Scan GitHub Actions workflow files (`env:` blocks + `${{ secrets.X }}` refs) across every root. */
function scanGithubWorkflowEnvVars(
	roots: string[],
	fs: EnvDocFs,
	join: PathJoin,
	documented: Set<string>,
): void {
	const { existsSync, readFileSync, readdirSync } = fs;
	for (const root of roots) {
		const workflowDir = join(root, ".github", "workflows");
		if (!existsSync(workflowDir)) continue;
		try {
			for (const file of readdirSync(workflowDir)) {
				if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
				const content = readFileSync(join(workflowDir, file), "utf-8");
				// env: blocks
				const envMatches = content.matchAll(/^\s+([A-Z][A-Z0-9_]+)\s*:/gm);
				for (const m of envMatches) documented.add(nonNull(m[1]));
				// ${{ secrets.VAR }}
				const secretMatches = content.matchAll(
					/\$\{\{\s*secrets\.([A-Z][A-Z0-9_]+)\s*\}\}/g,
				);
				for (const m of secretMatches) documented.add(nonNull(m[1]));
			}
		} catch {
			/* intentional: unreadable workflow files should not break env discovery */
		}
	}
}

/**
 * Parse documented env vars from .env.example, wrangler.toml, wrangler.jsonc, CI files.
 * Returns set of documented env var names.
 * NOTE: This function requires fs access. Import existsSync/readFileSync/readdirSync
 * and join from the caller's scope, or use it in contexts with Node.js require() available.
 */
export function parseEnvDocumentation(
	projectRoot: string,
	fs: EnvDocFs,
	pathJoin: PathJoin,
): Set<string> {
	const documented = new Set<string>();
	const roots = computeEnvDocRoots(projectRoot);

	scanEnvExampleFiles(roots, fs, pathJoin, documented);
	scanWranglerConfigs(projectRoot, roots, fs, pathJoin, documented);
	scanGithubWorkflowEnvVars(roots, fs, pathJoin, documented);

	return documented;
}
