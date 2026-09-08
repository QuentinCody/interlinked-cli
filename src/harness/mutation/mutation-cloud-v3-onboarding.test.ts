import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activateMutationCloudOnboarding,
	type MutationCloudV3OnboardingDependencies,
} from "./mutation-cloud-v3-onboarding.js";
import {
	MUTATION_ONBOARDING_ARCHIVE_PREFIX,
	MUTATION_ONBOARDING_SOURCE_FORMAT,
	type CapturedMutationOnboardingSource,
} from "./mutation-cloud-v3-onboarding-source.js";
import { MutationCloudV3Submitter } from "./mutation-cloud-v3-submission.js";
import { openMutationJournal } from "./mutation-journal-sqlite.js";
import type { MutationJournal } from "./mutation-journal-types.js";
import { PROTOCOL_V3_CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";

const REPOSITORY = "acme/widgets";
const TARGET_FILE = "src/foo.ts";

function mkCaptured(
	over: Partial<CapturedMutationOnboardingSource> = {},
): CapturedMutationOnboardingSource {
	const targetBytes = new Uint8Array([1, 2, 3]);
	const sourceArtifactBytes = new Uint8Array([4, 5, 6]);
	const sourceArtifactSha256 = createHash("sha256").update(sourceArtifactBytes).digest("hex");
	return {
		format: MUTATION_ONBOARDING_SOURCE_FORMAT,
		archivePrefix: MUTATION_ONBOARDING_ARCHIVE_PREFIX,
		repository: REPOSITORY,
		commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		targetFile: TARGET_FILE,
		targetBytes,
		targetSha256: createHash("sha256").update(targetBytes).digest("hex"),
		sourceArtifactId: `src_git_archive_v1_${sourceArtifactSha256}`,
		sourceArtifactBytes,
		sourceArtifactSha256,
		scopeMode: "glob_fallback",
		testFiles: [],
		...over,
	};
}

let root: string;
let journal: MutationJournal;
const submitter = new MutationCloudV3Submitter({
	baseUrl: "https://mutation.example.test",
	token: "test-token",
	projectRef: "p1",
	repository: REPOSITORY,
	timeoutMs: 1000,
	contractDigest: PROTOCOL_V3_CONTRACT_DIGEST,
	keyRegistry: {},
	serverAuthority: { tenant: "t1", project: "p1" },
}, async () => {
	throw new Error("Unexpected network request during onboarding identity validation");
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-onboarding-identity-"));
	journal = openMutationJournal(root);
});

afterEach(() => {
	journal.close();
	rmSync(root, { recursive: true, force: true });
});

function activate(
	captured: CapturedMutationOnboardingSource,
	dependencies: MutationCloudV3OnboardingDependencies = {},
) {
	return activateMutationCloudOnboarding(
		{
			root,
			targetFile: TARGET_FILE,
			repository: REPOSITORY,
			tenant: "t1",
			project: "p1",
			journal,
			submitter,
			clockMs: () => 0,
		},
		{ captureSource: () => captured, ...dependencies },
	);
}

describe("activateMutationCloudOnboarding identity guards — positive (must throw)", () => {
	it("P1: rejects a captured source whose repository disagrees with the caller's", async () => {
		await expect(
			activate(mkCaptured({ repository: "someone-else/other-repo" })),
		).rejects.toThrow("mutation onboarding captured a foreign repository identity");
	});

	it("P2: rejects a captured source whose target file disagrees with the caller's", async () => {
		await expect(
			activate(mkCaptured({ targetFile: "src/other.ts" })),
		).rejects.toThrow("mutation onboarding captured a foreign target");
	});

	it("P3: rejects a captured source whose artifact id does not derive from its own sha256", async () => {
		await expect(
			activate(mkCaptured({ sourceArtifactId: "src_git_archive_v1_a-different-sha" })),
		).rejects.toThrow("mutation onboarding captured a foreign source artifact identity");
	});

	it("P4: rejects job-key minting when the injected randomness is the wrong length", async () => {
		await expect(
			activate(mkCaptured(), { randomBytes: () => new Uint8Array(16) }),
		).rejects.toThrow("mutation onboarding randomness must return exactly 32 bytes");
	});

	it("P5: falls back to the real capture function when no captureSource is injected", async () => {
		await expect(
			activateMutationCloudOnboarding({
				root,
				targetFile: TARGET_FILE,
				repository: "",
				tenant: "t1",
				project: "p1",
				journal,
				submitter,
				clockMs: () => 0,
			}),
		).rejects.toThrow("mutation onboarding repository must be a non-empty string");
	});
});
