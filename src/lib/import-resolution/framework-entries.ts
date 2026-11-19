// ===========================================
// Framework entry files and convention exports (data-driven)
// ===========================================
// A framework loads some files by their path, with no import: a route, a
// layout, a hook, an API handler. Those files are roots of the import graph,
// never dead code, and the names they export (`load`, `GET`, ...) are read by
// the framework, not by an importer. The table below is the only place that
// knows a convention. Each row names the documentation it comes from.
//
// KNOWN GAPS: a custom routes directory (`kit.files.routes`, Next `pageExtensions`,
// Nuxt `srcDir`/`dir` options) is not read; only the documented defaults are roots.

import { posix } from "node:path";
import { isJsonObject } from "../json-types.js";
import { parseJsonc } from "./jsonc.js";
import type { RepoView } from "./repo-view.js";

interface FrameworkConvention {
	framework: string;
	/** Documentation the patterns come from. */
	source: string;
	/** A package.json dependency that turns the convention on. */
	dependencies: readonly string[];
	/** Paths (relative to the package directory) that the framework loads. */
	entries: readonly RegExp[];
	/** Subset of `entries` that are route modules: their conventional exports are read by the framework. */
	routeFiles: readonly RegExp[];
	/** Export names the framework reads from a route module. */
	conventionExports: readonly string[];
}

const SCRIPT = "[cm]?[jt]s";
const SVELTEKIT_ROUTE = new RegExp(`^src/routes/(?:.*/)?\\+[^/]+\\.(?:svelte|${SCRIPT})$`);
const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

const CONVENTIONS: readonly FrameworkConvention[] = [
	{
		framework: "sveltekit",
		source: "https://svelte.dev/docs/kit/routing, /hooks, /service-workers, /advanced-routing#Matching, /page-options",
		dependencies: ["@sveltejs/kit"],
		routeFiles: [SVELTEKIT_ROUTE, /^src\/params\/[^/]+\.[cm]?[jt]s$/, /^src\/hooks(?:\.(?:client|server|universal))?\.[cm]?[jt]s$/],
		entries: [
			SVELTEKIT_ROUTE,
			new RegExp(`^src/hooks(?:\\.(?:client|server|universal))?\\.${SCRIPT}$`),
			new RegExp(`^src/service-worker(?:/index)?\\.${SCRIPT}$`),
			new RegExp(`^src/params/[^/]+\\.${SCRIPT}$`),
			new RegExp(`^src/instrumentation\\.server\\.${SCRIPT}$`),
			/^src\/app\.d\.ts$/,
		],
		conventionExports: ["load", "actions", "prerender", "ssr", "csr", "trailingSlash", "entries", "config", "fallback", "match", "default",
			"handle", "handleError", "handleFetch", "handleValidationError", "init", "reroute", "transport", ...HTTP_VERBS],
	},
	{
		framework: "next",
		source: "https://nextjs.org/docs/app/getting-started/project-structure and /docs/pages/building-your-application/routing",
		dependencies: ["next"],
		routeFiles: [/^(?:src\/)?app\/(?:.*\/)?(?:page|layout|route|loading|error|global-error|not-found|default|template|forbidden|unauthorized)\.[jt]sx?$/, /^(?:src\/)?pages\/.+\.[jt]sx?$/],
		entries: [
			/^(?:src\/)?app\/(?:.*\/)?(?:page|layout|route|loading|error|global-error|not-found|default|template|forbidden|unauthorized)\.[jt]sx?$/,
			/^(?:src\/)?app\/(?:.*\/)?(?:opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[jt]sx?$/,
			/^(?:src\/)?pages\/.+\.[jt]sx?$/,
			/^(?:src\/)?(?:middleware|instrumentation|instrumentation-client|proxy)\.[jt]s$/,
		],
		conventionExports: [
			"default", "metadata", "generateMetadata", "generateStaticParams", "generateViewport", "viewport", "dynamic", "dynamicParams",
			"revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration", "config", "getServerSideProps", "getStaticProps",
			"getStaticPaths", "middleware", "register", ...HTTP_VERBS,
		],
	},
	{
		framework: "nuxt",
		source: "https://nuxt.com/docs/guide/directory-structure",
		dependencies: ["nuxt"],
		routeFiles: [/^(?:app\/)?(?:pages|layouts|middleware|plugins)\/.+\.(?:vue|[jt]s)$/, /^server\/(?:api|routes|middleware|plugins)\/.+\.[jt]s$/],
		entries: [
			/^(?:app\/)?(?:pages|layouts|middleware|plugins|composables|utils|components)\/.+\.(?:vue|[jt]s)$/,
			/^(?:app\/)?(?:app|error)\.vue$/,
			/^(?:app\/)?app\.config\.[jt]s$/,
			/^server\/(?:api|routes|middleware|plugins|utils)\/.+\.[jt]s$/,
		],
		conventionExports: ["default"],
	},
	{
		framework: "astro",
		source: "https://docs.astro.build/en/basics/project-structure/ and /en/guides/endpoints/",
		dependencies: ["astro"],
		routeFiles: [/^src\/pages\/.+\.(?:astro|md|mdx|[jt]s)$/],
		entries: [
			/^src\/pages\/.+\.(?:astro|md|mdx|[jt]s)$/,
			/^src\/middleware(?:\/index)?\.[jt]s$/,
			/^src\/content(?:\.config|\/config)\.[jt]s$/,
			/^src\/actions\/index\.[jt]s$/,
		],
		conventionExports: ["default", "getStaticPaths", "prerender", "partial", "ALL", ...HTTP_VERBS],
	},
];

function declaredDependencies(view: RepoView, packageJson: string): Set<string> {
	const json = parseJsonc(view.read(packageJson) ?? "");
	const names = new Set<string>();
	if (!isJsonObject(json)) return names;
	for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
		const map = json[field];
		if (isJsonObject(map)) for (const name of Object.keys(map)) names.add(name);
	}
	return names;
}

/** Package directories (with their conventions) whose package.json declares a framework dependency. */
function frameworkRoots(view: RepoView): { dir: string; convention: FrameworkConvention }[] {
	const roots: { dir: string; convention: FrameworkConvention }[] = [];
	for (const file of view.configFiles()) {
		if (posix.basename(file) !== "package.json") continue;
		const dependencies = declaredDependencies(view, file);
		for (const convention of CONVENTIONS) {
			if (convention.dependencies.some(name => dependencies.has(name))) roots.push({ dir: posix.dirname(file), convention });
		}
	}
	return roots;
}

function localPath(dir: string, path: string): string | null {
	if (dir === ".") return path;
	return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}

/** The files among `paths` that a declared framework loads by convention. */
export function frameworkEntryFiles(view: RepoView, paths: Iterable<string>): Set<string> {
	const roots = frameworkRoots(view);
	const found = new Set<string>();
	if (!roots.length) return found;
	for (const path of paths) {
		for (const { dir, convention } of roots) {
			const local = localPath(dir, path);
			if (local !== null && convention.entries.some(pattern => pattern.test(local))) found.add(path);
		}
	}
	return found;
}

/** Every tail of a path that starts after a slash: a monorepo path `apps/kit/src/routes/a` also reads as `src/routes/a`. */
function pathTails(path: string): string[] {
	const tails = [path];
	for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) tails.push(path.slice(at + 1));
	return tails;
}

/** True when `name` exported from `path` is read by a framework (`load` in `+page.server.ts`, `GET` in `route.ts`). Path-only: no package context needed. */
export function isConventionExport(path: string, name: string): boolean {
	const tails = pathTails(path);
	return CONVENTIONS.some(convention => convention.conventionExports.includes(name) && convention.routeFiles.some(pattern => tails.some(tail => pattern.test(tail))));
}
