import { describe, expect, it } from "vitest";
import { jsModuleIndex, pythonModuleIndex, resolveJsImports, resolvePythonImports } from "./check-test-resolve.js";

const PY = pythonModuleIndex(["src/pkg/sub/mod.py", "src/pkg/other.py", "pkg2/mod.py", "app/utils.py", "lib/utils.py", "utils.py"]);

describe("MUST-FIRE: python import resolution", () => {
	it("P1: a dotted import resolves to a module under a source root (src layout) by component-aligned suffix", () => {
		expect([...resolvePythonImports(PY, "tests/test_a.py", "from pkg.sub.mod import f\n").modules]).toEqual(["src/pkg/sub/mod.py"]);
		expect([...resolvePythonImports(PY, "tests/test_a.py", "import pkg.other\n").modules]).toEqual(["src/pkg/other.py"]);
	});
	it("P2: a name in a from-import resolves as a submodule when it is one", () => {
		expect([...resolvePythonImports(PY, "tests/test_a.py", "from pkg.sub import mod\n").modules]).toEqual(["src/pkg/sub/mod.py"]);
	});
	it("P3: a relative import resolves against the test file's own directory", () => {
		const index = pythonModuleIndex(["pkg/tests/helpers.py", "pkg/core/engine.py"]);
		expect([...resolvePythonImports(index, "pkg/tests/test_x.py", "from . import helpers\n").modules]).toEqual(["pkg/tests/helpers.py"]);
		expect([...resolvePythonImports(index, "pkg/tests/test_x.py", "from ..core.engine import Run\n").modules]).toEqual(["pkg/core/engine.py"]);
	});
	it("P4: a patch target string resolves by its longest module prefix", () => {
		const text = 'def test_x():\n    with patch("pkg.sub.mod.func"):\n        pass\n';
		expect([...resolvePythonImports(PY, "tests/test_a.py", text).modules]).toEqual(["src/pkg/sub/mod.py"]);
	});
	it("P5: an ambiguous single-name import prefers the module at the repository root and is counted", () => {
		const result = resolvePythonImports(PY, "tests/test_a.py", "import utils\n");
		expect([...result.modules]).toEqual(["utils.py"]);
		expect(result.ambiguous).toBe(1);
	});
});

describe("python re-exports through a package __init__", () => {
	const inits: Record<string, string> = {
		"library/catalog/__init__.py": "from .utils import read_page, helper\nfrom .config import PageOptions as Cfg\nfrom library.catalog.batch import *\n",
		"library/__init__.py": "from .catalog import read_page\n",
	};
	const index = pythonModuleIndex(["library/catalog/utils.py", "library/catalog/config.py", "library/catalog/batch.py", "library/catalog/other.py"], Object.keys(inits), (path) => inits[path] ?? null);
	it("P6: a from-import of a name that the package re-exports credits the module that defines it (relative, aliased and star forms)", () => {
		expect([...resolvePythonImports(index, "tests/test_a.py", "from library.catalog import read_page\n").modules].sort()).toEqual(["library/catalog/batch.py", "library/catalog/utils.py"]);
		expect([...resolvePythonImports(index, "tests/test_a.py", "from library.catalog import PageOptions\n").modules].sort()).toEqual(["library/catalog/batch.py", "library/catalog/config.py"]);
	});
	it("P7: a re-export chain across two packages is followed", () => {
		expect([...resolvePythonImports(index, "tests/test_a.py", "from library import read_page\n").modules]).toContain("library/catalog/utils.py");
	});
	it("N5: a name that the package does not re-export credits only star-imported modules, never the others", () => {
		const modules = [...resolvePythonImports(index, "tests/test_a.py", "from library.catalog import nothing_here\n").modules];
		expect(modules).toEqual(["library/catalog/batch.py"]);
		expect(modules).not.toContain("library/catalog/other.py");
	});
});

describe("python attribute use of a plain import", () => {
	const inits: Record<string, string> = { "reading_room/__init__.py": "from . import disk\nfrom .format import ShelfFormat, detect\n" };
	const index = pythonModuleIndex(["reading_room/format.py", "reading_room/disk.py", "reading_room/unused_module.py"], Object.keys(inits), (path) => inits[path] ?? null);
	it("P8: `import pkg` then `pkg.name` credits the module that defines the name, and a used submodule", () => {
		const text = "import reading_room\n\ndef test_x():\n    assert reading_room.detect()\n    reading_room.disk.read()\n";
		expect([...resolvePythonImports(index, "tests/test_a.py", text).modules].sort()).toEqual(["reading_room/disk.py", "reading_room/format.py"]);
	});
	it("P9: an alias binds the attribute use", () => {
		expect([...resolvePythonImports(index, "tests/test_a.py", "import reading_room as cc\ncc.detect()\n").modules]).toEqual(["reading_room/format.py"]);
	});
	it("N7: an import whose attributes are never used credits nothing, and an attribute of another name does not leak", () => {
		expect(resolvePythonImports(index, "tests/test_a.py", "import reading_room\nother.detect()\n").modules.size).toBe(0);
		expect(resolvePythonImports(index, "tests/test_a.py", "import reading_room\nx = my_reading_room.detect\n").modules.size).toBe(0);
	});
});

describe("MUST-NOT-FIRE: python import resolution", () => {
	it("N1: the standard library, third-party packages and a longer dotted name that is not a suffix resolve nothing", () => {
		expect(resolvePythonImports(PY, "tests/test_a.py", "import os\nimport requests\nfrom other.mod import x\n").modules.size).toBe(0);
	});
	it("N2: a package marker is not a module, so importing a package credits no module by itself", () => {
		const index = pythonModuleIndex(["pkg/mod.py"]);
		expect(resolvePythonImports(index, "tests/test_a.py", "import pkg\nfrom pkg import something_defined_in_init\n").modules.size).toBe(0);
	});
});

const JS = jsModuleIndex(["src/lib/foo.ts", "src/lib/bar/index.ts", "src/util/baz.tsx", "src/other/foo.ts"]);

describe("MUST-FIRE: js import resolution", () => {
	it("P6: a relative specifier resolves with an extension swap and as a directory index", () => {
		const text = 'import a from "../src/lib/foo.js";\nimport b from "../src/lib/bar";\nimport c from "../src/util/baz";\n';
		expect([...resolveJsImports(JS, "tests/x.test.ts", text).modules].sort()).toEqual(["src/lib/bar/index.ts", "src/lib/foo.ts", "src/util/baz.tsx"]);
	});
	it("P7: an alias prefix is stripped and the rest matches by path suffix; vi.mock counts", () => {
		const result = resolveJsImports(JS, "tests/x.test.ts", 'import a from "@/lib/foo";\nvi.mock("~/util/baz");\n');
		expect([...result.modules].sort()).toEqual(["src/lib/foo.ts", "src/util/baz.tsx"]);
	});
});

describe("js workspace aliases", () => {
	const index = jsModuleIndex(["apps/api/src/services/course/compliance.ts", "packages/db/src/queries/course/people.ts", "packages/react/src/x.ts"]);
	it("P8: a scoped alias drops the scope and then a package directory, and matches the rest by suffix", () => {
		const text = 'vi.mock("@api/services/course/compliance");\nvi.mock("@cio/db/queries/course/people");\n';
		expect([...resolveJsImports(index, "apps/api/src/__tests__/a.test.ts", text).modules].sort()).toEqual(["apps/api/src/services/course/compliance.ts", "packages/db/src/queries/course/people.ts"]);
	});
	it("N6: a third-party scoped package and a single-component scoped import credit nothing", () => {
		const text = 'import a from "@testing-library/react";\nimport b from "@cio/react";\nimport c from "@scope/pkg/dist/index";\n';
		expect(resolveJsImports(index, "tests/a.test.ts", text).modules.size).toBe(0);
	});
});

describe("js barrels", () => {
	const files: Record<string, string> = {
		"src/routes/marketing/index.ts": 'export * from "./marketing";\nexport { other as renamed } from "./other";\n',
		"src/routes/deep/index.ts": 'export { inner } from "./index2";\n',
		"src/routes/deep/index2/index.ts": 'export * from "./real";\n',
	};
	const index = jsModuleIndex(["src/routes/marketing/marketing.ts", "src/routes/marketing/other.ts", "src/routes/marketing/unrelated.ts", "src/routes/deep/index2/real.ts"], Object.keys(files), (path) => files[path] ?? null);
	it("P9: an import of a directory index credits the modules it re-exports (star always, named only when the test takes the name)", () => {
		const star = resolveJsImports(index, "apps/api/__tests__/a.test.ts", 'import { marketingRouter } from "@api/routes/marketing";\n');
		expect([...star.modules]).toEqual(["src/routes/marketing/marketing.ts"]);
		const renamed = resolveJsImports(index, "apps/api/__tests__/a.test.ts", 'import { renamed } from "@api/routes/marketing";\n');
		expect([...renamed.modules].sort()).toEqual(["src/routes/marketing/marketing.ts", "src/routes/marketing/other.ts"]);
		expect([...resolveJsImports(index, "apps/api/__tests__/a.test.ts", 'import * as all from "@api/routes/marketing";\n').modules].sort()).toEqual(["src/routes/marketing/marketing.ts", "src/routes/marketing/other.ts"]);
	});
	it("P10: a barrel of barrels is followed, and a module the barrel does not re-export is never credited", () => {
		const deep = resolveJsImports(index, "tests/a.test.ts", 'import { inner } from "../src/routes/deep";\n');
		expect([...deep.modules]).toEqual(["src/routes/deep/index2/real.ts"]);
		const none = resolveJsImports(index, "tests/a.test.ts", 'import { marketingRouter } from "../src/routes/marketing";\n');
		expect(none.modules.has("src/routes/marketing/unrelated.ts")).toBe(false);
	});
});

describe("MUST-NOT-FIRE: js import resolution", () => {
	it("N3: a bare package or a node: builtin resolves nothing; a missing relative file is counted unresolved", () => {
		const result = resolveJsImports(JS, "tests/x.test.ts", 'import r from "react";\nimport fs from "node:fs";\nimport m from "../src/missing";\n');
		expect(result.modules.size).toBe(0);
		expect(result.unresolved).toBe(1);
	});
	it("N4: an alias path that matches two modules by suffix is counted ambiguous; the module nearest to the test wins, a tie credits both (errs toward silence)", () => {
		const tie = resolveJsImports(JS, "tests/x.test.ts", 'import a from "@/foo";\n');
		expect([...tie.modules].sort()).toEqual(["src/lib/foo.ts", "src/other/foo.ts"]);
		expect(tie.ambiguous).toBe(1);
		const near = resolveJsImports(JS, "src/lib/foo.test.ts", 'import a from "@/foo";\n');
		expect([...near.modules]).toEqual(["src/lib/foo.ts"]);
	});
});
