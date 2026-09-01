import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	type Allowlist,
	addToAllowlist,
	allowlistPath,
	hashLockfile,
	isPackageAllowed,
	loadAllowlist,
	matchSnapshot,
	saveAllowlist,
} from "./package-allowlist.js";
import type { PackageSpec } from "./package-install-parser.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "allowlist-test-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe("allowlistPath", () => {
	it("resolves to .interlinked/package-allowlist.json under cwd", () => {
		expect(allowlistPath(workspace)).toBe(
			join(workspace, ".interlinked", "package-allowlist.json"),
		);
	});
});

describe("loadAllowlist", () => {
	it("returns an empty allowlist when the file does not exist", () => {
		const al = loadAllowlist(workspace);
		expect(al.version).toBe(1);
		expect(al.packages.npm).toEqual({});
		expect(al.packages.pypi).toEqual({});
		expect(al.packages.cargo).toEqual({});
		expect(al.packages.rubygems).toEqual({});
		expect(al.packages.go).toEqual({});
		expect(al.lockfile_snapshots).toEqual({});
	});

	it("treats malformed JSON as empty (fail-safe but does not throw)", () => {
		const target = allowlistPath(workspace);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "{not json");
		const al = loadAllowlist(workspace);
		expect(al.version).toBe(1);
		expect(al.packages.npm).toEqual({});
	});

	it("keeps the default empty lockfile_snapshots when the field is absent from valid JSON", () => {
		const target = allowlistPath(workspace);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify({ version: 1, packages: { npm: { lodash: { approved_at: "x", approved_by: "y" } } } }));
		const al = loadAllowlist(workspace);
		expect(al.lockfile_snapshots).toEqual({});
		expect(al.packages.npm.lodash).toBeDefined();
	});

	it("P1: keeps a fully-populated entry, including the optional reason/version_range/license fields", () => {
		const target = allowlistPath(workspace);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(
			target,
			JSON.stringify({
				version: 1,
				packages: {
					npm: {
						wrangler: {
							approved_at: "2026-06-27T22:48:29.109Z",
							approved_by: "qcody",
							reason: "cloud worker",
							version_range: "^4.0.0",
							license: "MIT OR Apache-2.0",
						},
					},
				},
				lockfile_snapshots: {
					"package-lock.json": {
						sha256: "a".repeat(64),
						approved_at: "2026-08-02",
						approved_by: "qcody",
						reason: "routine snapshot",
					},
				},
			}),
		);
		const al = loadAllowlist(workspace);
		expect(al.packages.npm.wrangler).toEqual({
			approved_at: "2026-06-27T22:48:29.109Z",
			approved_by: "qcody",
			reason: "cloud worker",
			version_range: "^4.0.0",
			license: "MIT OR Apache-2.0",
		});
		expect(al.lockfile_snapshots["package-lock.json"]).toEqual({
			sha256: "a".repeat(64),
			approved_at: "2026-08-02",
			approved_by: "qcody",
			reason: "routine snapshot",
		});
	});

	it("N1: drops a package entry missing a required field (approved_by) rather than admitting a half-formed grant", () => {
		const target = allowlistPath(workspace);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(
			target,
			JSON.stringify({
				version: 1,
				packages: { npm: { evil: { approved_at: "2026-06-27" } } },
			}),
		);
		const al = loadAllowlist(workspace);
		expect(al.packages.npm.evil).toBeUndefined();
		expect(
			isPackageAllowed(al, "npm", { kind: "registry", name: "evil" }).allowed,
		).toBe(false);
	});

	it("N2: coerces a wrong-typed version_range to absent instead of letting it reach matchesVersionRange", () => {
		// Before this fix, a non-string version_range (e.g. a JSON number,
		// possible via hand-edits to the committed allowlist) survived the
		// blind copy and reached `matchesVersionRange`, whose `range.trim()`
		// throws on anything but a string at runtime — despite AllowlistEntry's
		// compile-time `version_range?: string`. The malformed field must be
		// coerced to absent (the documented "no pin ⇒ any version" contract),
		// not crash the install-time gate.
		const target = allowlistPath(workspace);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(
			target,
			JSON.stringify({
				version: 1,
				packages: {
					npm: {
						pkg: { approved_at: "2026-06-27", approved_by: "x", version_range: 42 },
					},
				},
			}),
		);
		const al = loadAllowlist(workspace);
		expect(al.packages.npm.pkg).toEqual({ approved_at: "2026-06-27", approved_by: "x" });
		const spec: PackageSpec = { kind: "registry", name: "pkg", version: "1.2.3" };
		expect(() => isPackageAllowed(al, "npm", spec)).not.toThrow();
		expect(isPackageAllowed(al, "npm", spec).allowed).toBe(true);
	});

	it("N3: ignores an ecosystem block that is a JSON array instead of a keyed object", () => {
		const target = allowlistPath(workspace);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify({ version: 1, packages: { npm: ["not", "an", "object"] } }));
		const al = loadAllowlist(workspace);
		expect(al.packages.npm).toEqual({});
	});

	it("N4: drops a lockfile snapshot missing its sha256 rather than letting matchSnapshot compare against undefined", () => {
		const target = allowlistPath(workspace);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(
			target,
			JSON.stringify({
				version: 1,
				lockfile_snapshots: {
					"package-lock.json": { approved_at: "2026-08-02", approved_by: "qcody" },
				},
			}),
		);
		const al = loadAllowlist(workspace);
		expect(al.lockfile_snapshots["package-lock.json"]).toBeUndefined();
	});
});

describe("saveAllowlist + loadAllowlist roundtrip", () => {
	it("persists entries and reads them back", () => {
		const al: Allowlist = {
			version: 1,
			packages: {
				npm: {
					lodash: {
						approved_at: "2026-05-19T00:00:00Z",
						approved_by: "qcody",
						reason: "utility",
					},
				},
				pypi: {},
				cargo: {},
				rubygems: {},
				go: {},
				composer: {},
				maven: {},
				gradle: {},
				nuget: {},
			},
			lockfile_snapshots: {},
		};
		saveAllowlist(workspace, al);
		const loaded = loadAllowlist(workspace);
		expect(nonNull(loaded.packages.npm.lodash).approved_by).toBe("qcody");
	});
});

describe("addToAllowlist", () => {
	it("adds a new entry and persists it", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "qcody", reason: "util" });
		const loaded = loadAllowlist(workspace);
		expect(loaded.packages.npm.lodash).toBeDefined();
		expect(nonNull(loaded.packages.npm.lodash).approved_by).toBe("qcody");
		expect(nonNull(loaded.packages.npm.lodash).approved_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
	});

	it("is idempotent — re-adding overwrites with new approval metadata", () => {
		addToAllowlist(workspace, "npm", "foo", { approved_by: "a" });
		addToAllowlist(workspace, "npm", "foo", { approved_by: "b", reason: "v2" });
		const loaded = loadAllowlist(workspace);
		expect(nonNull(loaded.packages.npm.foo).approved_by).toBe("b");
		expect(nonNull(loaded.packages.npm.foo).reason).toBe("v2");
	});
});

describe("isPackageAllowed", () => {
	const empty: Allowlist = {
		version: 1,
		packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {}, composer: {}, maven: {}, gradle: {}, nuget: {} },
		lockfile_snapshots: {},
	};

	it("rejects unknown registry package", () => {
		const spec: PackageSpec = { kind: "registry", name: "lodash" };
		expect(isPackageAllowed(empty, "npm", spec).allowed).toBe(false);
	});

	it("accepts a registry package on the allowlist", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { lodash: { approved_at: "2026-05-19", approved_by: "qcody" } },
			},
		};
		const spec: PackageSpec = { kind: "registry", name: "lodash" };
		expect(isPackageAllowed(al, "npm", spec).allowed).toBe(true);
	});

	it("rejects git_url unconditionally", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { foo: { approved_at: "2026-05-19", approved_by: "x" } },
			},
		};
		const spec: PackageSpec = { kind: "git_url", url: "git+https://github.com/foo/bar" };
		const result = isPackageAllowed(al, "npm", spec);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/git/i);
	});

	it("rejects tarball_url unconditionally", () => {
		const spec: PackageSpec = { kind: "tarball_url", url: "https://x.com/p.tgz" };
		const r = isPackageAllowed(empty, "npm", spec);
		expect(r.allowed).toBe(false);
		expect(r.reason).toMatch(/tarball|url/i);
	});

	it("allows local_path (treated as workspace code, not registry)", () => {
		const spec: PackageSpec = { kind: "local_path", path: "./internal" };
		expect(isPackageAllowed(empty, "npm", spec).allowed).toBe(true);
	});

	it("enforces version_range when set on the entry (P2.6) — exact match passes", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: {
					lodash: {
						approved_at: "2026-05-19",
						approved_by: "x",
						version_range: "4.17.21",
					},
				},
			},
		};
		expect(
			isPackageAllowed(al, "npm", { kind: "registry", name: "lodash", version: "4.17.21" })
				.allowed,
		).toBe(true);
	});

	it("enforces version_range — mismatch blocks (P2.6)", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: {
					lodash: {
						approved_at: "2026-05-19",
						approved_by: "x",
						version_range: "4.17.21",
					},
				},
			},
		};
		const r = isPackageAllowed(al, "npm", {
			kind: "registry",
			name: "lodash",
			version: "99.0.0",
		});
		expect(r.allowed).toBe(false);
		expect(r.reason).toMatch(/version|4\.17\.21|99/i);
	});

	it("no version_range stored ⇒ any spec.version is fine (P2.6)", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { lodash: { approved_at: "2026-05-19", approved_by: "x" } },
			},
		};
		expect(
			isPackageAllowed(al, "npm", { kind: "registry", name: "lodash", version: "99.0.0" })
				.allowed,
		).toBe(true);
	});

	it("version_range set but spec carries no version ⇒ blocked (P2.6)", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: {
					lodash: {
						approved_at: "2026-05-19",
						approved_by: "x",
						version_range: "4.17.21",
					},
				},
			},
		};
		const r = isPackageAllowed(al, "npm", { kind: "registry", name: "lodash" });
		expect(r.allowed).toBe(false);
		expect(r.reason).toMatch(/version|range/i);
	});

	it("matches a prefixed exact version (v-prefix vs bare) after stripping the prefix", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: {
					lodash: { approved_at: "2026-05-19", approved_by: "x", version_range: "=4.17.21" },
				},
			},
		};
		const r = isPackageAllowed(al, "npm", { kind: "registry", name: "lodash", version: "4.17.21" });
		expect(r.allowed).toBe(true);
	});

	it("caret range (^4.0.0) allows a same-major version", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { pkg: { approved_at: "2026-05-19", approved_by: "x", version_range: "^4.0.0" } },
			},
		};
		const r = isPackageAllowed(al, "npm", { kind: "registry", name: "pkg", version: "4.5.2" });
		expect(r.allowed).toBe(true);
	});

	it("caret range (^4.0.0) rejects a different-major version", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { pkg: { approved_at: "2026-05-19", approved_by: "x", version_range: "^4.0.0" } },
			},
		};
		const r = isPackageAllowed(al, "npm", { kind: "registry", name: "pkg", version: "5.0.0" });
		expect(r.allowed).toBe(false);
	});

	it("tilde range (~4.2.0) allows a same major.minor version", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { pkg: { approved_at: "2026-05-19", approved_by: "x", version_range: "~4.2.0" } },
			},
		};
		const r = isPackageAllowed(al, "npm", { kind: "registry", name: "pkg", version: "4.2.9" });
		expect(r.allowed).toBe(true);
	});

	it("tilde range (~4.2.0) rejects a different minor version", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { pkg: { approved_at: "2026-05-19", approved_by: "x", version_range: "~4.2.0" } },
			},
		};
		const r = isPackageAllowed(al, "npm", { kind: "registry", name: "pkg", version: "4.3.0" });
		expect(r.allowed).toBe(false);
	});

	it("is case-sensitive on package name (npm rejects 'LoDash' when 'lodash' is allowed)", () => {
		const al: Allowlist = {
			...empty,
			packages: {
				...empty.packages,
				npm: { lodash: { approved_at: "2026-05-19", approved_by: "x" } },
			},
		};
		const r = isPackageAllowed(al, "npm", { kind: "registry", name: "LoDash" });
		expect(r.allowed).toBe(false);
	});
});

describe("hashLockfile + matchSnapshot", () => {
	it("produces a stable hash for the same content", () => {
		const file = join(workspace, "package-lock.json");
		writeFileSync(file, JSON.stringify({ a: 1, b: [1, 2, 3] }));
		const h1 = hashLockfile(file);
		const h2 = hashLockfile(file);
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^[a-f0-9]{64}$/);
	});

	it("returns null when the lockfile does not exist", () => {
		expect(hashLockfile(join(workspace, "missing.json"))).toBeNull();
	});

	it("matchSnapshot returns true when the file hash matches the stored snapshot", () => {
		const file = join(workspace, "package-lock.json");
		writeFileSync(file, "lockcontent");
		const hash = hashLockfile(file);
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {}, composer: {}, maven: {}, gradle: {}, nuget: {} },
			lockfile_snapshots: {
				"package-lock.json": { sha256: hash!, approved_at: "2026-05-19", approved_by: "x" },
			},
		};
		expect(matchSnapshot(al, "package-lock.json", file)).toBe(true);
	});

	it("matchSnapshot returns false on hash mismatch", () => {
		const file = join(workspace, "package-lock.json");
		writeFileSync(file, "newcontent");
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {}, composer: {}, maven: {}, gradle: {}, nuget: {} },
			lockfile_snapshots: {
				"package-lock.json": {
					sha256: "0".repeat(64),
					approved_at: "2026-05-19",
					approved_by: "x",
				},
			},
		};
		expect(matchSnapshot(al, "package-lock.json", file)).toBe(false);
	});

	it("matchSnapshot returns false when no snapshot exists for that lockfile", () => {
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {}, composer: {}, maven: {}, gradle: {}, nuget: {} },
			lockfile_snapshots: {},
		};
		expect(
			matchSnapshot(al, "package-lock.json", join(workspace, "package-lock.json")),
		).toBe(false);
	});

	it("matchSnapshot returns false when a snapshot is recorded but the lockfile no longer exists", () => {
		const al: Allowlist = {
			version: 1,
			packages: { npm: {}, pypi: {}, cargo: {}, rubygems: {}, go: {}, composer: {}, maven: {}, gradle: {}, nuget: {} },
			lockfile_snapshots: {
				"package-lock.json": { sha256: "0".repeat(64), approved_at: "2026-05-19", approved_by: "x" },
			},
		};
		expect(
			matchSnapshot(al, "package-lock.json", join(workspace, "does-not-exist.json")),
		).toBe(false);
	});

	it("hashLockfile returns null (fails soft) when the path is a directory, not a file", () => {
		const dirPath = join(workspace, "a-directory");
		mkdirSync(dirPath, { recursive: true });
		expect(hashLockfile(dirPath)).toBeNull();
	});
});
