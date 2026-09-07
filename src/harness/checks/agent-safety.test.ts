import { describe, expect, it } from "vitest";
import * as agentSafety from "./agent-safety.js";
import * as asyncChecks from "./agent-safety-async.js";
import * as cryptoChecks from "./agent-safety-crypto.js";
import * as dependencyChecks from "./agent-safety-deps.js";
import * as correctnessChecks from "./agent-safety-js-correctness.js";

// `agent-safety.ts` is a thin barrel: the detector implementations live in
// family-grouped sibling modules (`agent-safety-async`, `agent-safety-deps`,
// `agent-safety-js-correctness`, `agent-safety-crypto`), each with its own
// behavioral test file. This file guards the BARREL itself — that every
// public symbol importers depend on is re-exported and callable. Behavioral
// coverage lives in the sibling `agent-safety-*.test.ts` files and in
// `src/harness/__tests__/`.

// The full public API surface, as consumed by `generic-checks.ts`, the check
// registry, and downstream tests. Any drop here is a breaking change to an
// importer, so the list is pinned.
const EXPECTED_CHECK_EXPORTS = [
	// async
	"checkAsyncPromiseExecutor",
	"checkFloatingPromises",
	"checkMisusedPromises",
	"checkSilentPromiseSwallow",
	// deps
	"checkExtraneousDependencies",
	"checkPhantomDependencies",
	"checkSelfImport",
	"findWorkspaceRootFor",
	// js-correctness
	"checkBroadObjectTypes",
	"checkConstantCondition",
	"checkEvalUsage",
	"checkInnerHtmlUsage",
	"checkJsLooseEquality",
	"checkMagicLiteralInConditional",
	"checkNanComparison",
	"checkNonNullAssertions",
	"checkNumberPrecisionLoss",
	"checkUnsafeOptionalChaining",
	// crypto
	"checkAesEcbMode",
	"checkRecursiveWalkerLstat",
	"checkTlsVerifyDisabled",
	"checkWeakHash",
	"checkWeakRandom",
] as const;

describe("agent-safety barrel — public API surface", () => {
	it("binds every public check name to its family implementation", () => {
		const implementations = { ...asyncChecks, ...cryptoChecks, ...dependencyChecks, ...correctnessChecks };
		for (const name of EXPECTED_CHECK_EXPORTS) {
			expect(agentSafety[name], name).toBe(implementations[name]);
		}
	});

	it("a content check re-exported through the barrel still fires", () => {
		// Smoke: confirm the re-export is wired to the live implementation, not
		// a stub. AES.MODE_ECB is an unambiguous positive for the crypto family.
		expect(agentSafety.checkAesEcbMode("c = AES.new(k, AES.MODE_ECB)", "a.py").length).toBeGreaterThan(
			0,
		);
	});

	it("does NOT fire on benign content (negative path)", () => {
		// The re-export must stay faithful to the implementation's negatives too:
		// AES-GCM is the safe mode and must not be flagged.
		expect(agentSafety.checkAesEcbMode('createCipheriv("aes-256-gcm", k, iv)', "a.ts")).toEqual([]);
	});

	it("findWorkspaceRootFor returns the starting directory when no workspace marker exists", () => {
		// Non-existent path: walks up, finds no workspace marker, returns the
		// immediate (start) dir. Confirms the value re-export resolves.
		const out = agentSafety.findWorkspaceRootFor("/nonexistent-xyz/pkg/package.json");
		expect(out).toBe("/nonexistent-xyz/pkg");
	});
});
