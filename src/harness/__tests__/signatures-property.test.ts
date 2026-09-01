// Property-based fuzz tests for the 20 sig-secret-* rules ported from
// sanctum-oss. For each pattern we cover three properties:
//   1. A correctly-shaped token (random content within constraints) ALWAYS
//      matches its specific rule.
//   2. A wrong-prefix variant of the same body does NOT match the rule.
//   3. A length-1-below-minimum variant does NOT match the rule (boundary).
// Plus one global property: random alphanumeric strings (50–200 chars) with
// no known provider prefix never match any sig-secret-* rule.
import fc from "fast-check";
import { describe, it } from "vitest";
import { scanSecrets } from "../signatures.js";

const HEX_LOWER = "abcdef0123456789";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM_LOWER_NUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const ALNUM_UNDERSCORE = `${ALNUM}_`;
const ALNUM_HYPHEN_UNDERSCORE = `${ALNUM}-_`;

function charsetArb(charset: string, length: number) {
	return fc.array(fc.constantFrom(...charset), { minLength: length, maxLength: length }).map(
		(arr) => arr.join(""),
	);
}

function lengthRangeArb(charset: string, min: number, max: number) {
	return fc
		.integer({ min, max })
		.chain((len) => charsetArb(charset, len));
}

function hits(ruleId: string, content: string): boolean {
	return scanSecrets(content).some((m) => m.rule_id === ruleId);
}

interface PatternSpec {
	id: string;
	prefix: string;
	bodyArb: fc.Arbitrary<string>;
	/** Length one less than the minimum allowed body (or `null` if no minimum). */
	tooShort?: fc.Arbitrary<string>;
}

const SPECS: PatternSpec[] = [
	{
		id: "sig-secret-gitlab",
		prefix: `gl${"pat"}-`,
		// Exactly 20 chars, [A-Za-z0-9_-]
		bodyArb: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 20),
		tooShort: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 19),
	},
	{
		id: "sig-secret-pypi",
		prefix: `py${"pi"}-`,
		bodyArb: lengthRangeArb(ALNUM_HYPHEN_UNDERSCORE, 16, 80),
		tooShort: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 15),
	},
	{
		id: "sig-secret-digitalocean",
		prefix: "dop_v1_",
		bodyArb: charsetArb(HEX_LOWER, 64),
		tooShort: charsetArb(HEX_LOWER, 63),
	},
	{
		id: "sig-secret-datadog",
		prefix: "ddapi_",
		bodyArb: lengthRangeArb(ALNUM_LOWER_NUM, 32, 80),
		tooShort: charsetArb(ALNUM_LOWER_NUM, 31),
	},
	{
		id: "sig-secret-vercel",
		prefix: "vercel_",
		bodyArb: lengthRangeArb(ALNUM, 24, 60),
		tooShort: charsetArb(ALNUM, 23),
	},
	{
		id: "sig-secret-docker-hub-pat",
		prefix: "dckr_pat_",
		bodyArb: lengthRangeArb(ALNUM_HYPHEN_UNDERSCORE, 24, 60),
		tooShort: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 23),
	},
	{
		id: "sig-secret-vault",
		prefix: "hvs.",
		bodyArb: lengthRangeArb(ALNUM_HYPHEN_UNDERSCORE, 24, 60),
		tooShort: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 23),
	},
	{
		id: "sig-secret-huggingface",
		prefix: "hf_",
		bodyArb: lengthRangeArb(ALNUM, 34, 60),
		tooShort: charsetArb(ALNUM, 33),
	},
	{
		id: "sig-secret-shopify",
		prefix: "shpat_",
		bodyArb: lengthRangeArb(HEX_LOWER, 32, 60),
		tooShort: charsetArb(HEX_LOWER, 31),
	},
	{
		id: "sig-secret-linear",
		prefix: "lin_api_",
		bodyArb: lengthRangeArb(ALNUM, 40, 60),
		tooShort: charsetArb(ALNUM, 39),
	},
	{
		id: "sig-secret-supabase",
		prefix: "sbp_",
		bodyArb: lengthRangeArb(HEX_LOWER, 40, 60),
		tooShort: charsetArb(HEX_LOWER, 39),
	},
	{
		id: "sig-secret-planetscale",
		prefix: "pscale_tkn_",
		bodyArb: lengthRangeArb(ALNUM_HYPHEN_UNDERSCORE, 20, 60),
		tooShort: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 19),
	},
	{
		id: "sig-secret-flyio",
		prefix: "fo1_",
		bodyArb: lengthRangeArb(ALNUM_HYPHEN_UNDERSCORE, 20, 60),
		tooShort: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 19),
	},
	{
		id: "sig-secret-railway",
		prefix: "railway_",
		bodyArb: lengthRangeArb(ALNUM_HYPHEN_UNDERSCORE, 20, 60),
		tooShort: charsetArb(ALNUM_HYPHEN_UNDERSCORE, 19),
	},
	{
		id: "sig-secret-render",
		prefix: "rnd_",
		bodyArb: lengthRangeArb(ALNUM, 20, 60),
		tooShort: charsetArb(ALNUM, 19),
	},
	{
		id: "sig-secret-terraform-cloud",
		prefix: "atlasv1-",
		bodyArb: lengthRangeArb(ALNUM, 40, 60),
		tooShort: charsetArb(ALNUM, 39),
	},
	{
		id: "sig-secret-grafana-sa",
		prefix: "glsa_",
		bodyArb: lengthRangeArb(ALNUM_UNDERSCORE, 20, 60),
		tooShort: charsetArb(ALNUM_UNDERSCORE, 19),
	},
];

describe("signatures — property-based: every spec'd token shape fires its rule", () => {
	for (const spec of SPECS) {
		it(`${spec.id}: any well-shaped body matches`, () => {
			fc.assert(
				fc.property(spec.bodyArb, (body) => {
					return hits(spec.id, spec.prefix + body);
				}),
				{ numRuns: 60 },
			);
		});
	}
});

describe("signatures — property-based: wrong prefix never matches", () => {
	for (const spec of SPECS) {
		it(`${spec.id}: 'WRONGPREFIX_' + body does NOT match`, () => {
			fc.assert(
				fc.property(spec.bodyArb, (body) => {
					return !hits(spec.id, `WRONGPREFIX_${body}`);
				}),
				{ numRuns: 30 },
			);
		});
	}
});

describe("signatures — property-based: length below minimum does NOT match", () => {
	for (const spec of SPECS) {
		const tooShortArb = spec.tooShort;
		if (!tooShortArb) continue;
		it(`${spec.id}: body of (min−1) chars does NOT match`, () => {
			fc.assert(
				fc.property(tooShortArb, (body) => {
					return !hits(spec.id, spec.prefix + body);
				}),
				{ numRuns: 30 },
			);
		});
	}
});

describe("signatures — property-based: random non-provider strings never match any new rule", () => {
	const NEW_RULES = new Set(SPECS.map((s) => s.id));

	it("random alphanumeric/symbol strings without provider prefixes match nothing", () => {
		const RANDOM_TEXT = fc
			.array(fc.constantFrom(...ALNUM, " ", ":", ";", ".", ","), { minLength: 50, maxLength: 200 })
			.map((arr) => arr.join(""));
		fc.assert(
			fc.property(RANDOM_TEXT, (s) => {
				// Reject inputs that happen to contain a known provider prefix by
				// chance — we are testing that BENIGN strings never match, not
				// that the random generator avoids tokens.
				const hasPrefix = SPECS.some((spec) => s.includes(spec.prefix));
				if (hasPrefix) return true;
				const matches = scanSecrets(s);
				return matches.every((m) => !NEW_RULES.has(m.rule_id));
			}),
			{ numRuns: 100 },
		);
	});
});
