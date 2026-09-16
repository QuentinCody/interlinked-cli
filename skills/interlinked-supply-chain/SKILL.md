---
name: interlinked-supply-chain
description: "Respond to blocked package installs and manage the Interlinked supply-chain allowlist. Load this when `npm/pnpm/yarn/bun/pip/pipx/poetry/uv/cargo/gem/bundle/go/composer/mvn/dotnet` install is BLOCKED with `[interlinked:supply-chain]`, when adding a dependency to package.json / requirements.txt / pyproject.toml / Cargo.toml / go.mod is refused, when a version is rejected as \"not an exact pin\", when `npm ci` fails a lockfile-snapshot check, or when you need to approve a package (`interlinked allowlist add`), snapshot a lockfile, or verify deps. Package installs are default-deny; a package needs both allowlist membership AND an exact version pin."
---

# interlinked-supply-chain — package installs are default-deny

In an Interlinked-guarded repo, **every package install is blocked before it runs unless the
exact package is pre-approved** on `.interlinked/package-allowlist.json`. The stance: any new
dependency is potentially malicious (a response to the npm/PyPI malware surge). You cannot
install your way out, and you cannot silently self-approve. **When blocked, the correct move is
almost always to surface the need to the human, not to force-approve.**

Two independent requirements for an install to pass: **(a) the name is allowlisted** AND **(b)
the version is an exact pin** (`pkg@1.2.3`). An approved name at a floating version (`lodash`,
`lodash@^4`, `lodash@latest`) is still blocked — a range can resolve to a newer, compromised
release.

PyPI names use standard canonical spelling: case-insensitive, with runs of `-`, `_` and `.`
collapsed to `-`. `PyYAML` and `pyyaml` use the same grant. This does not authorize a different
version. Conflicting legacy aliases fail closed; an authorized add replaces aliases with one
canonical entry, and remove removes all aliases. Other ecosystems retain their own semantics.
`tests readiness python --json` only proposes already-approved exact install argv; it never
installs or adds an approval. Resolve missing grants through the existing operator boundary.

## Load this when
- A package install was blocked with `[interlinked:supply-chain]`.
- Editing a manifest (`package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`,
  `go.mod`, `Gemfile`, `composer.json`, `*.csproj`, …) to add a dep was refused.
- `npm ci` / bare `npm install` / `pip install -r` fails a snapshot check.
- You need to approve, snapshot, list, or verify allowlisted packages.

## What gets blocked

| Action | Result | Why |
|---|---|---|
| `npm install left-pad` (name not allowlisted) | **block** | not approved |
| `npm install lodash` / `lodash@^4` / `lodash@latest` | **block** | not an exact pin (range/tag) |
| `npm install lodash@4.17.21` (allowlisted + pinned) | allow | — |
| `npm install --registry https://evil.tld pkg` / `--index-url …` | **block** | custom registry bypasses signing |
| `npm install git+https://…` / tarball URL / `file:` spec | **block** | never auto-approved (bypasses registry) |
| `npm ci` / bare `npm install` / `pip install -r req.txt` with no matching snapshot | **block** | lockfile not snapshot-approved |
| Edit `package.json` to add `"evil": "^1"` | **block** | manifest-edit gate (a second, separate gate) |
| `npm uninstall x` / version *bump* of an existing dep | allow | nothing new enters |
| `npm install ./local-dir` (local path) | allow | in-workspace, version-controlled |
| install verb while the daemon is **down** | **block** (fail-closed) | a dead guard is a security failure |

Example block text:
```
[interlinked:supply-chain] npm add: 'left-pad' is not in the npm allowlist.
Run `interlinked allowlist add npm left-pad` after reviewing the package.
```

## When an install is blocked: what to do
**First, question the dependency** — the cheapest approved package is the one you don't add.
Confirm it's actually needed and not trivially replaceable (stdlib/native, or a dep already
present); many "blocked install" situations are really "don't add this" (e.g. `left-pad` → native
`padStart`). If it *is* warranted:
1. **Read the reason** — it names the rule and the fix.
2. **Unpinned version?** Add the exact version: `npm install lodash@4.17.21` (only if `lodash`
   is already allowlisted).
3. **Unapproved package?** **Stop and surface to the human.** State the package, version, and
   why you need it, and propose:
   `interlinked allowlist add <ecosystem> <package> --by <human> --reason "…"`.
   Do **not** `--force`. Do **not** switch to editing the manifest (that's the second gate,
   also blocked).
4. **Snapshot mismatch** (a sync like `npm ci`)? The manifest/lockfile changed vs the approved
   snapshot — a human re-runs `interlinked allowlist snapshot --by <human>`.
5. **Custom registry?** Drop the `--registry`/`--index-url` override; use the default registry.
6. **Daemon down (`[harness-offline]`)?** `interlinked harness start`, then retry.

## Getting a package approved (human sign-off operations)

An agent can record a request without granting approval:
```bash
interlinked allowlist propose npm example-package --package-version 1.2.3 --reason "Needed for the public API" --json
```
This writes a pending record under `.interlinked/package-proposals/`. It does not contact a
registry, install anything, change the allowlist, or send a message. Writer identity remains
unknown. Surface the concrete request for operator review; the operator provisions approval
separately. In an externally frozen deployment, approval files and their path ancestors must
be protected by the supervisor while proposal/receipt state stays writable. A same-UID local
daemon and a proposal label do not establish that boundary.
```bash
interlinked allowlist add <ecosystem> <package> --by <name> [--reason <t>] [--version-range <r>] [--force]
```
`--by` is **required**. Ecosystems: `npm, pypi, cargo, rubygems, go, composer, maven, gradle, nuget`.
`--by` is an attribution label, not authenticated approval. The local writable allowlist
does not enforce an immutable-policy experiment: an agent with the same filesystem
authority can change it. Such a deployment needs policy owned outside the agent's write
scope (including its parent directory), with direct edits, replacement and CLI writes
tested against that boundary. Guidance to request approval is not that boundary.
`add` runs **three admission screens** (cheapest first) and **refuses without `--force`** if any fires:
1. **Typosquat** (npm only, offline) — Levenshtein ≤2 to a popular package name.
2. **License** (network) — the version's declared SPDX license vs the committed
   `license_allowlist` (recorded on the entry, re-checked later at manifest-edit time).
3. **OSV advisories** (network, `api.osv.dev`) — open vulnerabilities against the version.

`--force` = "I reviewed this and accept the risk"; it records the finding as a note instead of
refusing. **An agent should not `--force` on its own initiative** — approving a bad package is
the worst failure mode (install then proceeds silently). Surface the screen output to the human.
Screens 2–3 **fail open with a loud `note:`** when offline — a clean `add` with "screen skipped"
notes did *not* pass those screens.

**Whole-lockfile approval** (unblocks `npm ci` / bare install / `pip install -r`):
```bash
interlinked allowlist snapshot --by <name> [--lockfile <name>]   # sha256 every manifest+lockfile in cwd
```
Re-snapshot whenever the manifest/lockfile changes — the gate matches on exact hash.

## Command surface
| Command | Purpose |
|---|---|
| `interlinked allowlist add <eco> <pkg> --by <name> [--reason] [--version-range] [--force]` | Approve one package (3 screens). |
| `interlinked allowlist remove <eco> <pkg>` | Delete an entry. |
| `interlinked allowlist list [--ecosystem <e>] [--json]` | Show approved packages + snapshots. |
| `interlinked allowlist snapshot --by <name> [--lockfile <n>]` | Hash + store manifest/lockfile state. |
| `interlinked allowlist verify` | Diff every committed manifest's deps vs the allowlist; **exits 1** on any unapproved (CI-gateable). |

## Allowlist file format — `.interlinked/package-allowlist.json` (committed, PR-reviewed)
```json
{
  "version": 1,
  "packages": { "npm": { "lodash": { "approved_by": "qcody", "reason": "utility",
                                      "version_range": "^4.0.0", "license": "MIT" } }, "pypi": {}, … },
  "lockfile_snapshots": { "package-lock.json": { "sha256": "…", "approved_by": "qcody" } },
  "license_allowlist": ["MIT", "Apache-2.0", …]
}
```
Malformed JSON loads as an **empty** allowlist (fail-safe: never blocks bootstrap on syntax;
`verify` surfaces the parse error separately). A per-package `version_range` additionally
constrains which requested version passes. `license_allowlist` is **optional** — when absent
(as in a minimal file), admission falls back to a permissive built-in default seed.

## Gotchas
- **Fail-closed when the daemon is down.** The cold paths block installs (the coarse `.mjs`
  path blocks **all** install verbs and tells you to `interlinked harness start`).
- **Exact-pin is separate from membership.** An allowlisted name is still blocked at a floating
  version. Pin grammar is per-ecosystem (npm/cargo/go need full `major.minor.patch`; PyPI
  `==24.2`; RubyGems `'7.1'`; Maven/Gradle reject `-SNAPSHOT`).
- **Manifest-edit is a distinct gate.** Get the package approved *first*, then edit the
  manifest, then install at the pin. Flipping a dep to a git/path/URL source counts as new →
  blocked. A plain version bump of an existing dep is allowed.
  Supported manifest classifiers retain a dependency's exact registry version when checking
  a version-scoped approval. For example, `PyYAML==6.0.2` can satisfy an approval for `6.0.2`;
  it is not treated as an unspecified request. Python extras and environment markers do not
  supply the package version. A wrong, missing or ambiguous pin cannot borrow a version from
  a marker, URL or nested table. This does not add unsupported manifest syntaxes or authorize
  an agent to approve its own dependencies.
- **`interlinked audit` is NOT this.** It's the tamper-evident guard-decision log (see
  **interlinked-observability**). The dependency-vuln (SCA) lane runs in the **default**
  `interlinked verify` (the `dep-audit` tool, `npm audit`-based). Membership auditing =
  `interlinked allowlist verify`.
- **A few harness dev-tools are pre-allowed for *membership*** (npm `vitest`/`@vitest/coverage-v8`/
  `@vitest/coverage-istanbul`; pypi `pytest`/`pytest-cov`/`coverage`/`radon`) so the coverage gate
  isn't a catch-22 — they still need an exact pin. Everything else is default-deny.
- **`--ignore-scripts` warn still fires** on allowlisted installs (defense-in-depth).
- **Env bypass** `INTERLINKED_DISABLE_PACKAGE_GUARD=1` is logged and defeats the whole layer for
  that command — for documented bootstrap flows only, not for getting unstuck.

## Related skills
- **interlinked-harness** — the general PreToolUse guard this gate is part of.
- **interlinked-observability** — `interlinked audit` (the guard-log integrity check).
