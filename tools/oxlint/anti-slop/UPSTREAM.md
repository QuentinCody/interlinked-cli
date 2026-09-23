# Vendored anti-slop

Source: https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b

Copied from `skills/install-anti-slop/assets/anti-slop` at that exact revision.
The generic entry point, shared modules and nested vendor files are
byte-for-byte copies. The unused `effect/` subtree is omitted. `LICENSE` is
copied from the upstream repository root; nested vendor licenses are retained.
`UPSTREAM.json` records upstream SHA-256 hashes for every copied file.
Its `localSha256` map records local adaptations: `no-known-value-widening.ts`
extracts reporting helpers to meet the repository's function-size cap, with
real-engine regressions covering value, assignment and predicate reporting.

The local host and runtime are pinned together: `oxlint@1.85.0` and
`@oxlint/plugins@1.85.0`. Node >=22.12 is required by this development tool;
this does not change the published CLI's Node support contract.

`oxlint.anti-slop-research.json` enables all 18 generic rules for explicit
measurement. It is not the default lint configuration or a blocking policy.
No Effect rules are loaded. Local audit selection and qualification results
are documented in `docs/anti-slop-audit.md`.

To update, review upstream changes, copy from a verified clean revision,
refresh hashes and provenance, and run the real-engine integration tests and
the research census. Do not blindly overwrite local modifications. A quiet
rule is not qualified merely because the current repository has no findings.
