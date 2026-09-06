# `shadow-v1` — the cross-repository protocol corpus

The shadow protocol's source of truth is the product package at
`src/harness/shadow/protocol/` (memo `docs/design/remote-shadow-execution.md`
§8.0, first bullet). This directory holds the parts of that contract that must
travel to `interlinked-cloud` unchanged — the mutation-v3 precedent one
directory over.

**Public/private split (2026-09-04).** `src/harness/shadow/protocol/` is now
the CLIENT contract only — 42 registry records. The BROKER-INTERNAL records
(idempotency, mirror publication/upload, the input bundle, the shadow-job
state, two backup records, the Workstream 06 admission types, and
`admission.ts`) moved to `interlinked-cloud/src/shadow/`; the full moved-symbol
table is in the **Moved symbols** section below. `interlinked-cloud`
vendors THIS directory and the client package verbatim under
`vendor/interlinked-cli/protocol/shadow-v1` and
`vendor/interlinked-cli/src/harness/shadow/protocol`, pinned by an independent
sha256 in `vendor/interlinked-cli/shadow-contract.sha256` that
`npm run verify:shadow-contract` (cloud repo) checks against this directory's
own `contract-digest.json`. Regenerate that digest with
`npx tsx scripts/gen-shadow-contract-digest.mts` after any change here or to
the package, then re-vendor and re-pin on the cloud side.

**What the digest covers.** Every file in this directory, plus two DERIVED
source sets: every non-test module of `src/harness/shadow/protocol`, and every
file OUTSIDE that package reachable from those modules through transitive
relative imports. The second set exists because six package modules import
`src/harness/mutation/protocol-v3/canonical.ts` — the canonicalizer that decides
the BYTES every shadow hash is computed over. A pin that stopped at the package
boundary would let the cloud change that module while the shadow pin stayed
valid. Neither set is hand-listed: the generator reads the tree and follows
import specifiers, so a new module or a new cross-package import changes the
digest the moment it lands. Three surfaces keep the pin honest —
`npx tsx scripts/gen-shadow-contract-digest.mts --check` exits non-zero on a
stale digest, `src/harness/shadow/protocol/__tests__/contract-digest-freshness.test.ts`
recomputes it in-process so CI fails on a stale commit, and the cloud verifier
rejects any file present under the vendored package or this directory that the
manifest does not list.

| Path | What it pins |
|---|---|
| `fixtures/hash-vectors.json` | byte-grammar vectors: `shadow-tree-v1`, `shadow-postimages-v1`, `shadow-overlay-v1`. Input entries in, hex digest out. Two implementations that disagree on ONE of these disagree on every binding built from it. |
| `fixtures/projection-corpus.json` | the supported-client corpus: a normalized tool input plus its pre-images, and the exact post-images and post-tree hash it must produce. Plan 00's exit gate G1. |
| `fixtures/malformed-corpus.json` | every rejection class the strict parsers owe: unknown field (top level AND nested), unknown version, out-of-range id/string/integer, empty-string brand, reason/phase mismatch. Plan 00's exit gate G2. |
| `fixtures/identity-table.json` | the content-identity equality table (memo §8.0) as data: pairs of changesets and whether they are the SAME identity. Plan 00's exit gate G3. |
| `fixtures/binding-corpus.json` | the I4 three-view binding comparison: broker authority + daemon claim + policy + measurement (+ the broker-selected cache record) in, the exact mismatch list out. Expectations were adjudicated in review; record hashes come from the oracle's own canonical profile; the generator asserts the product agrees before writing. The substitution and lying-daemon rows are here. |
| `schema/` | **STRUCTURAL SHAPE METADATA, not the validator.** One JSON Schema (Draft 2020-12) per protocol record — `<record id>.schema.json` — plus `index.json` listing every record id, its kind (`wire` / `persisted` / `internal`), the TypeScript type it was generated from, and its file. Every file carries `"x-shadow-contract": "structural-shape"`: it says exactly what the TypeScript declarations say — keys, required sets, `additionalProperties: false`, literal discriminators, brand patterns (`^[0-9a-f]{64}$` for digests, 40-hex for `GitSha`, the RFC3339 shape, the URL-safe id), and `type: integer, minimum: 0` for every numeric field — and NOTHING the parsers add on top: per-field byte and array bounds, calendar validity of a timestamp, canonical-path rules, set/sort semantics, reason/phase compatibility. Schema validity is therefore NECESSARY, NOT SUFFICIENT: a second implementation must PORT the strict validators (`field-checks.ts` and the `parse-*.ts` modules) and EXECUTE `fixtures/malformed-corpus.json`. `__tests__/schema-differential.test.ts` pins BY NAME the malformed rows the schema alone would accept (8 of 26 on landing; 17 of 41 after the second review, every new one an overlay-manifest rule the schema cannot state), so that gap can only shrink, and fails if the schema ever rejects a value the parser accepts. Generated by `npx tsx scripts/gen-shadow-schema.mts` FROM `src/harness/shadow/protocol/registry.ts` — never hand-edited, and never the source a product change is derived from. `registry.test.ts` fails if a record has no schema file or if `index.json` disagrees with the registry. |

Rules:

- **These files are DATA, not documentation.** `src/harness/shadow/protocol/__tests__/`
  executes every row; a fixture nobody runs is worse than no fixture.
- **A change here is a change to the contract.** Both repositories run the same
  corpus, so a fixture edit lands with the parser or grammar change that
  motivated it, never on its own.
- **Digests come from a SECOND implementation.** `scripts/gen-shadow-corpus.mts`
  computes every expected hash, post-image set and changeset with
  `scripts/shadow-projection-oracle.mts` — an independent, deliberately naive
  projector written from the memo rather than from the product — and refuses to
  write a fixture the product package disagrees with. A corpus generated by the
  implementation it tests can only detect later drift; it cannot establish that
  the first answer was ever right. This one caught three real projector defects
  on its first run.
- **A row the two implementations genuinely disagree on is recorded, not
  hidden.** Such a row carries `kind: "disputed"`, BOTH answers, and a written
  adjudication; the corpus test pins the product's CURRENT behaviour so that
  fixing the defect goes red here and forces the dispute to be closed rather
  than forgotten.
- **Every row carries a `reviewed` note** — one line saying what a human should
  check. The corpus test fails on a row that has none, because an expectation
  nobody can review is a number, not a contract.

## Moved symbols (broker-internal half, moved 2026-09-04)

The public/broker split moved these declarations out of this package and into
`interlinked-cloud/src/shadow/`. This table is the permanent record of the
move — it replaces the working handoff notes the split agents used
(the split's working handoff directory under `scratch/`, gitignored and not tracked — this table is the tracked record).

### From `types-transport.ts` → `interlinked-cloud/src/shadow/types-broker.ts`

| Symbol | Kind | Note |
|---|---|---|
| `IdempotencyOperation` | exported union | seven-member operation enum |
| `IdempotencyKeyScope` | **module-private** interface | union base; moves with `IdempotencyRecordV1` |
| `IdempotencyRecordV1` | exported union | `in_progress` / `completed` / `failed` |
| `MirrorUploadState` | exported union | `prepared` / `blobs_verified` / `expired` / `abandoned` |
| `MirrorUploadRecordV1` | exported interface | the quarantine-staging row |
| `AttemptBase` | **module-private** interface | union base; moves with the attempt |
| `MirrorPublicationAttemptV1` | exported union | the 7-state publication state machine |
| `MirrorVersionRecordV1` | exported interface | referenced by the attempt's `version_committed` state |
| `ShadowInputBundleRecordV1` | exported interface | the broker-internal input bundle |
| `ShadowJobStateV1` | exported union | `admitted` / `running` / `finished` / `cancelled` |

**Stayed public** from the same module, deliberately: `PublicationFailure` (it is
inside `MirrorFinalizeStatusResponseV1`), `MirrorBindingV1` (the CLI's OWN local
file `.interlinked/shadow-mirror.json`), and every request/response pair the
daemon sends or reads.

### From `types-core.ts` → `interlinked-cloud/src/shadow/types-broker.ts`

| Symbol | Kind |
|---|---|
| `BaseSnapshotBackupRecordV1` | exported interface |
| `ProvisionedWorkspaceBackupRecordV1` | exported interface |

**Stayed public**: `DependencyTreeCacheRecordV1` — the third record under the
same heading. Its hash is on the wire and `compareBindings` takes the record, so
the CLI re-runs the comparison when the broker publishes it.

### From `types-attestation.ts` → `interlinked-cloud/src/shadow/types-broker.ts`

| Symbol | Kind |
|---|---|
| `AdmissionJobV1` | exported interface |
| `AdmissionNonceState` | exported union |
| `AdmissionExecutionRequestV1` | exported interface |
| `AdmissionAttestationPayloadV1` | exported interface |
| `AdmissionAttestationV1` | exported type alias |
| `VerifiedAdmissionAttestation` | exported branded alias |

**Stayed public**: `SignedEnvelope`, `AuthoringAttestationPayloadV1`,
`AuthoringAttestationV1`, `ShadowKeyPurpose`, `ShadowSigningDomain`,
`ShadowKeyRecordV1`, `VerifiedAuthoringAttestation` — the CLI verifies authoring
signatures against the key registry.

### Parsers + field tables → `interlinked-cloud/src/shadow/parse-broker.ts`

| Moved parser | Field tables | From (this package) |
|---|---|---|
| `parseIdempotencyRecord` | `IDEMPOTENCY_SCOPE_FIELDS`, `IDEMPOTENCY_STATES` | `parse-transport.ts` |
| `parseMirrorVersionRecord` | `MIRROR_VERSION_RECORD_FIELDS` | `parse-transport.ts` |
| `parseMirrorPublicationAttempt` | `ATTEMPT_BASE_FIELDS`, `LEASE_FIELDS`, `ATTEMPT_STATES`, `versionRecordField`, `observedRefsField` | `parse-transport.ts` |
| `parseShadowJobState` | `JOB_BASE_FIELDS`, `JOB_STATES` | `parse-transport.ts` |
| `parseBaseSnapshotBackupRecord` | `BACKUP_COMMON_FIELDS`, `BASE_SNAPSHOT_FIELDS` | `parse-records-store.ts` |
| `parseProvisionedWorkspaceBackupRecord` | `checkProvisionedDependency`, `PROVISIONED_WORKSPACE_FIELDS` | `parse-records-store.ts` |
| `parseMirrorUploadRecord` | `MIRROR_UPLOAD_STATES`, `MIRROR_UPLOAD_FIELDS` | `parse-records-store.ts` |
| `parseShadowInputBundleRecord` | `BUNDLE_MANIFEST_FIELDS`, `BUNDLE_BLOB_FIELDS`, `INPUT_BUNDLE_FIELDS` | `parse-records-store.ts` |

Helpers these parsers use that STAY in this package (the broker side imports
them, or carries its own copy of the two that were module-private):

- `byState` — module-private in `parse-transport.ts`; now exported (decision
  D27) so the broker imports it instead of copying it.
- `counter`, `mirrorKeyField`, `mirrorRefField` — module-private; trivially re-derived.
- `PUBLICATION_FAILURE_FIELDS` / `failureField` — stay public (the finalize
  status response carries a failure), so the broker imports them.
- `LIFETIME_FIELDS`, `membersOf` — module-private in `parse-records-store.ts`
  and still needed there by the dependency-cache record.
- `MIRROR_KEY_FIELDS`, `mirrorRef`, `checkResolvedDependency` — exported from
  `parse-core.ts`, still public.
- `field-checks.ts`, `limits.ts`, `parse-core-entries.ts`, `parse-outcome.ts`
  (`boundedText`, `enumField`, `listOf`, `nullable`), `reason-phases.ts`
  (`SHADOW_PHASES`) — all still public.

### Admission → `interlinked-cloud/src/shadow/admission.ts`

`admission.ts` and `admission.test.ts` moved **whole and verbatim**.
`validateShadowExecutionRequest` takes the `ShadowInputBundleRecordV1` and the
broker's authority view, so it RUNS on the broker. Exported surface that left
this package with it: `AdmissionCheckId`, `AdmissionFailureV1`,
`AdmissionResultV1`, `AdmissionInputV1`, `validateShadowExecutionRequest`,
`admissionFailures`.

Its dependencies all stay public: `binding-compare.ts` (`compareBindings`,
`BrokerAuthorityViewV1`, `MeasuredExecutionViewV1`), `canonical.ts`,
`changeset.ts`, `overlay-manifest.ts`, `tagged-set.ts`, `tool-input.ts`,
`types-binding.ts`, `types-outcome.ts`.

### Registry rows → `interlinked-cloud/src/shadow/registry-broker.ts`

Eight rows:

`base_snapshot_backup`, `provisioned_workspace_backup`, `mirror_upload_record`,
`input_bundle_record`, `idempotency_record`, `mirror_version_record`,
`publication_attempt`, `job_state`.

The public registry (`registry.ts`, this package) went 50 rows → 42.

### Generated schema files → `interlinked-cloud/src/shadow/schema/`

The eight JSON Schema files for the moved records no longer live in this
package's `schema/` (`protocol/shadow-v1/schema/index.json` here now lists 42
records, matching the public registry). `interlinked-cloud` generates its own
eight from the broker declarations with its own port of the generator,
`interlinked-cloud/scripts/gen-shadow-broker-schema.mts`, reading
`interlinked-cloud/src/shadow/registry-broker.ts` — direction stays product →
artifact (decision D1) on the broker side too, so the broker schema cannot
drift from `types-broker.ts` any more than this package's schema can drift
from its own registry. `interlinked-cloud/src/shadow/registry-broker.test.ts`
holds the emitted files against the parser field tables.

### Malformed-corpus rows: NONE moved

`protocol/shadow-v1/fixtures/malformed-corpus.json` has 41 rows across 9
parser labels — `change_set` (9), `overlay_manifest` (9), `tool_input` (8),
`execution_manifest` (5), `claim` (3), `outcome` (3), `dependency_cache_record`
(2), `dependency_request` (1), `freshness` (1). Every one of those records
STAYED PUBLIC, so no corpus row moved and `scripts/gen-shadow-corpus-malformed.mts`
needed no change. The broker-internal records have no rejection corpus of
their own on the cloud side yet.

---

## One deliberate type change

`MirrorFinalizeStatusResponseV1` (public) derived its in-flight state union from
`MirrorPublicationAttemptV1["state"]`. That reference is now an explicit literal
union of the same five states:

```ts
state: "prepared" | "blobs_verified" | "publication_reserved" | "objects_created" | "ref_updated"
```

The cloud's attempt record remains the AUTHORITY for that list. If a state is
added, removed or renamed there, this literal union must follow — nothing pins
the two together across the repo boundary any more.
