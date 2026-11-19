# interlinked-quality-gates: mutation cloud and protocol v3

Reference for [SKILL.md](../SKILL.md). Read it to connect or shard a mutation runner or to operate the durable mutation journal.

### Current dogfood and cloud boundary (2026-08-31)

The local synchronous runner can be exercised without enabling the edit gate
or changing a manifest:

```bash
interlinked mutation measure src/path/to/file.ts \
  --runner-url http://127.0.0.1:8790 --budget-ms 180000
```

Omit `--record` for a read-only smoke test. A successful command proves that
the selected local runner completed this one measurement; it does not prove
that background delivery, cloud tenancy, or the live hook path is ready.

An HTTP 200 alone is not a recordable measurement. `measure` and sweep label a
syntactically readable but incomplete response `PARTIAL — NOT RECORDED`, show
any parsed mutants/survivors for diagnosis, and withhold the raw report from the
write path. `--record` moves the manifest only when the response names the exact
target and source, reports engine exit 0, proves a green test run with more than
zero executed tests, loses zero mutant rows during parsing, and has a non-zero,
conclusive whole-file census. On an existing baseline, every prior mutant in an
unchanged symbol must also remain in that census. The record function repeats
these checks itself, so callers cannot bypass them by invoking the writer
directly. Missing, malformed, red, stale, truncated, timeout, and indeterminate
evidence remains visible but cannot establish or replace a baseline.

A request that outlives the per-request timeout (default 300 s) is not run
again blindly. The client asks the runner for the retained report by job id
(`GET <endpoint>/job/<id>`) on every later round and takes it when it lands;
the outcome then carries `request.resumed: true` and the command prints a NOTE.
Only when the runner holds nothing for that id does the client POST again, and
an accepted repeat is counted: `request.attempts: 2` and a WARNING that the file
was measured twice. Treat `attempts: 2` as two separate runs when comparing
survivor counts.

Protocol v3 now has a digest-pinned evidence contract, authenticated local
adapter, SQLite leases/journal-before-ack primitives, and strict cloud HTTP
submission/claim clients. The manual, explicit opt-in CLI composition is:

```bash
interlinked mutation cloud submit \
  --request scratch/job-request.json --artifact scratch/source.bundle
interlinked mutation cloud submit-edit src/path/to/file.ts
interlinked mutation cloud onboard src/path/to/file.ts
interlinked mutation cloud process
```

All four commands require `.interlinked/mutation-cloud-v3.local.json` (or
`--config`) with `version:1`, `enabled:true`, one HTTPS endpoint, project /
claimant / owner identities, timeouts and lease duration, the pinned contract
digest and key registry, independently configured server authority, evaluator
policy version, and site limit.
The configured digest must equal the contract identity compiled into this CLI
build; agreement between a config file and a remote service is not sufficient,
and a mismatch is refused before source upload, admission, or evaluation.
These four durable-journal verbs require Node
22.5 or newer because they use the built-in `node:sqlite`; importing or using
other CLI commands does not open that runtime. The separate
`background_enabled` field defaults to `false` and is not required for any
manual command. `submit` authenticates cloud acceptance before
the job enters `.interlinked/mutation-journal.sqlite`, then makes ONE immediate
claim attempt. `submit-edit <target>` is the bounded convenience path for one
current proposed target: it rejects symlinks and unsafe paths, captures immutable
HEAD plus exactly those current target bytes, selects tests only from that synthetic
snapshot, and submits the parser-minted request plus its exact archive and target.
Its deterministic job key makes an exact retry idempotent, while a changed target,
HEAD, authority, artifact, scope, or test set produces a different job. It always
uses `require_established`; it cannot establish its own baseline, adopt current code,
or enable the live gate. `process` resumes at most one job through claim → authenticate →
the shared local evaluator → atomic SQLite decision/manifest/receipt/run/outbox
commit → remote ack. A failed ack leaves the committed row recoverable; none of
these verbs enables `per_edit_mutation` or changes its mode.

`onboard <target>` is the separate, safe first-baseline path. It refuses any
staged, unstaged, or untracked change; binds the configured repository identity,
a stable immutable HEAD, and a tracked regular-file target; builds a bounded,
versioned `git archive` and selects tests only from its materialized HEAD snapshot.
The protocol binding names that byte format exactly as `git-archive-tar-v1`;
the request, acceptance receipt, and execution receipt all hash-bind the same
format/hash/length tuple, so a cloud executor must decode that format and must
never infer an archive type from content or a filename.
Before any network call it persists a fresh random job key plus the exact request,
archive, and target bytes as an unclaimable schema-v7 prepared intent. Only an
authenticated acceptance activates that intent atomically as a normal pending job
with `adopt_current`; reopen/replay reuses those exact bytes and rejects drift.
Ordinary `cloud submit` remains `require_established` and cannot carry adoption
intent. Onboarding does not deploy infrastructure or enable the live edit gate.

Schema-v6 authenticated evidence retains the canonical envelope, receipt, and
terminal JSON plus exact report BLOB bytes for offline re-verification, with the
journal commit completed before remote acknowledgement.

Schema v8 scopes the authoritative protocol-v3 manifest head by the exact
authenticated tenant, project, and repository. Switching any of those values is
a baseline miss, never reuse of another authority's state; reopening with the
same values reuses the same head. Upgrading a pre-v8 journal deliberately leaves
the old unscoped singleton head as historical data and creates no attributed
head from it. Ordinary v3 runtime startup does not scan or import
`.interlinked/mutation-manifest.json` or the legacy JSONL stores at all, so a
large, changing, corrupt, or unreadable legacy file cannot grow the SQLite
journal or block startup. The internal explicit audit-import seam is bounded to
256 KiB per file and 512 KiB total; larger files record only bounded metadata
and an `oversized` skip reason. Whether captured or skipped, legacy bytes never
mint or replace v3 authority state. After that migration, run authenticated
`mutation cloud onboard <target>` for each target whose v3 baseline should be
established; `submit` and `submit-edit` remain `require_established` and cannot
bootstrap from legacy state.

Schema v9 applies that same authority boundary before a queue lease is minted.
Both keyed immediate processing and background `process` claims require exact
tenant, project, and repository columns written with the job; runtimes sharing
one local journal cannot claim one another's rows. Pre-v9 job rows are preserved
for audit but deliberately receive no inferred authority, remain unclaimable,
and are not automatically resumable; preserve/review them separately rather
than treating them as v3 work for the configured authority. Onboarding lookup
and uniqueness use the full tenant/project/repository/commit/target tuple, so
the same repository commit and target may establish independent baselines for
different authorities. Existing onboarding rows migrate using the tenant and
project values already persisted and request-bound in those rows; no authority
is reconstructed from a response.

The protocol-v3 contract digest includes the normative source files. After updating those
files, regenerate the CLI digest and have the remote service vendor the matching contract
before expecting strict verification to accept its results. Updating a local pin alone does
not update the remote service; a mismatch remains a verification failure.

Local mutation manifests validate each retained file, symbol, mutant and provenance record.
An invalid nested record makes the snapshot corrupt: it is not a missing baseline, cannot
start adoption, and remains on disk for recovery. Legacy `accepted_reason` and raw partial or
newer disposition data remain preserved; the disposition interpreter decides their meaning
without treating their mere presence as verification evidence.

The separate shadow-v1 contract has its own schema and digest. In this CLI repository,
`npx tsx scripts/gen-shadow-schema.mts --check` and
`npx tsx scripts/gen-shadow-contract-digest.mts --check` verify the committed artifacts;
omit `--check` to regenerate them after an intentional contract change. Shared generator
implementations live under `src/harness/shadow/generation/`, outside the normative protocol
source inventory. Tuple schemas preserve required array entries and rest elements; the binding
mismatch outcome requires a nonempty array. Regenerate its schema and digest together, and
coordinate the matching contract with any remote verifier before using changed results.
After updating the shadow protocol package, re-vendor and re-pin its regenerated
contract digest in remote consumers. Literal ignored input paths retain their
filename bytes, including brackets and Git pathspec prefixes.

The authority key intentionally excludes contract digest and evaluator policy
version. The head stores mechanical mutant identities and statuses, not an old
clean verdict or policy decision. Each result is authenticated under the
currently pinned contract and evaluated under the current policy; missing
prior mutants in unchanged symbols produce not-measured rather than clean.
Evaluation rows and receipts retain the evaluator policy version separately.

The CLI resolves the request, source artifact, target source, and local config
through real paths under the repository root before opening the journal. Each
local input is opened once with no-follow semantics where the host supports
them, then regular-file identity, size, and repository confinement are checked
on that same descriptor before and after a bounded read. Final-component
symlinks are refused even when they point back inside the repository; a path,
inode, parent-link, or size change during the read also refuses the operation.
Protocol-v3 source artifacts are capped at 64 MiB, reports at 16 MiB, target
source at 2 MiB, request JSON at 1 MiB, and the ignored local config at 64 KiB;
remote JSON responses are capped at 8 MiB. These limits are enforced while
reading streams even when `Content-Length` is missing or dishonest, so an
oversized response is **not measured**, never a clean result.

The SQLite queue persists a `next_attempt_at_ms` for every deferral so one old
job cannot monopolize `process`. A normal not-ready response waits one second
and clears the consecutive-failure counter. Operational, parse, evaluation,
commit, and acknowledgement failures retry after 1, 2, 4, 8, 16, 32, then 60
seconds (the delay remains capped at 60 seconds). The eighth consecutive
failure dead-letters the row, preserves its last stage-qualified error, and
exits nonzero with “no clean verdict exists”; it is no longer auto-claimed.
Running `process` before a row is due returns idle rather than hot-looping.
Inspect and token-fence recovery through the public local operations:

```bash
interlinked mutation cloud dead-letters --limit 20
interlinked mutation cloud redrive <job-id> --redrive-token <token>
```

The list limit defaults to 20 and must be from 1 through 100. It reports each
row's poll-vs-ack phase, failure count, last error, and current redrive token.
Redrive only clears the dead-letter state and makes the row due; it does not
claim, process, evaluate, acknowledge, or return a verdict. A poll row resumes
polling and an evaluated row resumes acknowledgement-only when a later
`mutation cloud process` invocation claims it. A stale token is refused.

The explicit commands remain available for inspection and recovery with
`enabled:true`. Autonomous daemon work has a second, default-off boundary:
only a local config that also sets `background_enabled:true` starts the
daemon-owned scheduler. This second opt-in is experimental while each terminal
job still copies the full manifest into an append-only journal snapshot. Leave
it false until bounded/delta manifest storage and retention land. When it is
explicitly enabled, every 15 seconds while the harness daemon is running the
scheduler processes at most one due job and delivers at most one committed
finding. Delivery fsyncs a versioned record to
`.interlinked/mutation-findings.jsonl` before acknowledging the exact SQLite
outbox lease. The stable `outbox_id` makes retries safely deduplicable; every
session active at delivery time queues the bounded finding for its next hook
event (subject to the in-memory queue's 10-minute TTL). With no active session
the durable JSONL row still exists, but the daemon does not currently replay
that file into a later-created session.

This local scheduler is **not** the protocol-v3 live edit gate or proof of a
deployed cloud product. The cloud deployment still needs provisioned
D1/R2/Workflow/private-Sandbox bindings and an isolated executor, followed by
the deployed crash/retry/adverse acceptance matrix. Until that cutover is
atomic, the live gate remains the legacy synchronous v2 path and the old late
harvest remains survivor-only evidence.

Protocol-v3 signing authority is split across that deployment boundary. The
control plane may sign admission plus pre-execution terminalization and its
matching failure result; it must not possess the runner private key. The
isolated executor signs every execution receipt and matching execution result
before returning its service artifact. Verification requires the result signer
to be the same key that signed the receipt for that arm, so a control key cannot
mint measured execution and a runner key cannot approve admission or
terminalization. Only the runner public key is configured in the control
Workflow; provisioning the private runner key in the separate executor remains
a release prerequisite, not something `mutation cloud` commands do locally.

A protocol-v3 durable first sighting defaults to **not measured** when no
baseline exists. It may adopt only when the caller explicitly marks a
background onboarding measurement of current code; a proposed per-edit job
must never establish its own floor.
