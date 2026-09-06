// ===========================================
// Software version freshness helpers — unit tests
// ===========================================
// Covers the two branches of `freshnessConcernForRef` not already exercised
// through the parent detector's own suite: the deprecated/legacy wording
// branch and the api_version-kind branch, each of which routes to its own
// verification-hint template inside the unexported `verificationHintForRef`
// helper.

import { describe, expect, it } from "vitest";
import type { SoftwareVersionReference } from "./software-version-regression.js";
import { freshnessConcernForRef, referenceIdentity } from "./software-version-regression-freshness.js";

function ref(overrides: Partial<SoftwareVersionReference>): SoftwareVersionReference {
	return {
		anchor: "generic:pkg",
		label: "pkg",
		kind: "generic",
		version: "1.0.0",
		line: 1,
		text: "pkg 1.0.0",
		...overrides,
	};
}

describe("freshnessConcernForRef", () => {
	it("flags legacy/deprecated wording with the deprecation verification hint", () => {
		const concern = freshnessConcernForRef(
			ref({ text: "uses the deprecated widget API", version: "2.0.0" }),
		);
		expect(concern?.reason).toBe(
			"legacy/deprecated wording around a software reference should be verified",
		);
		expect(concern?.verifyHint).toEqual({
			source: "official migration, release-note, or deprecation documentation",
			instruction:
				"Confirm whether the referenced software is actually legacy/deprecated before writing that claim.",
		});
	});

	it("flags an api_version reference with the API-docs verification hint", () => {
		const concern = freshnessConcernForRef(
			ref({ kind: "api_version", label: "api-version", version: "2026-01-01", text: "2026-01-01" }),
		);
		expect(concern?.reason).toBe(
			"API version/date pins are freshness-sensitive; verify the intended provider version",
		);
		expect(concern?.verifyHint).toEqual({
			source: "official API versioning docs for the provider that owns this endpoint or SDK",
			instruction:
				"Confirm the intended API date/version from provider documentation before introducing the pin.",
		});
	});

	it("returns undefined for a plain generic reference with no freshness concern", () => {
		expect(freshnessConcernForRef(ref({}))).toBeUndefined();
	});
});

describe("referenceIdentity", () => {
	it("strips the @<objectPath> suffix so unchanged content keeps a stable identity", () => {
		const withPath = ref({ anchor: "package:lodash@dependencies.lodash", version: "4.17.21" });
		const withoutPath = ref({ anchor: "package:lodash", version: "4.17.21" });
		expect(referenceIdentity(withPath)).toBe(referenceIdentity(withoutPath));
	});
});
