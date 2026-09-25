# Project e2e release matrix

Generated 2026-09-25T20:27:30.273Z on Quentins-Mac-mini.local (darwin arm64, node v22.22.0) by `scripts/e2e-release-matrix.mts`.
Every row runs the fixture through the COMMON route (policy + receipt + qualification engine) with the installed toolchain.
A `gap` is an explicit missing prerequisite on this host, never a pass; a `NO` in a rejection column is a contract violation and fails the script.

| Route | Language | Toolchain probe | Present | Valid run accepted | Injected fault rejected | Stale input rejected | Note |
|---|---|---|---|---|---|---|---|
| TypeScript CLI (managed-contracts, build step) | TypeScript | `node --version` | ✅ yes | ✅ yes | ✅ yes | ✅ yes |  |
| Python CLI (managed-contracts, interpreted) | Python | `python3 --version` | ✅ yes | ✅ yes | ✅ yes | ✅ yes |  |
| Rust CLI (managed-contracts, compiled) | Rust | `cargo --version` | ⚠️ gap | ⚠️ gap | ⚠️ gap | ⚠️ gap | toolchain `cargo` (or @playwright/test) is not installed on this host: GAP, not a pass |
| TypeScript HTTP service (owned service, http boundary) | TypeScript | `node --version` | ✅ yes | ✅ yes | ✅ yes | ✅ yes |  |
| TypeScript browser app (playwright suite, browser boundary) | TypeScript + Chromium | `node --version` | ✅ yes | ✅ yes | ✅ yes | ✅ yes |  |

Fixtures: `src/harness/project-e2e/__fixtures__/{ts-cli,py-cli,rust-cli,ts-http,ts-browser}`. Faults: the "return success without saving" persistence defect. Stale: a comment appended to the source file.
Not in this matrix: the MCP/Worker profile (plan 31 §10.3) — an explicit release gap until an owned local MCP runtime is driven by a real client call.
