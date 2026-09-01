// ===========================================
// Change Propagation — Behavioral companion tests
// ===========================================
// Drives every branch of findPropagationTargets (cyclomatic 82) by building
// real filesystem fixtures in a temp dir, plus formatPropagationWarnings and
// the recursive helper's depth/skip behavior.

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	findPropagationTargets,
	formatPropagationWarnings,
} from "./change-propagation.js";

// -------------------------------------------
// Fixture helpers
// -------------------------------------------

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "change-prop-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Create a file (and parent dirs) under root; returns absolute path. */
function file(relPath: string, content = "x"): string {
	const abs = join(root, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

/** Create a directory under root; returns absolute path. */
function dir(relPath: string): string {
	const abs = join(root, relPath);
	mkdirSync(abs, { recursive: true });
	return abs;
}

function categories(targets: ReturnType<typeof findPropagationTargets>): string[] {
	return targets.map((t) => t.category);
}

function fileNames(targets: ReturnType<typeof findPropagationTargets>): string[] {
	return targets.map((t) => t.file);
}

// ===========================================
// findPropagationTargets — empty / baseline
// ===========================================

describe("findPropagationTargets — baseline", () => {
	it("returns no targets for an isolated source file with no neighbors", () => {
		// A bare .ts file with nothing around it. ext === ".ts" branch runs but
		// no .d.ts exists, no index.ts, no docs, etc.
		const edited = file("src/lonely.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets).toEqual([]);
	});

	it("returns no targets for a non-.ts file with no neighbors", () => {
		// ext is not .ts/.tsx so the generated-dts branch is skipped entirely.
		const edited = file("src/data.bin");
		const targets = findPropagationTargets(edited, root);
		expect(targets).toEqual([]);
	});
});

// ===========================================
// 1. DOCUMENTATION — README
// ===========================================

describe("findPropagationTargets — README", () => {
	it("flags a README in the same directory", () => {
		const edited = file("src/feature/mod.ts");
		const readme = file("src/feature/README.md");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(readme);
		const t = targets.find((x) => x.file === readme);
		expect(t?.category).toBe("documentation");
		expect(t?.confidence).toBe("low");
		expect(t?.reason).toContain("README may reference");
	});

	it("flags a README in the parent directory when same-dir absent", () => {
		const edited = file("src/feature/sub/mod.ts");
		// parentDir = dirname(dir) = src/feature
		const readme = file("src/feature/README.md");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(readme);
	});

	it("flags the root README when neither same nor parent dir has one", () => {
		const edited = file("src/deep/sub/mod.ts");
		const readme = file("README.md");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(readme);
	});

	it("recognizes lowercase readme.md and README without extension", () => {
		const editedA = file("a/mod.ts");
		file("a/readme.md");
		const targetsA = findPropagationTargets(editedA, root);
		expect(targetsA.some((t) => t.category === "documentation")).toBe(true);

		const editedB = file("b/mod.ts");
		file("b/README");
		const targetsB = findPropagationTargets(editedB, root);
		expect(targetsB.some((t) => t.category === "documentation")).toBe(true);
	});

	it("recognizes README.rst", () => {
		const edited = file("c/mod.ts");
		const readme = file("c/README.rst");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(readme);
	});

	it("does NOT flag the README when the edited file IS the README", () => {
		// candidate === editedFile guard: editing README itself must not
		// self-reference. README is not a .ts so generated branch is skipped too.
		const edited = file("docsroot/README.md");
		const targets = findPropagationTargets(edited, root);
		// The same-dir README candidate equals editedFile, so it's skipped.
		expect(fileNames(targets)).not.toContain(edited);
	});

	it("collapses the three candidate locations to one hit per README name (inner break)", () => {
		// README.md exists in same dir, parent dir, AND root, but the inner
		// `break` emits only the first match (same dir) for the "README.md"
		// name. Using DISTINCT directories avoids case-insensitive-FS aliasing
		// of README.md/readme.md onto one inode.
		const edited = file("lvl/sub/mod.ts");
		const sameDir = file("lvl/sub/README.md");
		file("lvl/README.md"); // parent — shadowed by same-dir hit
		file("README.md"); // root — shadowed by same-dir hit
		const targets = findPropagationTargets(edited, root);
		// One physical "README.md" name → one target despite three locations.
		// (On case-insensitive filesystems "readme.md" aliases to the same file,
		// so it may also contribute a second target — assert the same-dir hit is
		// present and points at the nearest README.)
		const readmeMdHits = targets.filter(
			(t) => t.reason.includes("README may reference") && t.file === sameDir,
		);
		expect(readmeMdHits).toHaveLength(1);
		// The parent and root README.md must NOT appear (inner break collapsed them).
		expect(fileNames(targets)).not.toContain(join(root, "lvl", "README.md"));
		expect(fileNames(targets)).not.toContain(join(root, "README.md"));
	});
});

// ===========================================
// 1. DOCUMENTATION — CHANGELOG
// ===========================================

describe("findPropagationTargets — CHANGELOG", () => {
	it("flags CHANGELOG.md at repo root", () => {
		const edited = file("src/mod.ts");
		const changelog = file("CHANGELOG.md");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === changelog);
		expect(t).toBeDefined();
		expect(t?.category).toBe("documentation");
		expect(t?.reason).toContain("CHANGELOG should document");
	});

	it("recognizes alternate changelog names and stops at the first", () => {
		const edited = file("src/mod.ts");
		// Both CHANGES.md and HISTORY.md present; the loop breaks after the first
		// matched name in the list order (CHANGELOG.md, changelog.md, CHANGES.md…).
		file("CHANGES.md");
		file("HISTORY.md");
		const targets = findPropagationTargets(edited, root);
		const changelogTargets = targets.filter((t) =>
			t.reason.includes("CHANGELOG should document"),
		);
		expect(changelogTargets).toHaveLength(1);
	});
});

// ===========================================
// 1. DOCUMENTATION — docs/ directory
// ===========================================

describe("findPropagationTargets — docs directory", () => {
	it("flags a doc file that mentions the module name (nameNoExt)", () => {
		const edited = file("src/widget.ts");
		const doc = file("docs/guide.md", "The widget module does things.");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === doc);
		expect(t).toBeDefined();
		expect(t?.category).toBe("documentation");
		expect(t?.confidence).toBe("medium");
		expect(t?.reason).toContain("widget");
	});

	it("flags a doc file that mentions the relative path", () => {
		const edited = file("src/gadget.ts");
		// Reference by the relative path rather than the bare name.
		const doc = file("docs/api.mdx", "See src/gadget.ts for details.");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(doc);
	});

	it("does not flag docs that don't mention the file", () => {
		const edited = file("src/unmentioned.ts");
		file("docs/other.md", "Completely unrelated content.");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "documentation")).toBe(false);
	});

	it("scans .rst and .txt docs and recurses into subdirectories", () => {
		const edited = file("src/thing.ts");
		const nested = file("docs/sub/deep.rst", "thing reference");
		const txt = file("docs/notes.txt", "thing again");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(nested);
		expect(fileNames(targets)).toContain(txt);
	});

	it("skips hidden subdirs and node_modules inside docs", () => {
		const edited = file("src/scoped.ts");
		// Hidden dir + node_modules should be pruned by findFilesRecursive.
		file("docs/.hidden/secret.md", "scoped mention");
		file("docs/node_modules/pkg.md", "scoped mention");
		const visible = file("docs/visible.md", "scoped mention");
		const targets = findPropagationTargets(edited, root);
		const docTargets = fileNames(targets).filter((f) => f.includes("docs"));
		expect(docTargets).toContain(visible);
		expect(docTargets.some((f) => f.includes(".hidden"))).toBe(false);
		expect(docTargets.some((f) => f.includes("node_modules"))).toBe(false);
	});

	it("respects the recursion depth limit (does not descend past maxDepth)", () => {
		const edited = file("src/depthy.ts");
		// docs/ is depth 0 when scanned. findFilesRecursive(docsDir, …, 3) yields
		// files at depths 0,1,2 relative to docs. A file 4 levels below docs is
		// beyond the cap and must NOT be found.
		file("docs/l1/l2/l3/buried.md", "depthy mention");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets).some((f) => f.includes("buried.md"))).toBe(false);
	});
});

// ===========================================
// 1. DOCUMENTATION — CLAUDE.md
// ===========================================

describe("findPropagationTargets — CLAUDE.md", () => {
	it("flags root CLAUDE.md when it mentions the module (high confidence)", () => {
		const edited = file("src/engine.ts");
		const claude = file("CLAUDE.md", "The engine subsystem is documented here.");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === claude);
		expect(t).toBeDefined();
		expect(t?.confidence).toBe("high");
		expect(t?.category).toBe("documentation");
		expect(t?.reason).toContain("CLAUDE.md references");
	});

	it("flags a same-directory CLAUDE.md when it mentions the rel path", () => {
		const edited = file("pkg/sub/core.ts");
		const claude = file("pkg/sub/CLAUDE.md", "see pkg/sub/core.ts");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(claude);
	});

	it("does not flag CLAUDE.md that omits the file", () => {
		const edited = file("src/absent.ts");
		file("CLAUDE.md", "Talks about other stuff.");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("CLAUDE.md references"))).toBe(false);
	});
});

// ===========================================
// 2. SCHEMA / TYPES — companion schema files
// ===========================================

describe("findPropagationTargets — schema companions", () => {
	it("flags a .schema.ts companion when editing a types file", () => {
		const edited = file("src/user.types.ts");
		// nameNoExt for user.types.ts is "user.types"; companion suffix .schema.ts.
		const schema = file("src/user.types.schema.ts");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === schema);
		expect(t).toBeDefined();
		expect(t?.category).toBe("schema");
		expect(t?.confidence).toBe("high");
	});

	it("flags .schema.json and .zod.ts companions for a schema-named file", () => {
		const edited = file("src/order.schema-defs.ts");
		// name contains "schema" → companion lookup uses nameNoExt = order.schema-defs
		const jsonSchema = file("src/order.schema-defs.schema.json");
		const zod = file("src/order.schema-defs.zod.ts");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(jsonSchema);
		expect(fileNames(targets)).toContain(zod);
	});

	it("treats interface-named files as schema-bearing", () => {
		const edited = file("src/account.interface.ts");
		const schema = file("src/account.interface.schema.ts");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(schema);
	});

	it("does not flag a schema companion that equals the edited file", () => {
		// Editing the .schema.ts file itself: name includes "schema", nameNoExt
		// is "thing.schema" wait — choose a name where companion === editedFile.
		// Edit "x.schema.ts": ext=.ts, nameNoExt="x.schema", companion candidate
		// join(dir, "x.schema.schema.ts") which is NOT the edited file, so make a
		// file whose companion path collides. Simplest: editedFile name "y.types"
		// produces companion "y.types.schema.ts"; create that as the edited file.
		const edited = file("src/y.types.schema.ts");
		const targets = findPropagationTargets(edited, root);
		// y.types.schema.ts: name includes "types" & "schema". nameNoExt =
		// "y.types.schema". Companion ".schema.ts" → "y.types.schema.schema.ts"
		// which does not exist, so no schema-companion target points at itself.
		expect(fileNames(targets)).not.toContain(edited);
	});
});

// ===========================================
// 2. SCHEMA / TYPES — migrations
// ===========================================

describe("findPropagationTargets — migrations", () => {
	it("suggests a migrations dir when a schema file has none", () => {
		const edited = file("db/user.schema.ts");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.reason.includes("require a new migration"));
		expect(t).toBeDefined();
		expect(t?.category).toBe("schema");
		expect(t?.confidence).toBe("medium");
		expect(t?.file).toBe(join(root, "db", "migrations/"));
	});

	it("fires for a migration-named file too", () => {
		const edited = file("db/0001_migration.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("require a new migration"))).toBe(true);
	});

	it("does NOT suggest a migrations dir when one already exists", () => {
		const edited = file("db/order.schema.ts");
		dir("db/migrations");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("require a new migration"))).toBe(false);
	});
});

// ===========================================
// 2. SCHEMA / TYPES — OpenAPI specs
// ===========================================

describe("findPropagationTargets — OpenAPI specs", () => {
	it("flags openapi.yaml when editing a handler file", () => {
		// `rel.includes("handler")` is case-sensitive — use a lowercase path.
		const edited = file("src/user-handler.ts");
		const spec = file("openapi.yaml");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === spec);
		expect(t).toBeDefined();
		expect(t?.category).toBe("schema");
		expect(t?.confidence).toBe("medium");
	});

	it("flags all spec variants for a route file", () => {
		const edited = file("src/routes.ts");
		file("openapi.json");
		file("swagger.yaml");
		file("swagger.json");
		file("api.yaml");
		const targets = findPropagationTargets(edited, root);
		const specTargets = targets.filter((t) => t.reason.includes("API spec may need"));
		// Four specs match (openapi.yaml absent), all flagged because rel has "route".
		expect(specTargets).toHaveLength(4);
	});

	it("flags spec for an api-named path", () => {
		const edited = file("src/api/server.ts");
		file("openapi.yaml");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API spec may need"))).toBe(true);
	});

	it("flags spec for an endpoint-named path", () => {
		const edited = file("src/endpoint-list.ts");
		file("openapi.yaml");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API spec may need"))).toBe(true);
	});

	it("does NOT flag the spec when the edited file is unrelated to handlers/routes", () => {
		const edited = file("src/math-utils.ts");
		file("openapi.yaml");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API spec may need"))).toBe(false);
	});
});

// ===========================================
// 3. TESTS — fixtures & snapshots
// ===========================================

describe("findPropagationTargets — fixtures and snapshots", () => {
	it("flags a fixture file whose name contains the module name", () => {
		const edited = file("src/parser.ts");
		// fixtures dir is sibling of edited file (same dir).
		file("src/__fixtures__/parser-sample.json", "{}");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.reason.includes("Test fixture"));
		expect(t).toBeDefined();
		expect(t?.category).toBe("test");
		expect(t?.confidence).toBe("medium");
	});

	it("flags a snapshot file matching the module name (high confidence)", () => {
		const edited = file("src/render.ts");
		file("src/__snapshots__/render.ts.snap", "exports[`x`] = ``;");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.reason.includes("Snapshot"));
		expect(t).toBeDefined();
		expect(t?.category).toBe("test");
		expect(t?.confidence).toBe("high");
	});

	it("ignores fixtures/snapshots whose names do not match the module", () => {
		const edited = file("src/alpha.ts");
		file("src/__fixtures__/beta-data.json", "{}");
		file("src/__snapshots__/gamma.snap", "");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Test fixture"))).toBe(false);
		expect(targets.some((t) => t.reason.includes("Snapshot"))).toBe(false);
	});

	it("skips the fixtures/snapshots block entirely for test files (isTestFile true)", () => {
		// A .test.ts file: isTestFile is true so the whole TESTS block is skipped,
		// even though matching fixtures exist.
		const edited = file("src/parser.test.ts");
		file("src/__fixtures__/parser-sample.json", "{}");
		file("src/__snapshots__/parser.snap", "");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "test")).toBe(false);
	});

	it("treats __test-prefixed names as test files (isTestFile via includes)", () => {
		// name includes "__test" → isTestFile true via the second clause.
		const edited = file("src/__test-helpers.ts");
		file("src/__fixtures__/__test-helpers-data.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "test")).toBe(false);
	});
});

// ===========================================
// 4. CONFIGURATION — CLI files
// ===========================================

describe("findPropagationTargets — CLI/config", () => {
	it("flags completions, package.json, and README usage for a commands file", () => {
		const edited = file("src/commands/run.ts");
		const comp = file("src/commands/completions.ts");
		const pkg = file("package.json", "{}");
		const readme = file("README.md", "## Commands\nlist of commands");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(comp);
		expect(fileNames(targets)).toContain(pkg);
		// README has a "## Commands" heading → CLI doc target fires.
		const readmeTarget = targets.find(
			(t) => t.file === readme && t.reason.includes("README CLI documentation"),
		);
		expect(readmeTarget).toBeDefined();
		expect(readmeTarget?.confidence).toBe("medium");
	});

	it("recognizes all completion shell variants", () => {
		const edited = file("src/commands/cmd.ts");
		file("src/commands/completions.sh");
		file("src/commands/completions.zsh");
		file("src/commands/completions.fish");
		const targets = findPropagationTargets(edited, root);
		const compTargets = targets.filter((t) => t.reason.includes("Shell completions"));
		expect(compTargets).toHaveLength(3);
	});

	it("fires the CLI block for an index.ts path", () => {
		const edited = file("src/index.ts", "// entry");
		const pkg = file("package.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(pkg);
	});

	it("fires the CLI block for a cli-named file", () => {
		const edited = file("src/my-cli.ts");
		const pkg = file("package.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(pkg);
	});

	it("does NOT flag README when it has no commands/usage heading", () => {
		const edited = file("src/commands/run.ts");
		file("README.md", "# My Project\nJust a description, no command list.");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("README CLI documentation"))).toBe(false);
	});

	it("matches usage/getting-started/cli headings in README (regex alternatives)", () => {
		const edited = file("src/commands/run.ts");
		const readme = file("README.md", "### Getting Started\nrun it");
		const targets = findPropagationTargets(edited, root);
		expect(
			targets.some(
				(t) => t.file === readme && t.reason.includes("README CLI documentation"),
			),
		).toBe(true);
	});

	it("does not self-reference README when the edited file IS the README in a commands path", () => {
		// rel includes "commands/" and name is README.md. The completions/README
		// guards use `!== editedFile`. Make the edited file the commands README.
		const edited = file("commands/README.md", "## Commands");
		const targets = findPropagationTargets(edited, root);
		// The README CLI-doc target uses readmeFile = cwd/README.md which is a
		// DIFFERENT path, so editedFile is not self-referenced via that branch.
		expect(fileNames(targets)).not.toContain(edited);
	});
});

// ===========================================
// 4. CONFIGURATION — env / settings files
// ===========================================

describe("findPropagationTargets — env templates", () => {
	it("flags .env.example for a config file", () => {
		const edited = file("src/config.ts");
		const env = file(".env.example", "FOO=bar");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === env);
		expect(t).toBeDefined();
		expect(t?.category).toBe("config");
		expect(t?.confidence).toBe("medium");
	});

	it("flags all env template variants for an env-named file", () => {
		const edited = file("src/env-loader.ts");
		file(".env.example");
		file(".env.sample");
		file(".env.template");
		const targets = findPropagationTargets(edited, root);
		const envTargets = targets.filter((t) => t.reason.includes("Environment template"));
		expect(envTargets).toHaveLength(3);
	});

	it("fires the env block for a settings-named file", () => {
		const edited = file("src/settings.ts");
		const env = file(".env.example");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(env);
	});

	it("does not flag env templates for a non-config file", () => {
		const edited = file("src/random.ts");
		file(".env.example");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Environment template"))).toBe(false);
	});
});

// ===========================================
// 4. CONFIGURATION — guard rules
// ===========================================

describe("findPropagationTargets — guard rules", () => {
	it("flags CLAUDE.md when editing guard-rules.json", () => {
		const edited = file(".interlinked/guard-rules.json", "{}");
		const claude = file("CLAUDE.md", "guard rules doc");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find(
			(x) => x.file === claude && x.reason.includes("guard rules"),
		);
		expect(t).toBeDefined();
		expect(t?.confidence).toBe("high");
		expect(t?.category).toBe("documentation");
	});

	it("flags CLAUDE.md when editing a rules-loader file", () => {
		const edited = file("src/harness/rules-loader.ts");
		const claude = file("CLAUDE.md", "documents guard rules");
		const targets = findPropagationTargets(edited, root);
		expect(
			targets.some((t) => t.file === claude && t.reason.includes("documents guard rules")),
		).toBe(true);
	});

	it("does not fire the guard-rules branch when CLAUDE.md is absent", () => {
		const edited = file(".interlinked/guard-rules.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("documents guard rules"))).toBe(false);
	});
});

// ===========================================
// 5. CONTRACTS — tool registry
// ===========================================

describe("findPropagationTargets — tool registry", () => {
	it("flags the tool-registry index when editing a tools/handlers file", () => {
		const edited = file("src/tools/handlers/search.ts");
		const registry = file("src/tool-registry/index.ts", "// registry");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === registry);
		expect(t).toBeDefined();
		expect(t?.category).toBe("contract");
		expect(t?.confidence).toBe("medium");
	});

	it("flags the registry index for a tool-registry/entries path", () => {
		const edited = file("src/tool-registry/entries/foo.ts");
		const registry = file("src/tool-registry/index.ts", "// registry");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(registry);
	});

	it("does not fire when the registry index does not exist", () => {
		const edited = file("src/tools/handlers/search.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Tool registry may need"))).toBe(false);
	});

	it("does not self-reference when the edited file IS the registry index", () => {
		// rel must include "tool-registry/entries/" AND the path equal the
		// registry index — impossible because the index is at tool-registry/index.ts
		// not under entries/. So instead verify the `!== editedFile` guard by
		// editing src/tool-registry/index.ts directly while it also matches no
		// handler/entries prefix → branch is simply not entered. Sanity check.
		const edited = file("src/tool-registry/index.ts", "// registry");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Tool registry may need"))).toBe(false);
	});
});

// ===========================================
// 5. CONTRACTS — worker / router / handler -> CLAUDE.md endpoints
// ===========================================

describe("findPropagationTargets — API endpoint docs", () => {
	it("flags CLAUDE.md endpoint table when editing worker.ts and CLAUDE.md mentions Endpoint", () => {
		const edited = file("src/worker.ts");
		const claude = file("CLAUDE.md", "## API Endpoints\n- /foo");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find(
			(x) => x.file === claude && x.reason.includes("API endpoint table"),
		);
		expect(t).toBeDefined();
		expect(t?.category).toBe("contract");
		expect(t?.confidence).toBe("medium");
	});

	it("fires for a router-named file when CLAUDE.md has 'Endpoint'", () => {
		const edited = file("src/router.ts");
		file("CLAUDE.md", "Endpoint listing here");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API endpoint table"))).toBe(true);
	});

	it("fires for a handler-named file (also matches contract branch)", () => {
		// `name.includes("handler")` is case-sensitive — lowercase the name.
		const edited = file("src/my-handler.ts");
		const claude = file("CLAUDE.md", "API Endpoints table");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API endpoint table"))).toBe(true);
		expect(claude).toContain("CLAUDE.md");
	});

	it("does NOT fire when CLAUDE.md lacks any endpoint mention", () => {
		const edited = file("src/worker.ts");
		file("CLAUDE.md", "No relevant content about routes.");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API endpoint table"))).toBe(false);
	});

	it("does not fire the endpoint branch when CLAUDE.md is absent", () => {
		const edited = file("src/worker.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API endpoint table"))).toBe(false);
	});
});

// ===========================================
// 6. DEPENDENCIES — lock files
// ===========================================

describe("findPropagationTargets — lock files", () => {
	it("flags every present lock file when editing package.json", () => {
		const edited = file("package.json", "{}");
		const lock1 = file("package-lock.json", "{}");
		const lock2 = file("pnpm-lock.yaml", "");
		const lock3 = file("yarn.lock", "");
		const lock4 = file("bun.lockb", "");
		const targets = findPropagationTargets(edited, root);
		for (const lock of [lock1, lock2, lock3, lock4]) {
			const t = targets.find((x) => x.file === lock);
			expect(t).toBeDefined();
			expect(t?.category).toBe("dependency");
			expect(t?.confidence).toBe("high");
		}
	});

	it("flags only the present lock file (others skipped)", () => {
		const edited = file("package.json", "{}");
		const lock = file("pnpm-lock.yaml", "");
		const targets = findPropagationTargets(edited, root);
		const lockTargets = targets.filter((t) => t.category === "dependency");
		expect(lockTargets).toHaveLength(1);
		expect(lockTargets[0]?.file).toBe(lock);
	});

	it("does not fire the dependency branch for non-package.json files", () => {
		const edited = file("src/mod.ts");
		file("package-lock.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "dependency")).toBe(false);
	});
});

// ===========================================
// 7. GENERATED — barrel index + .d.ts
// ===========================================

describe("findPropagationTargets — generated files", () => {
	it("flags index.ts when it re-exports the edited module", () => {
		const edited = file("src/lib/helper.ts");
		const index = file("src/lib/index.ts", 'export * from "./helper";');
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === index);
		expect(t).toBeDefined();
		expect(t?.category).toBe("generated");
		expect(t?.confidence).toBe("medium");
	});

	it("does not flag index.ts when it does not re-export the module", () => {
		const edited = file("src/lib/helper.ts");
		file("src/lib/index.ts", 'export * from "./other";');
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Barrel export"))).toBe(false);
	});

	it("does not self-reference when the edited file IS index.ts", () => {
		// indexFile === editedFile guard. Editing src/lib/index.ts: the barrel
		// branch must skip because indexFile === editedFile.
		const edited = file("src/lib/index.ts", 'export * from "./index";');
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Barrel export"))).toBe(false);
	});

	it("skips the barrel check for test files", () => {
		// isTestFile true → the barrel branch is gated off even if index re-exports.
		const edited = file("src/lib/helper.test.ts");
		file("src/lib/index.ts", 'export * from "./helper.test";');
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Barrel export"))).toBe(false);
	});

	it("flags a sibling .d.ts file for a .ts source", () => {
		const edited = file("src/types.ts");
		const dts = file("src/types.d.ts", "export {};");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === dts);
		expect(t).toBeDefined();
		expect(t?.category).toBe("generated");
		expect(t?.reason).toContain("Type declaration");
	});

	it("flags a sibling .d.ts file for a .tsx source", () => {
		const edited = file("src/Comp.tsx");
		const dts = file("src/Comp.d.ts", "export {};");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(dts);
	});

	it("does not look for .d.ts when the source is not .ts/.tsx", () => {
		const edited = file("src/script.js");
		file("src/script.d.ts", "export {};");
		const targets = findPropagationTargets(edited, root);
		// ext === ".js" so the dts branch is skipped; the .d.ts must not appear.
		expect(targets.some((t) => t.reason.includes("Type declaration"))).toBe(false);
	});
});

// ===========================================
// Catch-path coverage: unreadable files
// ===========================================

describe("findPropagationTargets — error handling (catch branches)", () => {
	it("survives a docs entry that cannot be read (broken symlink)", () => {
		const edited = file("src/sym.ts", "// edit");
		dir("docs");
		// A broken symlink with a .md extension: findFilesRecursive's
		// entry.isFile() is false for a dangling link target, but on some
		// platforms lstat reports it as a symlink (not file/dir) and it is
		// simply skipped. Either way the scan must not throw.
		try {
			symlinkSync(join(root, "does-not-exist.md"), join(root, "docs", "dangling.md"));
		} catch (e) {
			// Symlink creation may be restricted (e.g. Windows / sandbox); the
			// scan-must-not-throw assertion below still holds without the link.
			void e;
		}
		expect(() => findPropagationTargets(edited, root)).not.toThrow();
	});

	it("does not throw when docs/ exists but is empty", () => {
		const edited = file("src/emptydocs.ts");
		dir("docs");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "documentation")).toBe(false);
	});

	it("does not throw when __fixtures__ exists but is empty", () => {
		const edited = file("src/ef.ts");
		dir("src/__fixtures__");
		expect(() => findPropagationTargets(edited, root)).not.toThrow();
	});

	// The following exercise the per-block catch arms by making a path that
	// existsSync() reports as present but the subsequent read fails on:
	// a directory where the code does readFileSync (EISDIR), or a regular file
	// where the code does readdirSync (ENOTDIR). Each catch swallows the error,
	// so the function must return WITHOUT that block's target.

	it("swallows EISDIR when CLAUDE.md is a directory (docs CLAUDE.md read catch)", () => {
		const edited = file("src/engine.ts");
		// existsSync(CLAUDE.md) is true (it's a dir), readFileSync throws EISDIR.
		dir("CLAUDE.md");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("CLAUDE.md references"))).toBe(false);
	});

	it("swallows ENOTDIR when docs/ is a regular file (findFilesRecursive catch)", () => {
		const edited = file("src/mod.ts");
		// existsSync(docs) true; findFilesRecursive's readdirSync throws ENOTDIR.
		file("docs", "this is a file, not a directory");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "documentation")).toBe(false);
	});

	it("swallows ENOTDIR when __fixtures__/__snapshots__ are regular files (test readdir catches)", () => {
		const edited = file("src/parser.ts");
		// Both dirs are actually files → readdirSync throws ENOTDIR in each block.
		file("src/__fixtures__", "not a dir");
		file("src/__snapshots__", "not a dir");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "test")).toBe(false);
	});

	it("swallows EISDIR when README.md is a directory in a commands path (CLI README read catch)", () => {
		const edited = file("src/commands/run.ts");
		// rel includes "commands/" so the CLI block runs; README.md is a dir so
		// readFileSync throws EISDIR and the README-CLI-doc target is skipped.
		dir("README.md");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("README CLI documentation"))).toBe(false);
	});

	it("swallows EISDIR when CLAUDE.md is a directory for a worker file (endpoint read catch)", () => {
		const edited = file("src/worker.ts");
		// worker.ts enters the contract block; CLAUDE.md is a dir → EISDIR caught.
		dir("CLAUDE.md");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API endpoint table"))).toBe(false);
	});

	it("swallows EISDIR when index.ts is a directory (barrel read catch)", () => {
		// indexFile exists (as a dir) and !== editedFile and not a test file, so
		// the barrel block runs; readFileSync throws EISDIR and is swallowed.
		const edited = file("src/lib/helper.ts");
		dir("src/lib/index.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Barrel export"))).toBe(false);
	});

	// L110 inner docs read catch: a real, collectable .md file whose content
	// read fails. The only portable trigger is a permission-denied regular file,
	// which root can read through — so skip when running as root.
	const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
	it.skipIf(asRoot)(
		"swallows a read error on an unreadable doc file (docs inner read catch)",
		() => {
			const edited = file("src/widget.ts");
			// File matches by name so it WOULD be flagged, but chmod 000 makes
			// readFileSync throw → the inner catch swallows it, no doc target.
			const doc = file("docs/guide.md", "widget reference");
			chmodSync(doc, 0o000);
			let targets: ReturnType<typeof findPropagationTargets>;
			try {
				targets = findPropagationTargets(edited, root);
			} finally {
				// Restore perms so afterEach's rmSync can clean up the temp dir.
				chmodSync(doc, 0o644);
			}
			expect(targets.some((t) => t.category === "documentation")).toBe(false);
		},
	);
});

// ===========================================
// Combined / multi-category
// ===========================================

describe("findPropagationTargets — combined scenarios", () => {
	it("emits targets across multiple categories for a rich fixture", () => {
		// A schema-named handler file inside commands/, with docs, README,
		// CHANGELOG, CLAUDE.md, openapi spec, index barrel, and a .d.ts.
		// Lowercase "handler" so the case-sensitive contract branch fires.
		const edited = file("src/commands/user-handler.schema.ts");
		file("src/commands/README.md");
		file("CHANGELOG.md");
		file("docs/guide.md", "user-handler.schema reference");
		file("CLAUDE.md", "## API Endpoints\nuser-handler.schema docs");
		file("openapi.yaml");
		file("src/commands/index.ts", 'export * from "./user-handler.schema";');
		file("src/commands/user-handler.schema.d.ts", "export {};");
		file("package.json", "{}");
		const targets = findPropagationTargets(edited, root);
		const cats = new Set(categories(targets));
		expect(cats.has("documentation")).toBe(true);
		expect(cats.has("schema")).toBe(true);
		expect(cats.has("config")).toBe(true);
		expect(cats.has("contract")).toBe(true);
		expect(cats.has("generated")).toBe(true);
		expect(targets.length).toBeGreaterThan(5);
	});
});

// ===========================================
// formatPropagationWarnings
// ===========================================

// ===========================================
// Mutation-hardening — exact-value + guard-bypass assertions
// ===========================================
// Targets the survivors from the 81.9% mutation sweep on this file. Each
// group below is a guard-bypass fixture (name/rel deliberately does NOT
// match the function's keyword gate, while the artifact the gated block
// would have flagged is present on disk) or an exact-value assertion
// (reason/category/confidence text, not just presence).

describe("mutation hardening — genBarrelIndex", () => {
	it("returns the exact barrel target object (reason text pinned)", () => {
		const edited = file("src/lib/helper.ts");
		const index = file("src/lib/index.ts", 'export * from "./helper";');
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === index);
		expect(t).toStrictEqual({
			file: index,
			reason: "Barrel export in index.ts re-exports from src/lib/helper.ts — update if exports changed",
			category: "generated",
			confidence: "medium",
		});
	});
});

describe("mutation hardening — schemaCompanions", () => {
	it("does not run the companion scan when the name has no types/schema/interface keyword", () => {
		// Guard-bypass fixture: name matches none of the three keywords, but a
		// file that WOULD satisfy the suffix loop sits right next to it. If the
		// keyword guard (or its bypass-blocking early return) is neutralized,
		// this companion gets flagged anyway.
		const edited = file("src/plain.ts");
		file("src/plain.schema.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Schema file may need to mirror"))).toBe(
			false,
		);
	});

	it("flags only the schema-companion suffixes that actually exist (exact set, exact reason)", () => {
		const edited = file("src/order.types.ts");
		const schema = file("src/order.types.schema.ts");
		// .schema.json and .zod.ts are deliberately absent.
		const targets = findPropagationTargets(edited, root);
		const schemaTargets = targets.filter(
			(t) => t.category === "schema" && t.reason.includes("mirror"),
		);
		expect(schemaTargets).toStrictEqual([
			{
				file: schema,
				reason: "Schema file may need to mirror changes in src/order.types.ts",
				category: "schema",
				confidence: "high",
			},
		]);
	});
});

describe("mutation hardening — schemaOpenApi", () => {
	it("flags no spec file when none of the five variants exist", () => {
		const edited = file("src/user-handler.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API spec may need"))).toBe(false);
	});
});

describe("mutation hardening — schemaOpenApi (exact spec filenames)", () => {
	it("flags exactly openapi.json when only that variant exists (kills 161 string literal)", () => {
		const edited = file("src/user-handler.ts");
		const spec = file("openapi.json");
		const targets = findPropagationTargets(edited, root);
		const specTargets = targets.filter((t) => t.reason.includes("API spec may need"));
		expect(specTargets).toStrictEqual([
			{
				file: spec,
				reason: "API spec may need updating after changes to src/user-handler.ts",
				category: "schema",
				confidence: "medium",
			},
		]);
	});

	it("flags exactly swagger.yaml when only that variant exists (kills 162 string literal)", () => {
		const edited = file("src/user-handler.ts");
		const spec = file("swagger.yaml");
		const targets = findPropagationTargets(edited, root);
		const specTargets = targets.filter((t) => t.reason.includes("API spec may need"));
		expect(specTargets).toStrictEqual([
			{
				file: spec,
				reason: "API spec may need updating after changes to src/user-handler.ts",
				category: "schema",
				confidence: "medium",
			},
		]);
	});

	it("flags exactly swagger.json when only that variant exists (kills 163 string literal)", () => {
		const edited = file("src/user-handler.ts");
		const spec = file("swagger.json");
		const targets = findPropagationTargets(edited, root);
		const specTargets = targets.filter((t) => t.reason.includes("API spec may need"));
		expect(specTargets).toStrictEqual([
			{
				file: spec,
				reason: "API spec may need updating after changes to src/user-handler.ts",
				category: "schema",
				confidence: "medium",
			},
		]);
	});

	it("flags exactly api.yaml when only that variant exists (kills 164 string literal)", () => {
		const edited = file("src/user-handler.ts");
		const spec = file("api.yaml");
		const targets = findPropagationTargets(edited, root);
		const specTargets = targets.filter((t) => t.reason.includes("API spec may need"));
		expect(specTargets).toStrictEqual([
			{
				file: spec,
				reason: "API spec may need updating after changes to src/user-handler.ts",
				category: "schema",
				confidence: "medium",
			},
		]);
	});
});

describe("mutation hardening — testFixturesSnapshots", () => {
	it("skips fixtures/snapshots discovery for a name containing __test but keeps working for a plain name", () => {
		// Sanity anchor: a plain module WITH a matching fixture does get flagged
		// (already covered elsewhere); this block only needs the negative half
		// above (isTestFile true) plus the exact reason text below.
		const edited = file("src/reader.ts");
		const fixture = file("src/__fixtures__/reader.json", "{}");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === fixture);
		expect(t).toStrictEqual({
			file: fixture,
			reason: "Test fixture for src/reader.ts may need updating",
			category: "test",
			confidence: "medium",
		});
	});
});

describe("mutation hardening — configCliReadme", () => {
	it("flags a lowercase readme.md when README.md is absent (loop entry, not just the first)", () => {
		const edited = file("src/commands/run.ts");
		const readme = file("readme.md", "## Commands\nlist");
		const targets = findPropagationTargets(edited, root);
		expect(
			targets.some(
				(t) => t.file === readme && t.reason.includes("README CLI documentation"),
			),
		).toBe(true);
	});

	it("matches a CLI heading with zero spaces after the hash", () => {
		const edited = file("src/commands/run.ts");
		const readme = file("README.md", "#Commands\nrun stuff");
		const targets = findPropagationTargets(edited, root);
		expect(
			targets.some(
				(t) => t.file === readme && t.reason.includes("README CLI documentation"),
			),
		).toBe(true);
	});

	it("matches a singular '# Command' heading (the 's' in commands? is optional)", () => {
		const edited = file("src/commands/run.ts");
		const readme = file("README.md", "# Command\nsingular heading, no trailing s");
		const targets = findPropagationTargets(edited, root);
		expect(
			targets.some(
				(t) => t.file === readme && t.reason.includes("README CLI documentation"),
			),
		).toBe(true);
	});

	it("returns the exact README CLI-doc target object", () => {
		const edited = file("src/commands/run.ts");
		const readme = file("README.md", "## Commands\nlist of commands");
		const targets = findPropagationTargets(edited, root);
		// docReadme (a separate helper) also flags README.md unconditionally —
		// find the CLI-specific target by its distinct reason text.
		const t = targets.find(
			(x) => x.file === readme && x.reason.includes("README CLI documentation"),
		);
		expect(t).toStrictEqual({
			file: readme,
			reason:
				"README CLI documentation may need updating after command changes in src/commands/run.ts",
			category: "documentation",
			confidence: "medium",
		});
	});
});

describe("mutation hardening — configCli", () => {
	it("does not run the CLI-config block at all for a file unrelated to commands/index/cli", () => {
		// Guard-bypass fixture: isCliEdit is false for this name/path, but every
		// artifact the CLI block would flag if it ran anyway is present.
		const edited = file("src/random-thing.ts");
		file("src/completions.ts");
		file("package.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(targets).toStrictEqual([]);
	});

	it("does not flag any shell-completions file when none of the four variants exist", () => {
		const edited = file("src/commands/nought.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Shell completions"))).toBe(false);
	});

	it("does not self-reference when the edited file IS completions.ts itself", () => {
		const edited = file("src/commands/completions.ts", "// completions");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Shell completions"))).toBe(false);
	});

	it("returns the exact completions target object (category/confidence pinned)", () => {
		const edited = file("src/commands/cmd.ts");
		const comp = file("src/commands/completions.sh");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === comp);
		expect(t).toStrictEqual({
			file: comp,
			reason: "Shell completions may need updating after CLI changes in src/commands/cmd.ts",
			category: "config",
			confidence: "medium",
		});
	});

	it("returns the exact completions.zsh target object (kills 254 string literal)", () => {
		const edited = file("src/commands/cmd.ts");
		const comp = file("src/commands/completions.zsh");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === comp);
		expect(t).toStrictEqual({
			file: comp,
			reason: "Shell completions may need updating after CLI changes in src/commands/cmd.ts",
			category: "config",
			confidence: "medium",
		});
	});

	it("returns the exact completions.fish target object (kills 255 string literal)", () => {
		const edited = file("src/commands/cmd.ts");
		const comp = file("src/commands/completions.fish");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === comp);
		expect(t).toStrictEqual({
			file: comp,
			reason: "Shell completions may need updating after CLI changes in src/commands/cmd.ts",
			category: "config",
			confidence: "medium",
		});
	});

	it("does not flag package.json when it does not exist on disk", () => {
		const edited = file("src/commands/nopkg.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Check package.json"))).toBe(false);
	});

	it("returns the exact package.json target object (reason + low confidence pinned)", () => {
		const edited = file("src/commands/run.ts");
		const pkg = file("package.json", "{}");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === pkg);
		expect(t).toStrictEqual({
			file: pkg,
			reason: "Check package.json bin/scripts after CLI changes in src/commands/run.ts",
			category: "config",
			confidence: "low",
		});
	});
});

describe("mutation hardening — configEnv", () => {
	it("does not flag any env template when none of the three variants exist", () => {
		const edited = file("src/config.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Environment template"))).toBe(false);
	});
});

describe("mutation hardening — configEnv (exact filenames + existsSync guard)", () => {
	it("flags exactly .env.sample when only that variant exists (kills 288 string literal)", () => {
		const edited = file("src/config.ts");
		const env = file(".env.sample");
		const targets = findPropagationTargets(edited, root);
		const envTargets = targets.filter((t) => t.reason.includes("Environment template"));
		expect(envTargets).toStrictEqual([
			{
				file: env,
				reason: "Environment template may need updating after config changes in src/config.ts",
				category: "config",
				confidence: "medium",
			},
		]);
	});

	it("flags exactly .env.template when only that variant exists (kills second 288 string literal)", () => {
		const edited = file("src/config.ts");
		const env = file(".env.template");
		const targets = findPropagationTargets(edited, root);
		const envTargets = targets.filter((t) => t.reason.includes("Environment template"));
		expect(envTargets).toStrictEqual([
			{
				file: env,
				reason: "Environment template may need updating after config changes in src/config.ts",
				category: "config",
				confidence: "medium",
			},
		]);
	});

	it("does not flag any env template when the name matches but none of the files exist (kills 290 existsSync guard)", () => {
		// name.includes("config") is true (isCliEdit-analogous keyword guard passes)
		// but no .env.* file exists on disk — existsSync(envFile) must gate the push.
		const edited = file("src/config.ts");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("Environment template"))).toBe(false);
	});
});

describe("mutation hardening — configGuardRules", () => {
	it("does not run the guard-rules block for a name that is not guard-rules.json / rules-loader", () => {
		// Guard-bypass fixture: name matches neither keyword, but CLAUDE.md
		// (the artifact the block would flag) is present.
		const edited = file("src/other-thing.ts");
		file("CLAUDE.md", "guard rules doc");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("CLAUDE.md documents guard rules"))).toBe(
			false,
		);
	});
});

describe("mutation hardening — contractToolRegistry", () => {
	it("does not run the tool-registry block for a path outside handlers/entries", () => {
		// Guard-bypass fixture: rel matches neither keyword, but the registry
		// index (the artifact the block would flag) exists.
		const edited = file("src/unrelated/thing.ts");
		file("src/tool-registry/index.ts", "// registry");
		const targets = findPropagationTargets(edited, root);
		expect(targets).toStrictEqual([]);
	});

	it("returns the exact tool-registry target object (reason text pinned)", () => {
		const edited = file("src/tools/handlers/search.ts");
		const registry = file("src/tool-registry/index.ts", "// registry");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === registry);
		expect(t).toStrictEqual({
			file: registry,
			reason:
				"Tool registry may need updating after handler changes in src/tools/handlers/search.ts",
			category: "contract",
			confidence: "medium",
		});
	});
});

describe("mutation hardening — contractEndpointDocs", () => {
	it("does not run the endpoint-docs block for a name that is not worker/router/handler", () => {
		// Guard-bypass fixture: name matches none of the three keywords, but
		// CLAUDE.md mentions "API Endpoints" (what the block would flag).
		const edited = file("src/plain-file.ts");
		file("CLAUDE.md", "## API Endpoints\n- /foo");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.reason.includes("API endpoint table"))).toBe(false);
	});
});

describe("mutation hardening — depLockFiles", () => {
	it("does not run the lock-file scan for a file whose name is not package.json", () => {
		// Guard-bypass fixture: name !== "package.json", but a lock file sits
		// in the same directory (what the block would flag if it ran anyway).
		const edited = file("src/other.ts");
		file("src/package-lock.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(targets.some((t) => t.category === "dependency")).toBe(false);
	});

	it("produces no garbage entries when editing package.json with zero lock files present", () => {
		// Kills an ArrayDeclaration mutant that seeds `targets` with a bogus
		// string literal instead of []: every real target must be a
		// PropagationTarget object (string `.file` field), never a bare string.
		const edited = file("package.json", "{}");
		const targets = findPropagationTargets(edited, root);
		for (const t of targets) {
			expect(typeof t.file).toBe("string");
		}
		expect(targets.some((t) => t.category === "dependency")).toBe(false);
	});

	it("returns the exact lock-file target object (reason text pinned)", () => {
		const edited = file("package.json", "{}");
		const lock = file("package-lock.json", "{}");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === lock);
		expect(t).toStrictEqual({
			file: lock,
			reason: "Lock file should be regenerated after package.json changes (run install)",
			category: "dependency",
			confidence: "high",
		});
	});
});

describe("mutation hardening — genDts", () => {
	it("returns the exact .d.ts target object (confidence pinned)", () => {
		const edited = file("src/types.ts");
		const dts = file("src/types.d.ts", "export {};");
		const targets = findPropagationTargets(edited, root);
		const t = targets.find((x) => x.file === dts);
		expect(t).toStrictEqual({
			file: dts,
			reason: "Type declaration file may be stale after changes to src/types.ts",
			category: "generated",
			confidence: "medium",
		});
	});
});

describe("mutation hardening — isTestFile (via barrel + fixtures gating)", () => {
	it("does not treat a mid-name '.test.' occurrence as a test file when it is not the trailing suffix", () => {
		// "foo.test.bar.ts" has ".test." in the middle, not immediately before
		// the final extension — isTestFile must be false, so the fixtures scan
		// still runs and finds the matching fixture.
		const edited = file("src/foo.test.bar.ts");
		const fixture = file("src/__fixtures__/foo.test.bar-sample.json", "{}");
		const targets = findPropagationTargets(edited, root);
		expect(fileNames(targets)).toContain(fixture);
	});
});

describe("mutation hardening — formatPropagationWarnings", () => {
	it("renders the exact 'Also check' line: comma-space separator, no stray suffix at <=4 items", () => {
		const targets = [
			{
				file: join(root, "a.ts"),
				reason: "r",
				category: "documentation" as const,
				confidence: "medium" as const,
			},
			{
				file: join(root, "b.ts"),
				reason: "r",
				category: "schema" as const,
				confidence: "medium" as const,
			},
		];
		const warnings = formatPropagationWarnings(targets, root);
		expect(warnings).toStrictEqual(["[interlinked:propagation] Also check: a.ts, b.ts"]);
	});
});

describe("formatPropagationWarnings", () => {
	it("returns an empty array when there are no targets", () => {
		expect(formatPropagationWarnings([], root)).toEqual([]);
	});

	it("renders each high-confidence target on its own line", () => {
		const targets = findPropagationTargets(
			(() => {
				const edited = file("src/eng.ts");
				file("CLAUDE.md", "eng subsystem");
				return edited;
			})(),
			root,
		);
		const high = targets.filter((t) => t.confidence === "high");
		expect(high.length).toBeGreaterThanOrEqual(1);
		const warnings = formatPropagationWarnings(targets, root);
		expect(warnings.some((w) => w.startsWith("[interlinked:propagation]"))).toBe(true);
		expect(warnings.some((w) => w.includes("→"))).toBe(true);
	});

	it("aggregates medium-confidence targets into a single 'Also check' line", () => {
		const targets = [
			{
				file: join(root, "a.ts"),
				reason: "r",
				category: "documentation" as const,
				confidence: "medium" as const,
			},
			{
				file: join(root, "b.ts"),
				reason: "r",
				category: "schema" as const,
				confidence: "medium" as const,
			},
		];
		const warnings = formatPropagationWarnings(targets, root);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Also check:");
		expect(warnings[0]).toContain("a.ts");
		expect(warnings[0]).toContain("b.ts");
	});

	it("caps the 'Also check' list at 4 files and appends a '+N more' suffix", () => {
		const targets = Array.from({ length: 7 }, (_, i) => ({
			file: join(root, `m${i}.ts`),
			reason: "r",
			category: "test" as const,
			confidence: "medium" as const,
		}));
		const warnings = formatPropagationWarnings(targets, root);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("+3 more");
		// Only the first four file names appear.
		expect(warnings[0]).toContain("m0.ts");
		expect(warnings[0]).toContain("m3.ts");
		expect(warnings[0]).not.toContain("m4.ts");
	});

	it("omits the '+N more' suffix when there are exactly 4 medium targets", () => {
		const targets = Array.from({ length: 4 }, (_, i) => ({
			file: join(root, `m${i}.ts`),
			reason: "r",
			category: "test" as const,
			confidence: "medium" as const,
		}));
		const warnings = formatPropagationWarnings(targets, root);
		expect(warnings[0]).not.toContain("more");
	});

	it("renders the exact line at exactly 4 medium targets, with no suffix junk appended (kills 415 string literal)", () => {
		const targets = Array.from({ length: 4 }, (_, i) => ({
			file: join(root, `m${i}.ts`),
			reason: "r",
			category: "test" as const,
			confidence: "medium" as const,
		}));
		const warnings = formatPropagationWarnings(targets, root);
		expect(warnings).toStrictEqual([
			"[interlinked:propagation] Also check: m0.ts, m1.ts, m2.ts, m3.ts",
		]);
	});

	it("drops low-confidence targets from the rendered output", () => {
		const targets = [
			{
				file: join(root, "low.ts"),
				reason: "r",
				category: "documentation" as const,
				confidence: "low" as const,
			},
		];
		// Only-low targets produce no warnings (no high, no medium).
		expect(formatPropagationWarnings(targets, root)).toEqual([]);
	});

	it("renders both a high line and a medium 'Also check' line together", () => {
		const targets = [
			{
				file: join(root, "hi.ts"),
				reason: "important",
				category: "schema" as const,
				confidence: "high" as const,
			},
			{
				file: join(root, "med.ts"),
				reason: "r",
				category: "test" as const,
				confidence: "medium" as const,
			},
		];
		const warnings = formatPropagationWarnings(targets, root);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("important");
		expect(warnings[1]).toContain("Also check:");
	});
});
