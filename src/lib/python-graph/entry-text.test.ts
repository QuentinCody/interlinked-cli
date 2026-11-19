import { describe, expect, it } from "vitest";
import { commandReferences, entryPointTargets } from "./entry-text.js";

describe("entryPointTargets", () => {
	it("MUST-FIRE: pyproject [project.scripts] names the module of each console script", () => {
		const toml = `[project]\nname = "x"\n[project.scripts]\nxcli = "x.cli:main"\nother = 'x.other:run'\n`;
		const found = entryPointTargets("pyproject.toml", toml);
		expect(found.map((item) => [item.module, item.kind])).toEqual([["x.cli", "console-script"], ["x.other", "console-script"]]);
	});

	it("MUST-FIRE: every entry-point group is a root, a plugin group included", () => {
		const toml = `[project.entry-points."myapp.plugins"]\nfoo = "myapp_foo.plugin:Plugin"\n[project.entry-points.pytest11]\nx = "x.pytest_plugin"\n`;
		const found = entryPointTargets("pyproject.toml", toml);
		expect(found).toEqual([
			{ module: "myapp_foo.plugin", kind: "entry-point-group", evidence: "project.entry-points.\"myapp.plugins\": foo" },
			{ module: "x.pytest_plugin", kind: "entry-point-group", evidence: "project.entry-points.pytest11: x" },
		]);
	});

	it("MUST-FIRE: poetry scripts and plugin tables", () => {
		const toml = `[tool.poetry.scripts]\nrun = "p.main:go"\n[tool.poetry.plugins."p.ext"]\na = "p.ext_a:A"\n`;
		expect(entryPointTargets("sub/pyproject.toml", toml).map((item) => item.module)).toEqual(["p.main", "p.ext_a"]);
	});

	it("MUST-FIRE: setup.cfg entry_points groups, console_scripts included", () => {
		const cfg = `[options.entry_points]\nconsole_scripts =\n    tool = pkg.tool:main\nmyapp.plugins =\n    one = pkg.one:One\n`;
		const found = entryPointTargets("setup.cfg", cfg);
		expect(found.map((item) => [item.module, item.kind])).toEqual([["pkg.tool", "console-script"], ["pkg.one", "entry-point-group"]]);
	});

	it("MUST-FIRE: setup.py quoted entry points when the file declares entry_points", () => {
		const py = `setup(entry_points={"console_scripts": ["a = pkg.a:main"], "other": ["b = pkg.b:B"]})`;
		expect(entryPointTargets("setup.py", py).map((item) => item.module)).toEqual(["pkg.a", "pkg.b"]);
	});

	it("MUST-NOT-FIRE: a string assignment that is not in a script table, and a setup.py without entry_points", () => {
		expect(entryPointTargets("pyproject.toml", `[tool.ruff]\nname = "a.b:c"\n`)).toEqual([]);
		expect(entryPointTargets("setup.py", `x = "a = pkg.a:main"`)).toEqual([]);
		expect(entryPointTargets("README.md", `[project.scripts]\nx = "a.b:c"`)).toEqual([]);
	});
});

describe("commandReferences", () => {
	it("MUST-FIRE: python <path>.py and python -m <module> in a Makefile or a workflow", () => {
		const text = `run:\n\tpython scripts/seed.py --fast\n\tpython3 -m app.worker\n  - run: python ./tools/check.py\n`;
		expect(commandReferences(text, "command")).toEqual({ files: ["scripts/seed.py", "tools/check.py"], modules: ["app.worker"] });
	});

	it("MUST-FIRE: an ASGI or WSGI server names a module:attribute", () => {
		const docker = `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]\nweb: gunicorn --workers 2 site.wsgi:application\n`;
		expect(commandReferences(docker, "command").modules).toEqual(["app.main", "site.wsgi"]);
	});

	it("MUST-FIRE: a JSON-array Dockerfile command with -m", () => {
		expect(commandReferences(`CMD ["python", "-m", "svc.run"]`, "command").modules).toEqual(["svc.run"]);
	});

	it("MUST-FIRE: a Python import written inside a shell script names a module", () => {
		const script = `python - <<'PY'\nfrom svc.tools.knowledge import Service\nPY\npython3 -c "import svc.health; print(1)"\n`;
		expect(commandReferences(script, "command").modules).toEqual(["svc.tools.knowledge", "svc.health"]);
	});

	it("MUST-NOT-FIRE: the word import in a prose line is not a module", () => {
		expect(commandReferences("# import the data and from there continue", "command").modules).toEqual([]);
	});

	it("MUST-FIRE: celery and flask application options", () => {
		const text = `celery -A proj.celery_app worker\nflask --app web.app run\n`;
		expect(commandReferences(text, "command").modules).toEqual(["proj.celery_app", "web.app"]);
	});

	it("MUST-FIRE: a runner that takes a script path", () => {
		expect(commandReferences("streamlit run ui/home.py\nuv run tools/gen.py", "command").files).toEqual(["ui/home.py", "tools/gen.py"]);
	});

	it("document mode takes only a line that starts a python command", () => {
		const doc = `Run it with python examples/demo.py or\n\`\`\`\npython -m pkg.cli --help\n\`\`\`\nSee notes/other.py for details.\n`;
		expect(commandReferences(doc, "document")).toEqual({ files: ["examples/demo.py"], modules: ["pkg.cli"] });
	});

	it("MUST-NOT-FIRE: a bare path in prose and a URL ending in .py", () => {
		expect(commandReferences("see notes/other.py for details", "document")).toEqual({ files: [], modules: [] });
		expect(commandReferences("curl https://example.com/get.py", "document")).toEqual({ files: [], modules: [] });
	});
});
