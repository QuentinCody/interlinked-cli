# Cowork integration and measured hook gaps

Interlinked CLI now has an experimental uploaded Cowork plugin, a native conformance
campaign, an authenticated host bridge and workspace/artifact verification commands.
It does not provide full Claude Code parity. Desktop Chat, Cowork cloud execution,
the device VM and the Mac repository are separate surfaces.

## Native measurements — September 8, 2026

Tested through the running `/Applications/Claude.app`, Desktop **1.49585.0 (41ad1d)**,
in cloud mode. Hook receipts reported Linux x64. The earlier device Bash probe ran
in a Linux arm64 VM; the host remained macOS. Installing `.claude/settings.json`
on the Mac is not the installation mechanism tested here.

The expanded plugin registered 33 event definitions. Its exported snapshot contained
115 receipts across 12 distinct native events. Accepted definitions, observed events,
encoded controls and independent effects are separate evidence.

| Surface/control | Measured result | Interlinked behavior/gap |
|---|---|---|
| Cloud native Write denial | Denied file absent; positive control present | Exact native tool/path policy supported |
| Cloud Bash and device Bash denial | Earlier probe verified prevention, including host effects | Shared destructive-command guard; shell effects remain broader than parser coverage |
| PreToolUse `ask` | Native permission prompt displayed; Allow once resumed write | Native adapter and bridge preserve ask; host input rewrites remain conservative |
| PreToolUse `updatedInput` | Original path absent, rewritten path present | Native adapter encodes rewrites without granting permission; host rewrites deny until mapped translation is certified |
| PostToolUse context | Earlier probe delivered model-visible context | Artifact feedback when bytes are accessible |
| Hook exit 1 | Synthetic write proceeded, about 0.10s later | Native failure is **fail-open**; guard launcher converts child failures to explicit deny |
| Hook timeout | Write proceeded after about 15.03s; requested sleep was 20s | Native timeout is **fail-open**; guard launcher uses a 12s internal watchdog |
| PermissionRequest, Notification | Both emitted around ask | Observed through probe, not proof of additional controls |
| PostToolUseFailure | Two receipts for failed Bash calls | Probe-only subscription; normal PostToolUse matcher policy remains separate |
| SubagentStart / SubagentStop | Both emitted; delegated Bash produced pre/post receipts | Observed lifecycle and tool capture; no blanket claim for all delegated actions |
| MessageDisplay, PostToolBatch, TaskCreated, TaskCompleted | Observed | Metadata capture in probe mode |
| SessionStart / SessionEnd | No receipt in this run | Unmeasured, not unsupported; export preceded task completion |
| Stop | Observed in earlier probe, absent from expanded pre-completion export | Does not create a stop-continuation loop |
| Browser, computer-use, connector mutations, device stage/commit | Not effect-certified by this campaign | Explicit tool-name policies can emit denials; do not claim native prevention without separate tests |
| Result replacement, compaction, restart/local mode | Not certified | Remain unmeasured |

The independent directory listing contained `allow`, `ask`, `crash`, `timeout` and
`rewrite-after` files, each with the five bytes `PROBE` and SHA-256
`fc3d915941b87e39064ba2075b6e2b29fc0de33bd9fd2b046f6857036edefda3`.
`deny` and `rewrite-before` were absent. A separate read-only subagent agreed.
The native task also reported an ask-call input-hash anomaly; input hashes alone
are not treated as proof of which path was written.

Evidence is local and intentionally not packaged or published:

- Earlier campaign: `scratch/2026-09-08-cowork-probe/REPORT.md` and its receipts/effects.
- Expanded task: `cse_01DectiRQD4ZasaDf88nS17y`.
- Expanded receipts and listing: `scratch/2026-09-08-cowork-integration/native-events.jsonl`
  and `native-listing.txt`.
- Probed archive SHA-256: `277daa12b2946f01e0045b0bf02d80d3f81f1e8ef220ced7fa957a7a988e0b33`.
  This was the diagnostic package before the guarded launcher was added; its results
  do not certify a later archive or another Desktop release.

## Commands and packaging

```bash
npm run build
interlinked cowork capabilities --json
interlinked cowork package --output scratch/cowork-guard-1
interlinked cowork package --probe --output scratch/cowork-probe-1
interlinked cowork probe-prompt
interlinked cowork report events.jsonl --effects listing.txt
interlinked cowork artifact report.xlsx
interlinked cowork verify /path/to/repository
```

Upload the `.plugin` archive in Desktop Customize → Plugins. The archive contains
explicit plugin assets only, including a self-contained Node runtime, hooks, policy
and skills. It excludes repository configuration, credentials and receipts. Packaging
requires `zip`; the hook environment requires Node. Output directories are exclusive:
use a fresh directory for each build. No Claude Code settings or Desktop databases
are edited by the CLI. `enable --clients cowork` is deliberately not supported.

The default guard has six hook subscriptions and no synthetic fault injection.
Its normal PostToolUse matcher is confined to Write, Edit, MultiEdit, NotebookEdit,
Bash and the exact device Bash tool. Reads/searches and unrelated connector calls
do not launch the normal post-tool runtime; the diagnostic probe remains broad.
The separate probe adds the larger event catalog and basename-specific synthetic
controls. Use a new task and a clean synthetic directory for every campaign. Never
retry a denied action through a different tool. Disable the probe after testing.
For JSONL exports, select **Download** rather than **Download and open**; a missing
file association only affects opening the downloaded text file.

Policy example:

```json
{
  "schema": 1,
  "mode": "guard",
  "deniedTools": ["example_exact_native_tool_name"],
  "deniedPaths": ["/native/project/protected.txt"]
}
```

Malformed policies are errors. Path checks use the actual Read/Write/Edit target,
not text appearing in file content. Portable policy is a subset: repository file
reservations, secrets-in-content gates, distilled rules, supply-chain allowlists,
coverage/mutation and baselines are not automatically transported into Cowork.

The launcher buffers output, checks for Node and converts a nonzero child exit or
12s deadline into a fixed native pre-tool denial. It cannot repair missing hook
subscriptions, an absent launcher, provider termination of the entire hook, or
actions the provider does not expose. **No unconditional fail-closed claim applies.**

## Host bridge and repository checks

```bash
interlinked cowork bridge --workspace project --root /host/project --runtime-root /native/project --token-env INTERLINKED_COWORK_TOKEN
```

The token comes from an environment variable and must be at least 32 characters.
The server binds IPv4 loopback, accepts authenticated JSON POST requests to `/hook`,
rejects browser-origin requests, bounds requests and permits one evaluation at a time.
It does not execute arbitrary shell commands. Native Read/Write/Edit paths must map
inside the declared host root, including realpath/symlink checks. Native and host
file snapshots must match and remain stable through evaluation. Snapshots do not
establish a shared mount, authenticated writer identity, or a filesystem lock.

Optional plugin `bridge` policy uses `url`, `tokenEnv`, `workspace` and `timeoutMs`
(100–10000, default 5000). HTTPS is required except for loopback tests. A configured
bridge is mandatory: missing credentials, busy/unreachable service, unknown tools,
path/version mismatch and unavailable daemon do not produce an allow decision.
Host checks use the existing daemon and preserve `cowork` runner identity. A post-tool
daemon acknowledgement is not proof that deferred project checks completed.

Host warnings and guidance are encoded as PreToolUse `additionalContext`, including
ordinary allows without an explicit permission grant. Post-write artifact feedback
appends to host context. Receipts retain metadata only. Runtime distilled/finding-rule
loaders accept `active_when.agent_source: "cowork"` and arrays containing it.
The feedback paths have HTTP integration coverage; native pre-tool context delivery
on a particular Cowork release remains a separate measurement.

Cloud hooks cannot reach the Mac's loopback socket. Public HTTPS deployment, cloud
credential provisioning and exact workspace synchronization must be configured and
tested separately. No public tunnel, credential, or connector grant is created by
these commands. This bridge is distinct from the optional **Interlinked MCP Server**;
MCP coordination does not confer authority over Cowork-native tools.

`cowork verify` runs tsc, biome and gitleaks through the existing CheckEngine and
compares repository input hashes before/after. Missing/skipped checks or changed
inputs remain unmeasured and exit nonzero. Run normal `interlinked verify`, tests,
configured coverage/mutation and baseline workflows on the actual repository for
their respective guarantees. This command does not invent successful ratchet evidence.

## Non-code artifacts

`cowork artifact` supports bounded DOCX/XLSX/PPTX and Markdown/text/CSV/TSV/HTML.
It records the raw-byte SHA-256, checks ZIP/XML extraction bounds and required Office
parts, flags cached spreadsheet error markers, and warns about placeholders and
credential-like patterns. Native Write post-hooks invoke these checks if the hook
runtime can read the resulting artifact. Unsupported formats remain unmeasured.

It does not validate ZIP CRCs, XML well-formedness, OPC relationships, macros or
document schemas; recalculate formulas; render pages/slides; verify citations or
facts; or authorize publishing. Those require the relevant artifact tools and review.

## Validation and deployment state

The initial focused suite passed **726 tests across 38 files**, covering Cowork,
the existing adapters, daemon request parsing and legacy event identity.
Typechecking, Biome checks, the atomic build, generated-document checks and all
seven affected skill validators passed. The built standalone guard denied both
a synthetic protected path and malformed JSON without recording raw input content.
A real loopback request reached the running host daemon and returned an allow with
matching file snapshots. A synthetic workspace verification ran tsc, Biome and
Gitleaks; artifact verification detected a deliberate placeholder.

The diagnostic plugin was confirmed **disabled** in Desktop after the native run.
The final guard upload was **not completed**: the native picker kept Open disabled
for readable `.plugin` and `.zip` archives, including a fresh Downloads copy and
after changing the filter and refreshing the page. The upload-ready guard archive
is `scratch/2026-09-08-cowork-integration/installed/interlinked-cowork.plugin`, SHA-256
`17c575df5182a386d3902fcde1a83ec570209c042bd43faab1da479a50319cf1`.
Its only custom path denial is the synthetic canary
`/tmp/interlinked-cowork-guard-native/denied.txt`; no host bridge is configured.
The default-policy archive is in the sibling `final/` directory. Native enforcement
of the final launcher still needs a fresh task after upload.

The subsequent review fixed four gaps: allowed pre-tool host context, preservation
of host findings beside artifact feedback, normal post-tool mutating-tool matching,
and Cowork-scoped runtime rule validation. Adapter context capability/translation
metadata now agrees with its encoder. The review suite passed **837 tests across
43 files**, including HTTP feedback regressions, both rule loaders, existing
adapters and atomic-build tests. Typechecking, Biome, generated-document checks and
all seven affected skill validators passed. Re-review identified no remaining P1
or P2 findings in the Cowork integration.

The rebuilt default guard is
`scratch/2026-09-08-cowork-integration/review-fixed-guard/interlinked-cowork.plugin`,
SHA-256 `a0693d8b5407fb56d0aa30ef8a06c80726c1e0ddc6c509de15eacfc971a007bd`.
Its packaged hook matcher and feedback fixes were inspected. This archive has not
been uploaded or certified by a new native run.

The global hook-coverage verification job remained separate from these passing
checks: it reported deferred/unmeasured work while other workspace edits continued.
No coverage-ledger clearance or authenticated writer attribution is claimed.

## Current platform documentation

Anthropic's [plugin documentation](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)
distinguishes shared plugin skills from Cowork-only hooks/subagents. Its
[architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)
describes cloud and local execution, isolated runtimes, connected-device access and
current enterprise observability. The older May design documents are historical;
their local-only and telemetry-availability assumptions are superseded.
