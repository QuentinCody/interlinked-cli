# interlinked-verify: advisories

Reference for [SKILL.md](../SKILL.md). Read it for decision-metrics warnings or `repeated_implementation` findings.

## Decision-metrics warnings

The experimental `metrics decisions` pipeline is separate from `verify` and its
check registry. Its opt-in PostToolUse warnings are advisory, use actual pre-edit
hashes, and retain failures/budget exclusions as unmeasured outcomes. They do not
clear type, coverage, mutation or e2e obligations and do not change
`DEFAULT_ADVISORY_SKIPS`. Use **interlinked-quality-gates** and
`docs/decision-metrics.md` for pilot labels, five-arm audits and model drift.

## Repeated implementation advisory

`repeated_implementation` compares same-file Python and JS/TS function bodies by
AST structure, with a minimum of five statements. Tests, generated files, small
delegates and functions containing nested implementations are excluded. This is
conservative structural matching, not proof that two contracts are equivalent.
It names the matching functions and source lines, shows literal values, and suggests
a shared operation when the contracts match. Do not compress lines or automatically
extract helpers to satisfy it. Preserve correctness and independently evolving behavior.

The daemon reports new or changed groups once per session after all files in the
observed tool changeset have landed. Unchanged groups remain in structured check
results. Stop rescans current touched files through the existing digest and repeat-Stop
filter; `verify --all-checks` reports the full advisory inventory. Default verify skips
this check. It never blocks an edit or Stop and never creates a completion obligation.
A daemon restart can repeat advice. Separate tool calls are separate observed changesets.

Python uses an isolated `python3 -I -S -B` AST parser that reads candidate text.
`verify --all-checks` awaits its managed subprocess with complete input and output,
no implicit parser deadline, and foreground cancellation. Parser startup, syntax,
input-delivery and incomplete-report failures retain `NOT CHECKED` evidence and
partial-verification status. JS/TS foreground analysis also retains complete input.
Its AST traversal remains synchronous within each file.

Runtime hooks and the synchronous compatibility helper retain their separate
256 KiB input, one-second Python deadline and four-MiB Python capture bounds.
Missing parsers, invalid syntax and exhausted bounds retain `NOT CHECKED` evidence.
The recognizer covers whole functions within one file. Cross-file matching and
arbitrary repeated sub-blocks remain outside its scope.


On the first authored edit per language/session without a detected test layout,
PostToolUse probes Python/JS/TS/Rust/Go runner readiness and supplies setup/test guidance.
It does not install packages or hard-block absent tests. Inspect custom layouts before
adding public-contract assertions, then execute them. Explicit `tests readiness` rechecks
changed prerequisites; the automatic probe does not run on every edit.

For Cowork, load **interlinked-cowork**. `cowork verify <workspace>` runs only tsc,
biome and gitleaks with before/after workspace hashes; skipped checks remain
unmeasured. It is not the full `verify` command or a per-edit ratchet. Run configured
repository checks on the filesystem holding the actual version being reviewed.

The optional Bash `tsc` accelerator recognizes executable `tsc` / `npx tsc`
segments in flat, quote-aware command lists. It preserves quoted arguments and
rewrites only the matched invocation. Search patterns, look-alike executable
names, comments, multiline commands, substitutions, and shell grouping fall
through unchanged; run the original compiler normally in those cases.

The file-mode Rust formatter reads the nearest `Cargo.toml` only within the
project root. A neighboring directory with a shared name prefix is outside
that scope; unreadable manifests are reported instead of guessing an edition.
Python behavioral suites run from the resolved project root; companion filenames are
not a sound dependency boundary. Directory-name prefixes never establish confinement.
Missing-companion guidance describes a naming-convention observation, not proof of missing
behavioral coverage. Inspect the project's test layout before adding language-appropriate
public-contract tests.

Interlinked gates edits at **three moments**, and they run different check sets:
- **PreToolUse content gate**: real agent Edit/Write calls run deterministic `pre_block` checks
  without synchronously launching biome/tsc on the daemon event loop; those external overlays
  are recorded as scheduled for applicable file types and run asynchronously after
  the write. Routine scheduling produces no model warning; unavailable or failed checks still
  report **NOT CHECKED**. Python/Go/Rust edits do not receive JS/TS overlay scheduling. Transactional CLI
  paths (`interlinked write` / `verify-changeset`) still run `pre_block → biome → tsc` and fail
  closed. `interlinked multi-edit` uses the same shared content gate.
- **Other PreToolUse guards** (real Edit/Write only): function tokens, coverage, cyclomatic, CRAP, baseline —
  see **interlinked-quality-gates**; package/allowlist — see **interlinked-supply-chain**.
- **PostToolUse** (after the write lands): external tools (tsc/biome/eslint/semgrep/gitleaks/…)
  plus the inline check registry. Findings arrive after the write; default-gate errors can
  return blocking feedback requiring repair, without rolling back the tool. Bash and unknown
  writer tools are routed by their observed filesystem ChangeSet, not merely command parsing.

PostToolUse keeps full findings in the check-results ledger while presenting compact
diagnostics. Repeated advisories are acknowledged per session, check and file; a successful
scoped recheck clears that acknowledgment. Pre-existing TypeScript findings show a count
and the evidence path. "Newly observed" means changed since the previous compiler report,
not proven caused by this edit. Changes observed outside the tool's declared write targets
are labeled "writer unknown"; TypeScript findings there are workspace feedback and do not
block the observing call. Security checks and workspace obligations still apply.

For test evidence, a recognized runner summary can establish the outcome of a piped run.
An unsummarized pipeline's final exit code alone cannot prove the test process passed.
For scratch probes, reading a repository file and writing an unrelated temporary fixture
does not establish a patch applier; the guard checks statically resolved write destinations.
Unknown destinations still rely on filesystem observation after execution.

`interlinked verify` is the **on-demand, whole-project** run of that same check catalog.
Its `function_tokens` finding uses the shared `interlinked-code-v2` adapters and reports every current
product-source implementation over the effective cap. Unsupported languages are reported as
not measured; semantic-model token counts are unrelated and never substitute for this check.
JS/TS counts match `metrics score` function size, edit gates and commit checks. Recovered source
syntax remains unmeasured. Verify is an inventory of current over-cap functions; edit/commit
ratchets separately allow existing debt to hold or shrink, including debt revealed by migration.

Explain that size unit as **syntax tokens** (lexical tokens); AST-node counts and embedding
model tokens are different units. `metrics score` is an advisory composite, not a replacement
for verify or the hard cap. A provisional score does not prove checks passed. Use
`metrics gates --json` for actual coverage execution/freshness and `metrics coverage status`
for index validity. `metrics coverage warm` explicitly runs full Vitest coverage; subsequent
per-edit runs can replace affected test-file contributions. Proposed evidence promotes only
after the matching edit lands, and unsupported/stale capture remains visibly unmeasured.
Route evidence receipts, incremental coverage setup and deletion trials to
**interlinked-quality-gates**.
