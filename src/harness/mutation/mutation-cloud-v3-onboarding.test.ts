// Evidence for `activateMutationCloudOnboarding`'s identity guards and
// job-key minting: the four uncovered tails are all throw-on-mismatch /
// throw-on-malformed-input branches, reached through the injectable
// `captureSource` and `randomBytes` dependencies rather than any real git
// or crypto call.

import { describe, expect, it } from "vitest";
import {
	activateMutationCloudOnboarding,
	type MutationCloudV3OnboardingDependencies,
} from "./mutation-cloud-v3-onboarding.js";
import {
	MUTATION_ONBOARDING_ARCHIVE_PREFIX,
	MUTATION_ONBOARDING_SOURCE_FORMAT,
	type CapturedMutationOnboardingSource,
} from "./mutation-cloud-v3-onboarding-source.js";
import type { MutationCloudV3Submitter } from "./mutation-cloud-v3-submission.js";
import type { MutationJournal } from "./mutation-journal-types.js";

const REPOSITORY = "acme/widgets";
const TARGET_FILE = "src/foo.ts";

function mkCaptured(
	over: Partial<CapturedMutationOnboardingSource> = {},
): CapturedMutationOnboardingSource {
	return {
		format: MUTATION_ONBOARDING_SOURCE_FORMAT,
		archivePrefix: MUTATION_ONBOARDING_ARCHIVE_PREFIX,
		repository: REPOSITORY,
		commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		targetFile: TARGET_FILE,
		targetBytes: new Uint8Array([1, 2, 3]),
		targetSha256: "target-sha",
		sourceArtifactId: "src_git_archive_v1_source-sha",
		sourceArtifactBytes: new Uint8Array([4, 5, 6]),
		sourceArtifactSha256: "source-sha",
		scopeMode: "glob_fallback",
		testFiles: [],
		...over,
	};
}

// SAFETY: every case below throws inside `assertCapturedIdentity` or
// `mintJobKey`, both of which run before `input.journal`/`input.submitter`
// are ever touched — a full implementation is unreachable and unnecessary.
const UNUSED_JOURNAL = { getOnboardingIntent: () => null } as unknown as MutationJournal;
// SAFETY: same as above — `input.submitter.authenticatePrepared` is never called.
const UNUSED_SUBMITTER = {} as unknown as MutationCloudV3Submitter;

function activate(
	captured: CapturedMutationOnboardingSource,
	dependencies: MutationCloudV3OnboardingDependencies = {},
) {
	return activateMutationCloudOnboarding(
		{
			root: "/repo",
			targetFile: TARGET_FILE,
			repository: REPOSITORY,
			tenant: "t1",
			project: "p1",
			journal: UNUSED_JOURNAL,
			submitter: UNUSED_SUBMITTER,
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
		// SAFETY: omitting `dependencies.captureSource` exercises the module's
		// own default (`(args) => captureMutationOnboardingSource(args)`)
		// instead of a test double. An empty `repository` fails the real
		// function's own input validation before any git or filesystem call,
		// so this needs no repo fixture — the literal message it throws is
		// only reachable through that real function, not through our stub.
		await expect(
			activateMutationCloudOnboarding({
				root: "/repo",
				targetFile: TARGET_FILE,
				repository: "",
				tenant: "t1",
				project: "p1",
				journal: UNUSED_JOURNAL,
				submitter: UNUSED_SUBMITTER,
				clockMs: () => 0,
			}),
		).rejects.toThrow("mutation onboarding repository must be a non-empty string");
	});
});
