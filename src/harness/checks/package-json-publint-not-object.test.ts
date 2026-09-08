// Isolated file (own `vi.mock`, hoisted, single test) for the
// `!(mod instanceof Object)` guard inside `runPublint`. Split from the
// sibling `package-json-publint.test.ts` because per-test `vi.doMock` calls
// against the SAME bare specifier proved unreliable for a plain dynamic
// `import(variable)` across multiple tests in one file — a single hoisted
// `vi.mock` per file is the reliable shape.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";

// The mocked "publint" module resolves to a bare number — not an object —
// so `mod instanceof Object` is false and `runPublint` returns null before
// ever reading `.publint` off it.
vi.mock("publint", () => 42);

const FULL_PKG = { name: "my-pkg", version: "1.0.0", homepage: "https://example.com" };

let tmp = "";
let pkgPath = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pjpi-publint-notobj-"));
	writeFileSync(join(tmp, "package-lock.json"), "{}");
	pkgPath = join(tmp, "package.json");
	writeFileSync(pkgPath, JSON.stringify(FULL_PKG));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("checkPackageJsonPublishInvariantsWithPublint — mocked publint module is not an object", () => {
	it("degrades to base findings only (runPublint returns null on the instanceof-Object guard)", async () => {
		const { checkPackageJsonPublishInvariantsWithPublint } = await import("./package-json.js");
		const { homepage: _homepage, ...postEdit } = FULL_PKG;
		void _homepage;
		const findings = await checkPackageJsonPublishInvariantsWithPublint(
			JSON.stringify(postEdit),
			pkgPath,
		);
		// Exactly the base "homepage removed" finding — nothing publint-shaped
		// got appended, proving the guard fired instead of reading `.publint`.
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("`homepage`");
	});
});
