// interlinked-tdd: exempt — pure data + a compile-time parity guard; there is no
// runtime logic to unit-test (the guard below IS the test, enforced by tsc).
// ===========================================
// Supply-chain allowlist — known ecosystems (parser-parity-locked)
// ===========================================
// Split out of `allowlist.ts` (per-file line cap) so the command file stays
// under the cap, and so the parser↔command ecosystem parity lives in one place.

import type { Ecosystem } from "../harness/package-install-parser.js";

// Deriving ECOSYSTEMS from a fully-keyed record makes the list COMPILE-TIME
// parity-checked against the parser's `Ecosystem` union: add a parser ecosystem
// and this object stops typechecking until it is listed here. That closes the
// gap where the supply-chain guard could BLOCK an install that `interlinked
// allowlist add` / `snapshot` had no way to APPROVE (finding 2026-06:
// composer/maven/gradle/nuget were blockable-but-not-approvable). No `any`/
// `unknown` value — the value type is the literal `true`.
const ECOSYSTEM_PRESENT: { readonly [K in Ecosystem]: true } = {
	npm: true,
	pypi: true,
	cargo: true,
	rubygems: true,
	go: true,
	composer: true,
	maven: true,
	gradle: true,
	nuget: true,
};

/** Every ecosystem the supply-chain guard understands, in declaration order.
 *  Parity-locked to the parser's `Ecosystem` union by `ECOSYSTEM_PRESENT`. */
// SAFETY: this private object literal has exactly the Ecosystem keys, enforced
// by its complete mapped type above; it is never extended or exported.
export const ECOSYSTEMS = Object.keys(ECOSYSTEM_PRESENT) as readonly Ecosystem[];
