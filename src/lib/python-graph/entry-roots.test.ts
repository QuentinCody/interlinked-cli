import { describe, expect, it } from "vitest";
import { discoverEntryRoots, resolveModuleName, type RootInputs } from "./entry-roots.js";
import type { PyModule, PyRole } from "./types.js";

function mod(path: string, extra: Partial<PyModule> = {}): PyModule {
	return { path, role: "other", mainGuard: false, all: [], star: false, getattr: false, dynamic: [], defs: [], dynamicComputed: [], loaderGlobs: [], ...extra };
}

function inputs(paths: Record<string, Partial<PyModule> | PyRole>, files: Record<string, string> = {}, extra: Partial<RootInputs> = {}): RootInputs {
	const modules = new Map(Object.entries(paths).map(([path, spec]) => [path, mod(path, typeof spec === "string" ? { role: spec } : spec)]));
	const all = { ...Object.fromEntries([...modules.keys()].map((path) => [path, ""])), ...files };
	return {
		modules,
		importRoots: [".", "src"],
		stringTargets: [],
		projectFiles: Object.keys(all),
		read: (path) => all[path] ?? null,
		head: (path) => all[path]?.slice(0, 120) ?? null,
		...extra,
	};
}

function kinds(roots: ReturnType<typeof discoverEntryRoots>, path: string): string[] {
	return roots.filter((root) => root.path === path).map((root) => root.kind);
}

describe("resolveModuleName", () => {
	const modules = new Map([["src/pkg/__init__.py", mod("src/pkg/__init__.py")], ["src/pkg/cli.py", mod("src/pkg/cli.py")], ["tool.py", mod("tool.py")]]);

	it("finds a module file or a package under any base", () => {
		expect(resolveModuleName("pkg.cli", [".", "src"], modules)).toBe("src/pkg/cli.py");
		expect(resolveModuleName("pkg", [".", "src"], modules)).toBe("src/pkg/__init__.py");
		expect(resolveModuleName("tool", ["."], modules)).toBe("tool.py");
	});

	it("MUST-NOT-FIRE: a third-party or missing name does not resolve", () => {
		expect(resolveModuleName("numpy.linalg", [".", "src"], modules)).toBeNull();
		expect(resolveModuleName("pkg.missing", [".", "src"], modules)).toBeNull();
	});
});

describe("discoverEntryRoots — rules from the files themselves", () => {
	it("MUST-FIRE: __main__.py, a __main__ guard, a test file and conftest.py are roots", () => {
		const roots = discoverEntryRoots(inputs({ "pkg/__main__.py": {}, "tool.py": { mainGuard: true }, "tests/test_a.py": "test", "tests/conftest.py": "test" }));
		expect(kinds(roots, "pkg/__main__.py")).toEqual(["main-module"]);
		expect(kinds(roots, "tool.py")).toEqual(["main-guard"]);
		expect(kinds(roots, "tests/test_a.py")).toEqual(["test"]);
		expect(kinds(roots, "tests/conftest.py")).toEqual(["conftest"]);
	});

	it("MUST-FIRE: manage.py, wsgi.py, asgi.py and setup.py are framework files", () => {
		const roots = discoverEntryRoots(inputs({ "manage.py": {}, "site/wsgi.py": {}, "site/asgi.py": {}, "setup.py": {} }));
		for (const path of ["manage.py", "site/wsgi.py", "site/asgi.py", "setup.py"]) expect(kinds(roots, path)).toEqual(["framework-file"]);
	});

	it("MUST-FIRE: a python shebang makes a script a root; a plain module is not", () => {
		const roots = discoverEntryRoots(inputs({ "bin/run": {}, "lib/plain.py": {}, "scripts/go.py": {} }, { "scripts/go.py": "#!/usr/bin/env python3\nprint(1)\n", "lib/plain.py": "x = 1\n" }));
		expect(kinds(roots, "scripts/go.py")).toEqual(["shebang"]);
		expect(kinds(roots, "lib/plain.py")).toEqual([]);
	});

	it("MUST-FIRE: alembic env.py and the files in versions/ when script.py.mako sits beside them", () => {
		const roots = discoverEntryRoots(inputs({ "db/env.py": {}, "db/versions/001_init.py": {}, "other/env.py": {} }, { "db/script.py.mako": "" }));
		expect(kinds(roots, "db/env.py")).toEqual(["alembic"]);
		expect(kinds(roots, "db/versions/001_init.py")).toEqual(["alembic"]);
		expect(kinds(roots, "other/env.py")).toEqual([]);
	});

	it("MUST-FIRE: a file that a loader names by glob pattern is a root; a pattern with no literal part is not", () => {
		const loader = { dynamicComputed: [7], loaderGlobs: ["extension_*/provider_*.py", "*.py", "**/*.py"] };
		const roots = discoverEntryRoots(inputs({
			"pkg/platform.py": loader,
			"pkg/providers/extension_books/provider_books.py": {},
			"pkg/providers/extension_books/helpers.py": {},
			"pkg/providers/other/provider_x.py": {},
		}));
		expect(kinds(roots, "pkg/providers/extension_books/provider_books.py")).toEqual(["loader-glob"]);
		expect(kinds(roots, "pkg/providers/extension_books/helpers.py")).toEqual([]);
		expect(kinds(roots, "pkg/providers/other/provider_x.py")).toEqual([]);
		expect(kinds(roots, "pkg/platform.py")).toEqual([]);
	});

	it("MUST-NOT-FIRE: a plain library module is not a root", () => {
		expect(discoverEntryRoots(inputs({ "pkg/__init__.py": {}, "pkg/core.py": {} }))).toEqual([]);
	});
});

describe("discoverEntryRoots — packaging metadata and commands", () => {
	it("MUST-FIRE: a console script and an entry-point group name their modules", () => {
		const toml = `[project.scripts]\nx = "pkg.cli:main"\n[project.entry-points."x.plugins"]\na = "pkg.plug:P"\n`;
		const roots = discoverEntryRoots(inputs({ "src/pkg/cli.py": {}, "src/pkg/plug.py": {} }, { "pyproject.toml": toml }));
		expect(kinds(roots, "src/pkg/cli.py")).toEqual(["console-script"]);
		expect(kinds(roots, "src/pkg/plug.py")).toEqual(["entry-point-group"]);
	});

	it("MUST-FIRE: a Makefile, a workflow and a Dockerfile name files and modules by literal path", () => {
		const files = {
			Makefile: "seed:\n\tpython scripts/seed.py\n",
			".github/workflows/ci.yml": "steps:\n  - run: python -m app.worker\n",
			Dockerfile: 'CMD ["uvicorn", "api.main:app"]\n',
		};
		const roots = discoverEntryRoots(inputs({ "scripts/seed.py": {}, "app/worker.py": {}, "api/main.py": {}, "api/other.py": {} }, files));
		expect(kinds(roots, "scripts/seed.py")).toEqual(["command"]);
		expect(kinds(roots, "app/worker.py")).toEqual(["command"]);
		expect(kinds(roots, "api/main.py")).toEqual(["command"]);
		expect(kinds(roots, "api/other.py")).toEqual([]);
	});

	it("MUST-FIRE: a documented python command is a root of its own kind", () => {
		const roots = discoverEntryRoots(inputs({ "examples/demo.py": {} }, { "README.md": "Run `python examples/demo.py`.\n" }));
		expect(kinds(roots, "examples/demo.py")).toEqual(["documented-command"]);
	});

	it("MUST-NOT-FIRE: a command path that is not a module of the tree is ignored", () => {
		expect(discoverEntryRoots(inputs({ "a.py": {} }, { Makefile: "x:\n\tpython missing.py\n" }))).toEqual([]);
	});

	it("MUST-FIRE: a path relative to the folder of the file that names it resolves", () => {
		const roots = discoverEntryRoots(inputs({ "ops/job.py": {} }, { "ops/Makefile": "run:\n\tpython job.py\n" }));
		expect(kinds(roots, "ops/job.py")).toEqual(["command"]);
	});
});

describe("discoverEntryRoots — framework strings", () => {
	it("MUST-FIRE: Django settings strings: installed apps, their conventional files, URL conf and pytest plugins", () => {
		const stringTargets = [
			{ from: "proj/settings.py", line: 3, setting: "INSTALLED_APPS", value: "blog", to: "blog/__init__.py" },
			{ from: "proj/settings.py", line: 3, setting: "INSTALLED_APPS", value: "shop.apps.ShopConfig", to: "shop/apps.py" },
			{ from: "proj/settings.py", line: 9, setting: "ROOT_URLCONF", value: "proj.urls", to: "proj/urls.py" },
			{ from: "conftest.py", line: 1, setting: "pytest_plugins", value: "fixtures.db", to: "fixtures/db.py" },
		];
		const paths = Object.fromEntries(["blog/__init__.py", "blog/models.py", "blog/admin.py", "blog/views.py", "blog/management/commands/seed.py", "blog/migrations/0001_initial.py", "shop/__init__.py", "shop/apps.py", "shop/models.py", "proj/urls.py", "fixtures/db.py"].map((path) => [path, {}]));
		const roots = discoverEntryRoots(inputs(paths, {}, { stringTargets }));
		expect(kinds(roots, "blog/models.py")).toEqual(["django-app"]);
		expect(kinds(roots, "blog/admin.py")).toEqual(["django-app"]);
		expect(kinds(roots, "blog/management/commands/seed.py")).toEqual(["django-app"]);
		expect(kinds(roots, "blog/migrations/0001_initial.py")).toEqual(["django-app"]);
		expect(kinds(roots, "shop/models.py")).toEqual(["django-app"]);
		expect(kinds(roots, "proj/urls.py")).toEqual(["django-settings"]);
		expect(kinds(roots, "fixtures/db.py")).toEqual(["pytest-plugin"]);
		expect(kinds(roots, "blog/views.py")).toEqual([]);
	});

	it("MUST-FIRE: DJANGO_SETTINGS_MODULE in manage.py names the settings module", () => {
		const manage = 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "proj.settings")\n';
		const roots = discoverEntryRoots(inputs({ "manage.py": {}, "proj/settings.py": {} }, { "manage.py": manage }));
		expect(kinds(roots, "proj/settings.py")).toEqual(["django-settings"]);
	});
});
