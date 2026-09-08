import { wireAbsentOptional, parseWire, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";

// The admission screens (license + OSV advisory) are network-backed; the
// command tests pin the screen LOGIC, so the network module is mocked
// wholesale. registry-metadata.test.ts owns the wire-shape coverage.
const fetchRegistryMetadataMock = vi.fn();
const queryOsvAdvisoriesMock = vi.fn();
const fetchVersionMetadataMock = vi.fn();
const fetchNpmPublishDatesMock = vi.fn();
vi.mock("../harness/registry-metadata.js", () => ({
	fetchRegistryMetadata: (...args: unknown[]) => fetchRegistryMetadataMock(...args),
	queryOsvAdvisories: (...args: unknown[]) => queryOsvAdvisoriesMock(...args),
	fetchVersionMetadata: (...args: unknown[]) => fetchVersionMetadataMock(...args),
	fetchNpmPublishDates: (...args: unknown[]) => fetchNpmPublishDatesMock(...args),
}));

// `takeAllowlistSnapshot`'s per-candidate stat has a catch-and-continue for a
// statSync failure after the existsSync check already passed (a TOCTOU race
// on the real filesystem — nothing in this test file can trigger it through
// real I/O since existsSync and statSync hit the same syscall back-to-back
// with no async gap). `statSync` is wrapped so a test can name one path to
// fail while every other `node:fs` call — including every other statSync
// call in this file — passes straight through to the real implementation
// (`vi.spyOn` can't redefine a live ESM named export here, same workaround as
// metrics-function-tokens.test.ts).
const fsStatFailures = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		statSync: (...args: Parameters<typeof actual.statSync>) => {
			const target = String(args[0]);
			if (fsStatFailures.has(target)) {
				throw Object.assign(new Error(`EACCES: permission denied, stat '${target}'`), {
					code: "EACCES",
				});
			}
			return actual.statSync(...args);
		},
	};
});

import {
	addAllowlistCommand,
	libyearsBehind,
	listAllowlistCommand,
	removeAllowlistCommand,
	snapshotAllowlistCommand,
	verifyAllowlistCommand,
} from "./allowlist.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "allowlist-cmd-test-"));
	// Default to the happy path: permissively-licensed package, no advisories.
	fetchRegistryMetadataMock.mockReset();
	queryOsvAdvisoriesMock.mockReset();
	fetchVersionMetadataMock.mockReset();
	fetchNpmPublishDatesMock.mockReset();
	fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: "MIT" });
	queryOsvAdvisoriesMock.mockResolvedValue([]);
	fetchVersionMetadataMock.mockResolvedValue(null);
	fetchNpmPublishDatesMock.mockResolvedValue(null);
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	process.exitCode = 0;
	fsStatFailures.clear();
});

function readAllowlistFile(): Record<string, unknown> | null {
	const p = join(workspace, ".interlinked", "package-allowlist.json");
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf-8"));
}

function capture(fn: () => void): string {
	const orig = process.stdout.write;
	let captured = "";
	process.stdout.write = ((
		chunk: string | Uint8Array,
	) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	});
	try {
		fn();
	} finally {
		process.stdout.write = orig;
	}
	return captured;
}

async function captureAsync(fn: () => Promise<void>): Promise<string> {
	const orig = process.stdout.write;
	let captured = "";
	process.stdout.write = ((
		chunk: string | Uint8Array,
	) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	});
	try {
		await fn();
	} finally {
		process.stdout.write = orig;
	}
	return captured;
}

describe("addAllowlistCommand", () => {
	it("adds an entry to the per-ecosystem map and persists it", async () => {
		await addAllowlistCommand("npm", "lodash", { reason: "util", by: "qcody", cwd: workspace });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireObject({ "approved_by": wireString, "reason": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(nonNull(parsed.packages.npm.lodash).approved_by).toBe("qcody");
		expect(nonNull(parsed.packages.npm.lodash).reason).toBe("util");
	});

	it("rejects an unknown ecosystem", async () => {
		await expect(
			addAllowlistCommand("badeco", "foo", { by: "x", cwd: workspace }),
		).rejects.toThrow(/ecosystem/i);
	});

	it("prints the exact 'unknown ecosystem' message including the comma-joined valid list", async () => {
		await expect(
			addAllowlistCommand("badeco", "foo", { by: "x", cwd: workspace }),
		).rejects.toThrow(
			'Unknown ecosystem "badeco". Valid: npm, pypi, cargo, rubygems, go, composer, maven, gradle, nuget',
		);
	});

	it("refuses to approve a typosquat name (npm) without --force", async () => {
		await expect(
			addAllowlistCommand("npm", "chlk", { by: "x", cwd: workspace }),
		).rejects.toThrow(/typosquat|chalk|distance/i);
	});

	it("allows the typosquat name when --force is passed", async () => {
		await addAllowlistCommand("npm", "chlk", { by: "x", cwd: workspace, force: true });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireUnknown) }) }), "test JSON value");
		expect(parsed.packages.npm.chlk).toBeDefined();
	});

	it("does not run typosquat detection for non-npm ecosystems", async () => {
		// 'requests' is exact-name popular, but 'requessts' is a typosquat by
		// npm-popular rules. PyPI gets a pass — different popular set, different
		// risk model; the npm typosquat list isn't relevant.
		await addAllowlistCommand("pypi", "chlk", { by: "x", cwd: workspace });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "pypi": wireRecord(wireUnknown) }) }), "test JSON value");
		expect(parsed.packages.pypi.chlk).toBeDefined();
	});
});

describe("addAllowlistCommand — license screen", () => {
	it("records the registry-declared license on the entry", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "qcody", cwd: workspace });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireObject({ "license": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(nonNull(parsed.packages.npm.lodash).license).toBe("MIT");
	});

	it("refuses a license outside the SPDX allowlist without --force", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "2.0.0", license: "AGPL-3.0" });
		await expect(
			addAllowlistCommand("npm", "copyleft-pkg", { by: "x", cwd: workspace }),
		).rejects.toThrow(/license "AGPL-3\.0".*allowlist/i);
		expect(readAllowlistFile()).toBeNull();
	});

	it("--force approves a disallowed license, records it, and says so", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "2.0.0", license: "AGPL-3.0" });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "copyleft-pkg", { by: "x", cwd: workspace, force: true }),
		);
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireObject({ "license": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(nonNull(parsed.packages.npm["copyleft-pkg"]).license).toBe("AGPL-3.0");
		expect(out).toMatch(/--force/);
	});

	it("prints the exact comma-joined SPDX allowlist in the refusal message", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "2.0.0", license: "AGPL-3.0" });
		await expect(
			addAllowlistCommand("npm", "copyleft-pkg2", { by: "x", cwd: workspace }),
		).rejects.toThrow(
			'license "AGPL-3.0" is not in the SPDX license allowlist (MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause',
		);
	});

	it("respects a committed license_allowlist override", async () => {
		// Seed an allowlist file whose license policy permits AGPL-3.0.
		const dir = join(workspace, ".interlinked");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package-allowlist.json"),
			JSON.stringify({
				version: 1,
				packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {} },
				lockfile_snapshots: {},
				license_allowlist: ["AGPL-3.0"],
			}),
		);
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: "AGPL-3.0" });
		await addAllowlistCommand("npm", "agpl-ok-here", { by: "x", cwd: workspace });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireObject({ "license": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(nonNull(parsed.packages.npm["agpl-ok-here"]).license).toBe("AGPL-3.0");
	});

	it("uses the PINNED version's license (not the latest) for a --version-range approval", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "2.0.0", license: "MIT" });
		fetchVersionMetadataMock.mockResolvedValue({ license: "GPL-3.0" });
		await expect(
			addAllowlistCommand("npm", "pinned-license-pkg", {
				by: "x",
				cwd: workspace,
				versionRange: "1.2.3",
			}),
		).rejects.toThrow(/license "GPL-3\.0" is not in the SPDX license allowlist/);
		expect(fetchVersionMetadataMock).toHaveBeenCalledWith("npm", "pinned-license-pkg", "1.2.3");
		expect(readAllowlistFile()).toBeNull();
	});

	it("approves with a loud note when the license is unknown", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: undefined });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "mystery-pkg", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/license.*unknown/i);
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireObject({ "license": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(nonNull(parsed.packages.npm["mystery-pkg"]).license).toBeUndefined();
	});
});

describe("addAllowlistCommand — advisory screen", () => {
	it("refuses a package with open advisories against latest without --force", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue([
			{ id: "GHSA-aaaa-bbbb", summary: "prototype pollution" },
		]);
		await expect(
			addAllowlistCommand("npm", "vuln-pkg", { by: "x", cwd: workspace }),
		).rejects.toThrow(/GHSA-aaaa-bbbb/);
		expect(readAllowlistFile()).toBeNull();
	});

	it("--force approves despite advisories and records the override note", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GHSA-aaaa-bbbb" }]);
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "vuln-pkg", { by: "x", cwd: workspace, force: true }),
		);
		expect(out).toMatch(/GHSA-aaaa-bbbb/);
		expect(out).toMatch(/--force/);
		expect(readAllowlistFile()).not.toBeNull();
	});

	it("queries OSV with the latest version the registry reported", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "3.2.1", license: "MIT" });
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		expect(queryOsvAdvisoriesMock).toHaveBeenCalledWith("npm", "lodash", "3.2.1");
	});

	it("approves with a note when OSV is unreachable (fail open, loud)", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue(null);
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/OSV.*skipped/i);
		expect(readAllowlistFile()).not.toBeNull();
	});

	it("skips the advisory screen with a note when no latest version is known", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: undefined, license: "MIT" });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/no version to screen.*advisory screen skipped/i);
		expect(queryOsvAdvisoriesMock).not.toHaveBeenCalled();
	});

	it("skips license AND advisory (no version) when metadata is unavailable and no range is pinned", async () => {
		fetchRegistryMetadataMock.mockResolvedValue(null);
		const out = await captureAsync(() =>
			addAllowlistCommand("go", "github.com/pkg/errors", { by: "x", cwd: workspace }),
		);
		expect(out).toMatch(/license screen skipped/i);
		expect(out).toMatch(/advisory screen skipped/i);
		expect(queryOsvAdvisoriesMock).not.toHaveBeenCalled(); // no version to screen
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "go": wireRecord(wireObject({ "license": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(parsed.packages.go["github.com/pkg/errors"]).toBeDefined();
		expect(nonNull(parsed.packages.go["github.com/pkg/errors"]).license).toBeUndefined();
	});

	// Round 7 (finding 2026-06): OSV needs no registry metadata. An exact
	// --version-range on Go (fetchRegistryMetadata always null) must still be
	// advisory-screened — previously the whole screen block sat behind
	// `meta !== null`, so a vulnerable pinned Go module was approved silently.
	it("STILL runs the OSV screen on an exact Go version pin when metadata is null", async () => {
		fetchRegistryMetadataMock.mockResolvedValue(null);
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GO-2023-vuln" }]);
		await expect(
			addAllowlistCommand("go", "github.com/pkg/errors", {
				by: "x",
				cwd: workspace,
				versionRange: "0.9.1",
			}),
		).rejects.toThrow(/GO-2023-vuln/);
		expect(queryOsvAdvisoriesMock).toHaveBeenCalledWith("go", "github.com/pkg/errors", "0.9.1");
		expect(readAllowlistFile()).toBeNull(); // refused, nothing written
	});

	it("names 'latest' and the singular 'advisory' when exactly one advisory is open and no pin was given", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GHSA-xxxx" }]);
		await expect(
			addAllowlistCommand("npm", "vuln-pkg2", { by: "x", cwd: workspace }),
		).rejects.toThrow(/1 open advisory against latest 1\.0\.0: GHSA-xxxx\./);
	});

	it("names 'pinned' and lists only the first 5 advisory ids (slice bound) when more than 5 are open", async () => {
		queryOsvAdvisoriesMock.mockResolvedValue([
			{ id: "GHSA-1" },
			{ id: "GHSA-2" },
			{ id: "GHSA-3" },
			{ id: "GHSA-4" },
			{ id: "GHSA-5" },
			{ id: "GHSA-6" },
		]);
		await expect(
			addAllowlistCommand("npm", "manyvuln-pkg", { by: "x", cwd: workspace, versionRange: "2.0.0" }),
		).rejects.toThrow(
			/6 open advisories against pinned 2\.0\.0: GHSA-1, GHSA-2, GHSA-3, GHSA-4, GHSA-5\. See/,
		);
	});

	it("--force approves a vulnerable pinned Go module with a loud note (metadata null)", async () => {
		fetchRegistryMetadataMock.mockResolvedValue(null);
		queryOsvAdvisoriesMock.mockResolvedValue([{ id: "GO-2023-vuln" }]);
		const out = await captureAsync(() =>
			addAllowlistCommand("go", "github.com/pkg/errors", {
				by: "x",
				cwd: workspace,
				versionRange: "0.9.1",
				force: true,
			}),
		);
		expect(out).toMatch(/GO-2023-vuln/);
		expect(out).toMatch(/pinned 0\.9\.1/);
		expect(readAllowlistFile()).not.toBeNull();
	});
});

describe("addAllowlistCommand — persisted output and fields", () => {
	it("prints the exact approved line (with license) and no note lines for a clean npm package", async () => {
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "lodash", { by: "qcody", cwd: workspace }),
		);
		expect(out).toBe("approved: npm:lodash (by qcody) — license MIT\n");
	});

	it("prints the exact approved line WITHOUT a license suffix when license is unknown", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: undefined });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "mystery2", { by: "qcody", cwd: workspace }),
		);
		expect(out).toBe(
			"approved: npm:mystery2 (by qcody)\n" +
				"  note: license: unknown — not recorded; review the package and set it in package-allowlist.json\n",
		);
	});

	it("records the version_range field verbatim on the entry when --version-range is given", async () => {
		await addAllowlistCommand("npm", "ranged-pkg", { by: "x", cwd: workspace, versionRange: "^2.0.0" });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireObject({ "version_range": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(nonNull(parsed.packages.npm["ranged-pkg"]).version_range).toBe("^2.0.0");
	});

	it("does not record a version_range field when --version-range is not given", async () => {
		await addAllowlistCommand("npm", "unranged-pkg", { by: "x", cwd: workspace });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireObject({ "version_range": wireAbsentOptional(wireOptional(wireString)) })) }) }), "test JSON value");
		expect(nonNull(parsed.packages.npm["unranged-pkg"]).version_range).toBeUndefined();
	});

	it("notes when --version-range is not statically resolvable and falls back to latest", async () => {
		// "<2.0.0" is a pure upper bound — resolveScreenVersion returns null.
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "unresolvable-pkg", { by: "x", cwd: workspace, versionRange: "<2.0.0" }),
		);
		expect(out).toMatch(
			/version range "<2\.0\.0" not statically resolvable — screens fall back to the registry latest/,
		);
	});

	it("does NOT push the unresolvable-range note when the range IS resolvable", async () => {
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "resolvable-pkg", { by: "x", cwd: workspace, versionRange: "^1.2.3" }),
		);
		expect(out).not.toMatch(/not statically resolvable/);
	});
});

describe("removeAllowlistCommand", () => {
	it("removes an existing entry", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		removeAllowlistCommand("npm", "lodash", { cwd: workspace });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "packages": wireObject({ "npm": wireRecord(wireUnknown) }) }), "test JSON value");
		expect(parsed.packages.npm.lodash).toBeUndefined();
	});

	it("is a no-op when removing a non-existent entry — does not throw, file unchanged", () => {
		// The implementation may either skip saving (file doesn't exist) or save
		// with the entry absent. Both states satisfy "non-existent entry stays
		// non-existent." Read with a sentinel to give one assertion regardless.
		const before = readAllowlistFile();
		removeAllowlistCommand("npm", "nonexistent", { cwd: workspace });
		const after = readAllowlistFile() ?? { packages: { npm: {} } };
		const npmRecord = (parseWire(after, wireObject({ "packages": wireObject({ "npm": wireRecord(wireUnknown) }) }), "test JSON value"))
			.packages.npm;
		expect(npmRecord.nonexistent).toBeUndefined();
		expect(before).toBeNull();
	});

	it("rejects an unknown ecosystem with the exact message", () => {
		expect(() =>
			removeAllowlistCommand("badeco", "foo", { cwd: workspace }),
		).toThrow(
			'Unknown ecosystem "badeco". Valid: npm, pypi, cargo, rubygems, go, composer, maven, gradle, nuget',
		);
	});

	it("prints exactly 'no entry: ...' and does NOT create the allowlist file when removing a non-existent entry", () => {
		const out = capture(() => removeAllowlistCommand("npm", "nonexistent", { cwd: workspace }));
		expect(out).toBe("no entry: npm:nonexistent\n");
		expect(readAllowlistFile()).toBeNull();
	});

	it("prints the exact 'removed: ...' line on successful removal", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		const out = capture(() => removeAllowlistCommand("npm", "lodash", { cwd: workspace }));
		expect(out).toBe("removed: npm:lodash\n");
	});
});

describe("listAllowlistCommand", () => {
	it("emits empty state when no entries exist", () => {
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/empty|no entries/i);
	});

	it("emits entries grouped by ecosystem, including the recorded license", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		await addAllowlistCommand("pypi", "requests", { by: "y", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/lodash/);
		expect(out).toMatch(/requests/);
		expect(out).toMatch(/npm/);
		expect(out).toMatch(/pypi/);
		expect(out).toMatch(/license MIT/);
	});

	it("prints the exact per-entry line including approver, reason, and license", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "qcody", reason: "util", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toBe("npm:\n  lodash  (by qcody, util, license MIT)\n");
	});

	it("prints the exact per-entry line WITHOUT a reason suffix when no reason was given", async () => {
		await addAllowlistCommand("npm", "noreasonpkg", { by: "qcody", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toBe("npm:\n  noreasonpkg  (by qcody, license MIT)\n");
	});

	it("prints the exact per-entry line WITHOUT a license suffix when license is unknown", async () => {
		fetchRegistryMetadataMock.mockResolvedValue({ latestVersion: "1.0.0", license: undefined });
		await addAllowlistCommand("npm", "nolicensepkg", { by: "qcody", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).toBe("npm:\n  nolicensepkg  (by qcody)\n");
	});

	it("does not print a snapshots section when there are no snapshots", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).not.toMatch(/snapshots:/);
	});

	it("filters to an ecosystem with zero entries and reports the exact empty message", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace, ecosystem: "pypi" }));
		expect(out).toBe("allowlist is empty — no entries approved\n");
	});

	it("prints the snapshots section (not the empty message) when there are snapshots but zero packages (AND boundary)", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		snapshotAllowlistCommand({ cwd: workspace, by: "x" });
		const out = capture(() => listAllowlistCommand({ cwd: workspace }));
		expect(out).not.toMatch(/allowlist is empty/);
		expect(out).toMatch(/^snapshots:\n  package\.json  [0-9a-f]{12}…  \(by x\)\n$/);
	});

	it("supports --json output", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		const out = capture(() => listAllowlistCommand({ cwd: workspace, json: true }));
		const parsed = parseWire(JSON.parse(out), wireObject({ "packages": wireObject({ "npm": wireRecord(wireUnknown) }) }), "test JSON value");
		expect(parsed.packages.npm.lodash).toBeDefined();
	});

	it("filters by ecosystem", async () => {
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		await addAllowlistCommand("pypi", "requests", { by: "y", cwd: workspace });
		const out = capture(() =>
			listAllowlistCommand({ cwd: workspace, ecosystem: "npm" }),
		);
		expect(out).toMatch(/lodash/);
		expect(out).not.toMatch(/requests/);
	});
});

describe("snapshotAllowlistCommand", () => {
	it("snapshots all known manifest + lockfile files in cwd", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		writeFileSync(join(workspace, "package-lock.json"), '{"lockfileVersion":3}');
		snapshotAllowlistCommand({ cwd: workspace, by: "qcody", reason: "initial" });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "lockfile_snapshots": wireRecord(wireObject({ "sha256": wireString, "approved_by": wireString })) }), "test JSON value");
		expect(parsed.lockfile_snapshots["package.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package-lock.json"]).toBeDefined();
		expect(nonNull(parsed.lockfile_snapshots["package-lock.json"]).sha256).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(nonNull(parsed.lockfile_snapshots["package-lock.json"]).approved_by).toBe("qcody");
	});

	it("supports --lockfile to snapshot a specific file only", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		writeFileSync(join(workspace, "package-lock.json"), '{"lockfileVersion":3}');
		snapshotAllowlistCommand({
			cwd: workspace,
			by: "qcody",
			lockfile: "package-lock.json",
		});
		const parsed = parseWire(readAllowlistFile(), wireObject({ "lockfile_snapshots": wireRecord(wireUnknown) }), "test JSON value");
		expect(parsed.lockfile_snapshots["package-lock.json"]).toBeDefined();
		expect(parsed.lockfile_snapshots["package.json"]).toBeUndefined();
	});

	it("is a no-op when no recognised files are present", () => {
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		expect(out).toMatch(/no.*manifest|no.*lockfile|nothing/i);
	});

	it("skips a candidate name that is actually a directory, not a file", () => {
		mkdirSync(join(workspace, "yarn.lock"));
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		const parsed = parseWire(readAllowlistFile(), wireObject({ "lockfile_snapshots": wireRecord(wireUnknown) }), "test JSON value");
		expect(parsed.lockfile_snapshots["yarn.lock"]).toBeUndefined();
		expect(parsed.lockfile_snapshots["package.json"]).toBeDefined();
		expect(out).toBe("snapshotted 1 file(s):\n  package.json\n");
	});

	it("skips a candidate whose statSync call throws instead of aborting the whole snapshot", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		const flaky = join(workspace, "Cargo.toml");
		writeFileSync(flaky, "");
		fsStatFailures.add(flaky);

		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));

		const parsed = parseWire(readAllowlistFile(), wireObject({ "lockfile_snapshots": wireRecord(wireUnknown) }), "test JSON value");
		expect(parsed.lockfile_snapshots["Cargo.toml"]).toBeUndefined();
		expect(parsed.lockfile_snapshots["package.json"]).toBeDefined();
		expect(out).toBe("snapshotted 1 file(s):\n  package.json\n");
	});

	it("auto-discovers and snapshots a variably-named *.csproj", () => {
		writeFileSync(
			join(workspace, "App.csproj"),
			'<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
		);
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		expect(out).toMatch(/snapshotted/);
		expect(out).toMatch(/App\.csproj/);
	});

	it("recursively discovers and snapshots a NESTED *.csproj by relative path", () => {
		mkdirSync(join(workspace, "src", "Lib"), { recursive: true });
		writeFileSync(
			join(workspace, "src", "Lib", "Lib.csproj"),
			'<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
		);
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		expect(out).toMatch(/src\/Lib\/Lib\.csproj/);
	});

	it("records the reason field on a snapshot entry when --reason is given", () => {
		writeFileSync(join(workspace, "package.json"), '{"name":"x"}');
		snapshotAllowlistCommand({ cwd: workspace, by: "x", reason: "bootstrap" });
		const parsed = parseWire(readAllowlistFile(), wireObject({ "lockfile_snapshots": wireRecord(wireObject({ "reason": wireAbsentOptional(wireOptional(wireString)) })) }), "test JSON value");
		expect(nonNull(parsed.lockfile_snapshots["package.json"]).reason).toBe("bootstrap");
	});

	it("only auto-discovers .csproj files, not arbitrary files (extension guard)", () => {
		writeFileSync(join(workspace, "App.csproj"), "<Project></Project>");
		writeFileSync(join(workspace, "random-notes.txt"), "hello");
		const out = capture(() => snapshotAllowlistCommand({ cwd: workspace, by: "x" }));
		const parsed = parseWire(readAllowlistFile(), wireObject({ "lockfile_snapshots": wireRecord(wireUnknown) }), "test JSON value");
		expect(parsed.lockfile_snapshots["App.csproj"]).toBeDefined();
		expect(parsed.lockfile_snapshots["random-notes.txt"]).toBeUndefined();
		expect(out).not.toMatch(/random-notes\.txt/);
	});
});

describe("verifyAllowlistCommand", () => {
	it("reports clean when all manifest deps are allowlisted and snapshot matches", async () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { lodash: "^4.17.21" } }, null, 2),
		);
		await addAllowlistCommand("npm", "lodash", { by: "x", cwd: workspace });
		snapshotAllowlistCommand({ cwd: workspace, by: "x" });
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|ok|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("reports the unapproved deps in manifest", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { evil: "1" } }, null, 2),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil/);
		expect(out).toMatch(/unapproved|missing/i);
	});

	it("sets a non-zero exit code on unapproved deps so CI/scripts can gate", () => {
		// Found 2026-06-11: verify printed findings but always exited 0 —
		// un-gateable by CI, pre-push, or any script. Pin the contract.
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { evil: "1" } }, null, 2),
		);
		capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(process.exitCode).toBe(1);
	});

	it("walks requirements.txt (P2.8)", () => {
		writeFileSync(join(workspace, "requirements.txt"), "evil-py==1.0\n");
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-py/);
	});

	it("walks pyproject.toml (P2.8)", () => {
		writeFileSync(
			join(workspace, "pyproject.toml"),
			`[tool.poetry.dependencies]\npython = "^3.11"\nevil-poetry = "^1"\n`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-poetry/);
	});

	it("walks Cargo.toml (P2.8)", () => {
		writeFileSync(join(workspace, "Cargo.toml"), `[dependencies]\nevil-crate = "1"\n`);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-crate/);
	});

	it("walks Gemfile (P2.8)", () => {
		writeFileSync(join(workspace, "Gemfile"), `gem "evil-gem", "1"\n`);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-gem/);
	});

	it("walks go.mod (P2.8)", () => {
		writeFileSync(
			join(workspace, "go.mod"),
			`module x\ngo 1.21\nrequire github.com/evil/pkg v1.0.0\n`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/github\.com\/evil\/pkg/);
	});

	it("walks composer.json (G2)", () => {
		writeFileSync(
			join(workspace, "composer.json"),
			JSON.stringify({ require: { php: ">=8.1", "evil/pkg": "^1" } }, null, 2),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil\/pkg/);
		expect(out).toMatch(/composer/);
		expect(process.exitCode).toBe(1);
	});

	it("passes when the composer dep is allowlisted (G2)", async () => {
		await addAllowlistCommand("composer", "monolog/monolog", { by: "x", cwd: workspace });
		writeFileSync(
			join(workspace, "composer.json"),
			JSON.stringify({ require: { "monolog/monolog": "^3.0" } }, null, 2),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("walks pom.xml (maven) (G2)", () => {
		writeFileSync(
			join(workspace, "pom.xml"),
			`<project><dependencies><dependency>\n<groupId>com.evil</groupId><artifactId>payload</artifactId><version>1.0.0</version>\n</dependency></dependencies></project>`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:payload/);
		expect(out).toMatch(/maven/);
	});

	it("walks build.gradle (G2)", () => {
		writeFileSync(
			join(workspace, "build.gradle"),
			`dependencies {\n  implementation "com.evil:payload:1.0.0"\n}`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:payload/);
		expect(out).toMatch(/gradle/);
	});

	it("walks build.gradle.kts (G2)", () => {
		writeFileSync(
			join(workspace, "build.gradle.kts"),
			`dependencies {\n  implementation("io.evil:ktor-evil:2.3.7")\n}`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/io\.evil:ktor-evil/);
	});

	it("walks packages.config (nuget) (G2)", () => {
		writeFileSync(
			join(workspace, "packages.config"),
			`<packages>\n  <package id="Evil.Payload" version="1.0.0" />\n</packages>`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/Evil\.Payload/);
		expect(out).toMatch(/nuget/);
	});

	it("passes when the nuget package is allowlisted (G2)", async () => {
		await addAllowlistCommand("nuget", "Serilog", { by: "x", cwd: workspace });
		writeFileSync(
			join(workspace, "packages.config"),
			`<packages>\n  <package id="Serilog" version="3.1.1" />\n</packages>`,
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("libyear screen (screen 4, warn-only, npm-only)", () => {
	const DATES = {
		created: "2019-01-01T00:00:00.000Z",
		modified: "2024-06-01T00:00:00.000Z",
		"0.9.1": "2020-01-01T00:00:00.000Z",
		"3.0.0": "2024-06-01T00:00:00.000Z",
	};

	it("libyearsBehind measures the approved→latest gap and ignores bookkeeping keys", () => {
		const behind = libyearsBehind(DATES, "0.9.1");
		expect(behind?.latestVersion).toBe("3.0.0");
		expect(behind?.years).toBeGreaterThan(4);
	});

	it("libyearsBehind returns null for an unknown version and 0y for the newest", () => {
		expect(libyearsBehind(DATES, "9.9.9")).toBeNull();
		expect(libyearsBehind(DATES, "3.0.0")?.years).toBe(0);
	});

	it("libyearsBehind returns null when the approved version's date is unparseable", () => {
		// The finite-check (line 155) is the ONLY guard here — with the check
		// disabled, execution would fall through to a NaN-years object instead
		// of null.
		expect(libyearsBehind({ "1.0.0": "not-a-date" }, "1.0.0")).toBeNull();
	});

	it("ignores the 'unpublished' bookkeeping key even when it holds the newest timestamp", () => {
		// Mirrors the created/modified case below but for the third bookkeeping
		// key on line 159 — if its string literal is mutated away, "unpublished"
		// would be treated as a real version and wrongly reported as latest.
		const dates = {
			unpublished: "2099-01-01T00:00:00.000Z",
			"1.0.0": "2020-01-01T00:00:00.000Z",
			"2.0.0": "2021-01-01T00:00:00.000Z",
		};
		expect(libyearsBehind(dates, "1.0.0")?.latestVersion).toBe("2.0.0");
	});

	it("ignores 'created'/'modified' bookkeeping keys even when they hold the newest timestamp", () => {
		// If the bookkeeping-key skip on line 159 is disabled for either clause,
		// the loop treats "created" or "modified" as a real version and — since
		// both are dated LATER than every real version here — wrongly reports
		// one of them as latestVersion instead of "2.0.0".
		const dates = {
			created: "2099-01-01T00:00:00.000Z",
			modified: "2098-01-01T00:00:00.000Z",
			"1.0.0": "2020-01-01T00:00:00.000Z",
			"2.0.0": "2021-01-01T00:00:00.000Z",
		};
		expect(libyearsBehind(dates, "1.0.0")?.latestVersion).toBe("2.0.0");
	});

	it("only advances latestVersion for a FINITE, STRICTLY LATER date (guards NaN and earlier/equal entries)", () => {
		// Iteration order: 1.0.0 (self), 2.0.0 (later — should win), 0.5.0
		// (earlier — must NOT win), bad (unparseable — must NOT win). Any of
		// the four line-161 mutants (force-true, && -> ||, sub-condition
		// force-true) makes the LAST entry ("bad", NaN) win instead.
		const dates = {
			"1.0.0": "2020-01-01T00:00:00.000Z",
			"2.0.0": "2021-01-01T00:00:00.000Z",
			"0.5.0": "2019-01-01T00:00:00.000Z",
			bad: "not-a-real-date",
		};
		const behind = libyearsBehind(dates, "1.0.0");
		expect(behind?.latestVersion).toBe("2.0.0");
		expect(Number.isFinite(behind?.years)).toBe(true);
	});

	it("keeps the first-seen version on an exact date tie (guards > vs >=)", () => {
		const dates = {
			"1.0.0": "2020-01-01T00:00:00.000Z",
			"2.0.0": "2021-01-01T00:00:00.000Z",
			"2.0.0-tie": "2021-01-01T00:00:00.000Z",
		};
		expect(libyearsBehind(dates, "1.0.0")?.latestVersion).toBe("2.0.0");
	});

	it("warns on a stale npm pin, still approves, and names the gap", async () => {
		fetchNpmPublishDatesMock.mockResolvedValue(DATES);
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "oldpkg", {
				by: "x",
				cwd: workspace,
				versionRange: "0.9.1",
			}),
		);
		expect(out).toMatch(/libyear/);
		expect(out).toMatch(/years behind/);
		expect(readAllowlistFile()).not.toBeNull(); // warn-only: approval proceeds
	});

	it("stays silent for a fresh pin within the threshold", async () => {
		fetchNpmPublishDatesMock.mockResolvedValue({
			...DATES,
			"2.9.0": "2024-05-01T00:00:00.000Z",
		});
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "freshpkg", { by: "x", cwd: workspace, versionRange: "2.9.0" }),
		);
		expect(out).not.toMatch(/libyear/);
	});

	it("notes the skipped screen when the date fetch fails, and never fires off-npm", async () => {
		fetchNpmPublishDatesMock.mockResolvedValue(null);
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "nofetch", { by: "x", cwd: workspace, versionRange: "0.9.1" }),
		);
		expect(out).toMatch(/libyear screen skipped/);
		fetchNpmPublishDatesMock.mockClear();
		await addAllowlistCommand("cargo", "serde", { by: "x", cwd: workspace, versionRange: "1.0.0" });
		expect(fetchNpmPublishDatesMock).not.toHaveBeenCalled();
	});

	it("does not call the npm publish-date fetch when approving latest (no --version-range)", async () => {
		await addAllowlistCommand("npm", "latestpkg", { by: "x", cwd: workspace });
		expect(fetchNpmPublishDatesMock).not.toHaveBeenCalled();
	});

	it("notes when no publish date is recorded for the pinned version (dates present, version missing)", async () => {
		fetchNpmPublishDatesMock.mockResolvedValue({ "9.9.9": "2024-01-01T00:00:00.000Z" });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "missingdatepkg", { by: "x", cwd: workspace, versionRange: "0.9.1" }),
		);
		expect(out).toMatch(/no publish date recorded for 0\.9\.1 — libyear screen skipped/);
	});

	it("prints the exact libyear warning note text (full message, not a substring)", async () => {
		fetchVersionMetadataMock.mockResolvedValue({ license: "MIT" });
		const approvedIso = "2020-01-01T00:00:00.000Z";
		const approvedMs = Date.parse(approvedIso);
		const latestIso = new Date(approvedMs + 3 * 365.25 * 24 * 60 * 60 * 1000).toISOString();
		fetchNpmPublishDatesMock.mockResolvedValue({ "0.9.1": approvedIso, "9.9.9": latestIso });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "stalepkg", { by: "x", cwd: workspace, versionRange: "0.9.1" }),
		);
		expect(out).toBe(
			"approved: npm:stalepkg (by x) — license MIT\n" +
				'  note: screens inspected pinned 0.9.1 (resolved from "0.9.1")\n' +
				"  note: libyear: pinned 0.9.1 is 3.0 years behind latest 9.9.9 (warn threshold 2y) — stale pins " +
				"miss upstream fixes; consider approving a newer release.\n",
		);
	});
});

describe("libyear screen — exact threshold boundary (<=LIBYEAR_WARN_YEARS)", () => {
	const approvedIso = "2020-01-01T00:00:00.000Z";
	const approvedMs = Date.parse(approvedIso);
	const twoYearsMs = 2 * 365.25 * 24 * 60 * 60 * 1000;

	it("does not warn when the gap is exactly 2.0 years (boundary is inclusive)", async () => {
		const latestIso = new Date(approvedMs + twoYearsMs).toISOString();
		fetchNpmPublishDatesMock.mockResolvedValue({ "0.9.1": approvedIso, "9.9.9": latestIso });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "boundarypkg", { by: "x", cwd: workspace, versionRange: "0.9.1" }),
		);
		expect(out).not.toMatch(/libyear/);
	});

	it("warns when the gap is 2.0 years plus 1ms (just past the boundary)", async () => {
		const latestIso = new Date(approvedMs + twoYearsMs + 1).toISOString();
		fetchNpmPublishDatesMock.mockResolvedValue({ "0.9.1": approvedIso, "9.9.9": latestIso });
		const out = await captureAsync(() =>
			addAllowlistCommand("npm", "overpkg", { by: "x", cwd: workspace, versionRange: "0.9.1" }),
		);
		expect(out).toMatch(/libyear: pinned 0\.9\.1 is 2\.0 years behind latest 9\.9\.9/);
	});
});
