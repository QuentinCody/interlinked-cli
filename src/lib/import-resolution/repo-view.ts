// ===========================================
// RepoView: the three questions the import resolver asks about a repository
// ===========================================
// "Is this repo-relative path a file?", "what does it say?", and "which config
// files exist?". The harness graph answers from the disk; the scoring graph
// answers from its in-memory inventory. The resolver never reads anything else.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export interface RepoView {
	/** True when the repo-relative path is a regular file. */
	isFile(rel: string): boolean;
	/** File text, or null when the path is missing, a directory, or outside the repo. */
	read(rel: string): string | null;
	/** Repo-relative paths of config-like files: package.json, tsconfig/jsconfig, svelte/vite/nuxt config, pnpm-workspace.yaml. Sorted. */
	configFiles(): readonly string[];
}

const CONFIG_NAME =
	/(?:^|\/)(?:package\.json|(?:ts|js)config(?:\.[\w-]+)?\.json|svelte\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|nuxt\.config\.[cm]?[jt]s|pnpm-workspace\.yaml)$/;
const WALK_SKIP = new Set(["node_modules", ".git", ".svelte-kit", ".next", ".nuxt", "dist", "build", ".turbo", ".interlinked", "coverage"]);
const WALK_LIMIT = 20000;

export function isConfigFileName(rel: string): boolean {
	return CONFIG_NAME.test(rel);
}

/** A view over a path to text map (the scoring inventory). */
export function mapRepoView(files: ReadonlyMap<string, string>): RepoView {
	const configs = [...files.keys()].filter(isConfigFileName).sort();
	return {
		isFile: rel => files.has(rel),
		read: rel => files.get(rel) ?? null,
		configFiles: () => configs,
	};
}

function gitConfigFiles(root: string): string[] | null {
	try {
		const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: root, encoding: "utf-8", timeout: 15_000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
		});
		const all = raw.split("\0").filter(Boolean);
		return all.length ? all.filter(isConfigFileName) : null;
	} catch {
		return null;
	}
}

function walkConfigFiles(root: string): string[] {
	const found: string[] = [];
	const pending = [""];
	let visited = 0;
	for (let dir = pending.pop(); dir !== undefined && visited < WALK_LIMIT; dir = pending.pop()) {
		visited++;
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!WALK_SKIP.has(entry.name)) pending.push(rel);
			} else if (isConfigFileName(rel)) found.push(rel);
		}
	}
	return found;
}

/** A view over the disk under `root`. Config discovery uses `git ls-files` and falls back to a bounded walk. */
export function fsRepoView(root: string): RepoView {
	let configs: string[] | null = null;
	const absolute = (rel: string): string | null => (rel.startsWith("..") || posix.isAbsolute(rel) ? null : join(root, rel));
	// One directory listing answers every `isFile` for names in it (a resolver probes many candidates per import).
	const listings = new Map<string, ReadonlyMap<string, boolean>>();
	const listing = (dir: string): ReadonlyMap<string, boolean> => {
		if (!listings.has(dir)) listings.set(dir, listDirectory(join(root, dir)));
		return listings.get(dir) as ReadonlyMap<string, boolean>;
	};
	return {
		isFile: rel => {
			if (absolute(rel) === null) return false;
			const at = rel.lastIndexOf("/");
			return listing(at < 0 ? "" : rel.slice(0, at)).get(at < 0 ? rel : rel.slice(at + 1)) === true;
		},
		read: rel => {
			const abs = absolute(rel);
			try { return abs === null ? null : readFileSync(abs, "utf-8"); } catch { return null; }
		},
		configFiles: () => {
			configs ??= (gitConfigFiles(root) ?? safeWalk(root)).sort();
			return configs;
		},
	};
}

/** name to "is a regular file" for one directory; empty when it cannot be read. A symlink to a file counts as a file. */
function listDirectory(dir: string): ReadonlyMap<string, boolean> {
	try {
		const names = new Map<string, boolean>();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			names.set(entry.name, entry.isFile() || (entry.isSymbolicLink() && isFileOnDisk(join(dir, entry.name))));
		}
		return names;
	} catch {
		return new Map();
	}
}

function isFileOnDisk(path: string): boolean {
	try { return statSync(path).isFile(); } catch { return false; }
}

function safeWalk(root: string): string[] {
	try { return walkConfigFiles(root); } catch { return []; }
}
