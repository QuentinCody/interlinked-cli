// Direct pins for the STRICT manifest reader (the composed suite lives in
// installer.test.ts; these cover the binding logic at its own seam).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManifestState } from "./installer-manifest.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "il-manifest-"));
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function mfPath(): string {
	return join(tmp, ".interlinked", "installer-manifest.json");
}

function entry(overrides: object = {}): object {
	return {
		runner: "gemini-cli",
		scope: "project",
		settings_path: join(tmp, ".gemini", "settings.json"),
		added_paths: ["hooks.BeforeTool[0]"],
		binary_path: "/b.js",
		installed_at: "2026-08-30T00:00:00.000Z",
		...overrides,
	};
}

describe("readManifestState — adapter/path binding (review 2026-08-30)", () => {
	it("refuses an invalid post-install status instead of presenting it as successful", () => {
		writeFileSync(mfPath(), JSON.stringify({ schema_version: "1", entries: [entry({ post_install: "skipped" })] }));
		expect(readManifestState(mfPath())).toMatchObject({ kind: "corrupt", reason: 'entry[0] has invalid post_install "skipped"' });
	});

	// test-contract: public-api — an adapter-consistent entry is valid.
	it("P1: an entry whose settings_path matches the adapter derivation is valid", () => {
		writeFileSync(mfPath(), JSON.stringify({ schema_version: "1", entries: [entry()] }));
		expect(readManifestState(mfPath()).kind).toBe("valid");
	});

	// test-contract: security — the reviewer's repro: a Gemini entry pointing
	// at /tmp/not-gemini-settings.json was accepted; install/uninstall then
	// trusted it. The stored path must equal the adapter-derived one.
	it("N1: an arbitrary settings_path corrupts the manifest", () => {
		writeFileSync(
			mfPath(),
			JSON.stringify({
				schema_version: "1",
				entries: [entry({ settings_path: "/tmp/not-gemini-settings.json" })],
			}),
		);
		const state = readManifestState(mfPath());
		expect(state).toMatchObject({ kind: "corrupt" });
		expect(state).toHaveProperty("reason", expect.stringContaining("adapter-derived"));
	});

	// test-contract: security — prototype-chain segments in added_paths
	// corrupt the manifest at parse time.
	it("N2: a __proto__ added_paths segment corrupts the manifest", () => {
		writeFileSync(
			mfPath(),
			JSON.stringify({
				schema_version: "1",
				entries: [entry({ added_paths: ["__proto__.toString"] })],
			}),
		);
		const state = readManifestState(mfPath());
		expect(state).toMatchObject({ kind: "corrupt" });
		expect(state).toHaveProperty("reason", expect.stringContaining("forbidden"));
	});

	// test-contract: invariant — one entry per RUNNER, whatever the scopes:
	// multi-scope installs of one runner are not a supported design.
	it("N3: the same runner at two scopes corrupts the manifest", () => {
		const userEntry = entry({
			scope: "user",
			settings_path: join(process.env.HOME ?? "", ".gemini", "settings.json"),
		});
		writeFileSync(
			mfPath(),
			JSON.stringify({ schema_version: "1", entries: [entry(), userEntry] }),
		);
		const state = readManifestState(mfPath());
		expect(state).toMatchObject({ kind: "corrupt" });
		expect(state).toHaveProperty("reason", expect.stringContaining("duplicate"));
	});

	// test-contract: invariant — an empty binary_path is invalid (the binding
	// and stale detection both key off it).
	it("N4: an empty binary_path corrupts the manifest", () => {
		writeFileSync(
			mfPath(),
			JSON.stringify({ schema_version: "1", entries: [entry({ binary_path: "" })] }),
		);
		expect(readManifestState(mfPath())).toMatchObject({ kind: "corrupt" });
	});

	// test-contract: invariant — artifact_kind, when present, must be one of
	// the two recognized kinds.
	it("N5: an unrecognized artifact_kind corrupts the manifest", () => {
		writeFileSync(
			mfPath(),
			JSON.stringify({
				schema_version: "1",
				entries: [entry({ artifact_kind: "shell-script" })],
			}),
		);
		const state = readManifestState(mfPath());
		expect(state).toMatchObject({ kind: "corrupt" });
		expect(state).toHaveProperty("reason", expect.stringContaining('invalid artifact_kind "shell-script"'));
	});

	// test-contract: invariant — artifact_sha256, when present, must be a
	// 64-hex-char digest (not merely a non-empty string).
	it("N6: a malformed artifact_sha256 corrupts the manifest", () => {
		writeFileSync(
			mfPath(),
			JSON.stringify({
				schema_version: "1",
				entries: [entry({ artifact_sha256: "not-a-real-digest" })],
			}),
		);
		const state = readManifestState(mfPath());
		expect(state).toMatchObject({ kind: "corrupt" });
		expect(state).toHaveProperty("reason", expect.stringContaining("invalid artifact_sha256"));
	});

	// test-contract: invariant — added_paths must be an array of strings; a
	// numeric element is a different failure than the forbidden-segment case
	// N2 already covers.
	it("N7: a non-string added_paths element corrupts the manifest", () => {
		writeFileSync(
			mfPath(),
			JSON.stringify({
				schema_version: "1",
				entries: [entry({ added_paths: [42] })],
			}),
		);
		const state = readManifestState(mfPath());
		expect(state).toMatchObject({ kind: "corrupt" });
		expect(state).toHaveProperty("reason", expect.stringContaining("non-string added_paths array"));
	});
});
