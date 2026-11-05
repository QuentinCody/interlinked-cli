// Mutation-directed companion for manifest-package-version.ts (kill-proof
// census 2026-11-05). Fault: the inline-table parser's trailing-content check
// (`if (body.slice(cursor).trim()) return undefined;`) loses its return, so an
// inline table the parser could not fully consume still yields its version
// and a fail-closed `<unspecified>` block becomes an accept.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToAllowlist, loadAllowlist } from "../package-allowlist.js";
import { evaluateManifestEdit } from "./manifest-edit-guard.js";
import { manifestPackageVersion } from "./manifest-package-version.js";

describe("manifestPackageVersion — partially parsed inline tables", () => {
	// test-contract: invariant - an inline table with unconsumed trailing content is not a version the gate may trust (fail closed)
	it("yields no version for an inline table whose tail the parser cannot consume", () => {
		expect(manifestPackageVersion("pypi", "pyyaml", '{ version = "6.0.3", priority = 1 }')).toBeUndefined();
		expect(manifestPackageVersion("cargo", "library", '{ version = "=1.2.3", priority = 1 }')).toBeUndefined();
	});
});

describe("manifest edit guard — partially parsed inline tables", () => {
	let workspace: string;
	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "manifest-version-kill-"));
	});
	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	// test-contract: bug - with an exact approval for 6.0.3, a Poetry inline table carrying an unparsable trailing field must still BLOCK, never be accepted on the partial version
	it("blocks a Poetry inline table with an unparsable trailing field even when the parsed version matches the approval", () => {
		addToAllowlist(workspace, "pypi", "pyyaml", { approved_by: "test-operator", version_range: "6.0.3" });
		const decision = evaluateManifestEdit({
			filePath: join(workspace, "pyproject.toml"),
			newContent: '[tool.poetry.dependencies]\npyyaml = { version = "6.0.3", priority = 1 }\n',
			cwd: workspace,
			allowlist: loadAllowlist(workspace),
		});
		expect(decision?.decision).toBe("block");
	});
});
