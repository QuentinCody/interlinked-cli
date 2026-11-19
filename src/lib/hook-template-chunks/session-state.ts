// Extracted from hooks-template.ts. @codegen-data: template DATA, exempt from the per-file line cap (see large-file-policy.ts).
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\b`, `\\s`, `\\n`, etc.) — they are the source form
// for the runtime script. `\\n` in this file becomes `\n` in the emitted .mjs.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const SESSION_STATE_CHUNK = `// --- Side-stream JSONL paths ---
// All written from the hook process so consumers can grep the streams
// without round-tripping through the harness daemon. Each file caps its
// own size via rotation when needed; activity.jsonl remains the single
// authoritative event stream and these are derivative views.
const FILES_TOUCHED_PATH = join(DATA_DIR, "files-touched.jsonl");
const TESTS_PATH = join(DATA_DIR, "tests.jsonl");
const COSTS_PATH = join(DATA_DIR, "costs.jsonl");
const COSTS_CURSOR_PATH = join(DATA_DIR, "costs-cursor.json");
const VERIFY_RUNS_PATH = join(DATA_DIR, "verify-runs.jsonl");
const RESERVATION_EVENTS_PATH = join(DATA_DIR, "reservation-events.jsonl");
const GRAPH_HISTORY_PATH = join(DATA_DIR, "graph-history.jsonl");
const SUGGESTION_OUTCOMES_PATH = join(DATA_DIR, "suggestion-outcomes.jsonl");
const RULES_STATS_PATH = join(DATA_DIR, "rules-stats.json");

// activity.jsonl and collection.jsonl are rotated by maintenance commands.
// The generated hook cannot import the CLI's file-mutation-lock module, so it
// carries the same small on-disk protocol. Writers never append around a held
// lock: they wait for the replacer, recover only abandoned owners, or fail the
// surrounding best-effort write after a bounded wait.
const FILE_MUTATION_LOCK_WAIT_MS = 15 * 1000;
const FILE_MUTATION_LOCK_RETRY_MS = 5;
const FILE_MUTATION_LOCK_STALE_MS = 10 * 60 * 1000;
const FILE_MUTATION_LEGACY_IDENTITY_SKEW_MS = 2 * 1000;
const FILE_MUTATION_IDENTITY_CACHE_MS = 1000;

function fileMutationLockPath(path) {
    return path + ".interlinked-mutation.lock";
}

function validFileMutationLockToken(token) {
    return typeof token === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(token);
}

function fileMutationLockOwnerPath(path, token) {
    if (!validFileMutationLockToken(token)) throw new TypeError("file-mutation lock token is not path-safe");
    return join(fileMutationLockPath(path), "owner-" + token + ".json");
}

function fileMutationErrorCode(error) {
    return error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : null;
}

function parseFileMutationLockOwner(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    if (!validFileMutationLockToken(value.token)) return null;
    if (!Number.isFinite(value.acquired_at_ms) || value.acquired_at_ms <= 0) return null;
    if (Object.hasOwn(value, "boot_id")
        && (typeof value.boot_id !== "string" || value.boot_id.length === 0)) return null;
    if (Object.hasOwn(value, "process_start_id")
        && (typeof value.process_start_id !== "string" || value.process_start_id.length === 0)) return null;
    return {
        pid: value.pid,
        token: value.token,
        acquired_at_ms: value.acquired_at_ms,
        ...(typeof value.boot_id === "string" ? { boot_id: value.boot_id } : {}),
        ...(typeof value.process_start_id === "string" ? { process_start_id: value.process_start_id } : {}),
    };
}

function readFileMutationLockOwner(ownerPath) {
    try {
        return parseFileMutationLockOwner(JSON.parse(readFileSync(ownerPath, "utf-8")));
    } catch (_err) { void 0; return null; }
}

let cachedFileMutationBootIdentity;
let cachedFileMutationLinuxClockTicks;
let cachedFileMutationOwnIdentity;
let recentFileMutationForeignIdentity;

function readFileMutationBootIdentity() {
    if (cachedFileMutationBootIdentity !== undefined) return cachedFileMutationBootIdentity;
    try {
        if (process.platform === "linux") {
            const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
            const match = /^btime\\s+(\\d+)$/m.exec(readFileSync("/proc/stat", "utf-8"));
            const startedAtMs = match ? Number(match[1]) * 1000 : null;
            cachedFileMutationBootIdentity = id ? { id: "linux:" + id, startedAtMs } : null;
            return cachedFileMutationBootIdentity;
        }
        if (process.platform === "darwin") {
            const output = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 1000,
            });
            const match = /\\bsec\\s*=\\s*(\\d+)/.exec(output);
            cachedFileMutationBootIdentity = match
                ? { id: "darwin:" + match[1], startedAtMs: Number(match[1]) * 1000 }
                : null;
            return cachedFileMutationBootIdentity;
        }
    } catch (_err) { void 0; /* identity failure remains fail-conservative */ }
    cachedFileMutationBootIdentity = null;
    return null;
}

function readFileMutationLinuxClockTicks() {
    if (cachedFileMutationLinuxClockTicks !== undefined) return cachedFileMutationLinuxClockTicks;
    for (const executable of ["/usr/bin/getconf", "/bin/getconf"]) {
        try {
            const output = execFileSync(executable, ["CLK_TCK"], {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 1000,
            }).trim();
            const ticks = Number(output);
            if (Number.isFinite(ticks) && Number.isSafeInteger(ticks) && ticks > 0) {
                cachedFileMutationLinuxClockTicks = ticks;
                return ticks;
            }
        } catch (_err) { void 0; /* try the other portable getconf path */ }
    }
    cachedFileMutationLinuxClockTicks = null;
    return null;
}

function readFileMutationLinuxProcessStartIdentity(pid) {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf-8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\\s+/) : [];
    const startTicks = fields[19];
    if (!startTicks || !/^\\d+$/.test(startTicks)) return null;
    const boot = readFileMutationBootIdentity();
    const ticksPerSecond = readFileMutationLinuxClockTicks();
    const startedAtMs = boot && boot.startedAtMs !== null && ticksPerSecond
        ? boot.startedAtMs + (Number(startTicks) / ticksPerSecond) * 1000
        : null;
    return { id: "linux:" + startTicks, startedAtMs };
}

function readFileMutationProcessStartIdentity(pid) {
    try {
        if (process.platform === "linux") return readFileMutationLinuxProcessStartIdentity(pid);
        if (process.platform === "darwin") {
            const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
                encoding: "utf-8",
                env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
                maxBuffer: 4096,
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 1000,
            }).trim().replace(/\\s+/g, " ");
            const startedAtMs = Date.parse(output + " UTC");
            return output && Number.isFinite(startedAtMs)
                ? { id: "darwin:" + output, startedAtMs }
                : null;
        }
    } catch (_err) { void 0; /* process may have exited during observation */ }
    return null;
}

function readFileMutationProcessIdentity(pid, now) {
    if (pid === process.pid && cachedFileMutationOwnIdentity) return cachedFileMutationOwnIdentity;
    if (pid !== process.pid && recentFileMutationForeignIdentity
        && recentFileMutationForeignIdentity.pid === pid
        && now - recentFileMutationForeignIdentity.observedAtMs < FILE_MUTATION_IDENTITY_CACHE_MS) {
        return recentFileMutationForeignIdentity.identity;
    }
    const boot = readFileMutationBootIdentity();
    const start = readFileMutationProcessStartIdentity(pid);
    const identity = {
        bootId: boot ? boot.id : null,
        bootStartedAtMs: boot ? boot.startedAtMs : null,
        processStartId: start ? start.id : null,
        processStartedAtMs: start ? start.startedAtMs : null,
    };
    if (pid === process.pid) cachedFileMutationOwnIdentity = identity;
    else recentFileMutationForeignIdentity = { pid, observedAtMs: now, identity };
    return identity;
}

function fileMutationOwnerIdentityIsStale(owner, identity) {
    if (owner.boot_id && identity.bootId && owner.boot_id !== identity.bootId) return true;
    if (owner.process_start_id && identity.processStartId
        && owner.process_start_id !== identity.processStartId) return true;
    // Only a complete matching tuple is definitive. Partial records can be
    // published when one OS probe fails and still need the epoch fallback.
    if (owner.boot_id && owner.process_start_id) return false;
    if (identity.bootStartedAtMs !== null
        && owner.acquired_at_ms + FILE_MUTATION_LEGACY_IDENTITY_SKEW_MS < identity.bootStartedAtMs) return true;
    return identity.processStartedAtMs !== null
        && owner.acquired_at_ms + FILE_MUTATION_LEGACY_IDENTITY_SKEW_MS < identity.processStartedAtMs;
}

function fileMutationOwnerIsAbandoned(owner, now) {
    if (!processIsAlive(owner.pid)) return true;
    return fileMutationOwnerIdentityIsStale(
        owner,
        readFileMutationProcessIdentity(owner.pid, now),
    );
}

function observeFileMutationLock(path, lockPath) {
    let entries;
    try { entries = readdirSync(lockPath).sort(); }
    catch (error) {
        if (fileMutationErrorCode(error) === "ENOENT") return null;
        if (fileMutationErrorCode(error) === "ENOTDIR") {
            return { entries: [], legacy: true, owner: readFileMutationLockOwner(lockPath), ownerPath: lockPath };
        }
        return { entries: [], legacy: false, owner: null, ownerPath: null };
    }
    if (entries.length !== 1) return { entries, legacy: false, owner: null, ownerPath: null };
    const entry = entries[0];
    if (!entry || !entry.startsWith("owner-") || !entry.endsWith(".json")) {
        return { entries, legacy: false, owner: null, ownerPath: null };
    }
    const ownerPath = join(lockPath, entry);
    const owner = readFileMutationLockOwner(ownerPath);
    const tokenFromName = entry.slice("owner-".length, -".json".length);
    if (!owner || owner.token !== tokenFromName) {
        return { entries, legacy: false, owner: null, ownerPath: null };
    }
    if (fileMutationLockOwnerPath(path, owner.token) !== ownerPath) {
        return { entries, legacy: false, owner: null, ownerPath: null };
    }
    return { entries, legacy: false, owner, ownerPath };
}

function fileMutationLockAgeMs(lockPath, observation, now) {
    if (observation.owner) return Math.max(0, now - observation.owner.acquired_at_ms);
    try { return Math.max(0, now - statSync(lockPath).mtimeMs); }
    catch (_err) { void 0; return 0; }
}

function sameFileMutationLockOwner(left, right) {
    return !!left && !!right
        && left.pid === right.pid
        && left.token === right.token
        && left.acquired_at_ms === right.acquired_at_ms
        && left.boot_id === right.boot_id
        && left.process_start_id === right.process_start_id;
}

function unlinkObservedFileMutationEntries(lockPath, observation) {
    const first = observation.ownerPath || (observation.entries[0] && join(lockPath, observation.entries[0]));
    if (!first) return true;
    if (observation.owner
        && !sameFileMutationLockOwner(readFileMutationLockOwner(first), observation.owner)) {
        return false;
    }
    try { unlinkSync(first); }
    catch (_err) {
        // A competing recoverer retired the exact observed token. It owns
        // recovery; never continue on to a successor lock directory.
        return false;
    }
    for (const entry of observation.entries) {
        const entryPath = join(lockPath, entry);
        if (entryPath === first) continue;
        try { unlinkSync(entryPath); }
        catch (_err) { return false; }
    }
    return true;
}

function removeEmptyFileMutationLockDirectory(lockPath) {
    try { rmdirSync(lockPath); return true; }
    catch (error) {
        if (fileMutationErrorCode(error) === "ENOENT") return true;
        // ENOTEMPTY means a successor published its token. Leave it intact.
        return false;
    }
}

function removeObservedFileMutationLock(lockPath, observation) {
    if (!unlinkObservedFileMutationEntries(lockPath, observation)) return false;
    // A rolling-upgrade legacy lock is the file at lockPath itself. Once that
    // exact file is unlinked, never rmdir the path: it may now be a successor.
    if (observation.legacy) return true;
    return removeEmptyFileMutationLockDirectory(lockPath);
}

function recoverAbandonedFileMutationLock(path, lockPath, now) {
    const observation = observeFileMutationLock(path, lockPath);
    if (!observation) return true;
    const abandonedOwner = observation.owner !== null
        && fileMutationOwnerIsAbandoned(observation.owner, now);
    const malformedAndStale = observation.owner === null
        && fileMutationLockAgeMs(lockPath, observation, now) >= FILE_MUTATION_LOCK_STALE_MS;
    if (!abandonedOwner && !malformedAndStale) return false;
    return removeObservedFileMutationLock(lockPath, observation);
}

function releaseFileMutationLock(lockPath, ownerPath, expectedOwner) {
    const owner = readFileMutationLockOwner(ownerPath);
    if (!sameFileMutationLockOwner(owner, expectedOwner)) return;
    try { unlinkSync(ownerPath); }
    catch (error) {
        if (fileMutationErrorCode(error) === "ENOENT") return;
        throw error;
    }
    removeEmptyFileMutationLockDirectory(lockPath);
}

function tryCreateFileMutationLease(path, lockPath, owner) {
    try { mkdirSync(lockPath); }
    catch (error) {
        if (fileMutationErrorCode(error) === "EEXIST") return null;
        throw error;
    }
    const ownerPath = fileMutationLockOwnerPath(path, owner.token);
    try {
        writeFileSync(ownerPath, JSON.stringify(owner), { flag: "wx" });
        return { lockPath, ownerPath, owner };
    } catch (error) {
        removeEmptyFileMutationLockDirectory(lockPath);
        // A stale recoverer can retire the empty directory between mkdir and
        // the owner write. Retry; never enter without a durable owner entry.
        if (fileMutationErrorCode(error) === "ENOENT") return null;
        throw error;
    }
}

function withFileMutationLock(path, action) {
    const lockPath = fileMutationLockPath(path);
    const startedAt = Date.now();
    const token = randomUUID();
    const identity = readFileMutationProcessIdentity(process.pid, startedAt);
    const owner = {
        pid: process.pid,
        token,
        acquired_at_ms: startedAt,
        ...(identity.bootId ? { boot_id: identity.bootId } : {}),
        ...(identity.processStartId ? { process_start_id: identity.processStartId } : {}),
    };

    while (true) {
        const lease = tryCreateFileMutationLease(path, lockPath, owner);
        if (lease) {
            try { return action(); }
            finally { releaseFileMutationLock(lease.lockPath, lease.ownerPath, lease.owner); }
        }
        if (recoverAbandonedFileMutationLock(path, lockPath, Date.now())) continue;
        if (Date.now() - startedAt >= FILE_MUTATION_LOCK_WAIT_MS) {
            throw new Error("timed out waiting for append/rotation lock " + lockPath);
        }
        blockingSleep(FILE_MUTATION_LOCK_RETRY_MS);
    }
}

function appendFileWithMutationLock(path, data) {
    return withFileMutationLock(path, function() { appendFileSync(path, data); });
}

function appendJsonl(path, record) {
    try {
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(path, JSON.stringify(record) + "\\n");
    } catch (_err) { void 0; /* intentional: best-effort side-stream write */ }
}

function safeSessionFilePath(sessionId, suffix) {
    if (!sessionId) return null;
    const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    if (!safe) return null;
    return join(SESSIONS_DIR, safe + suffix);
}

// --- files-touched.jsonl — flat per-file activity index ---
// Append on every Edit/Write/MultiEdit PostToolUse so "what's the recent
// history on file X?" is O(grep) instead of full activity.jsonl scan.
function emitFilesTouched(sessionId, agentName, event) {
    const tn = event.tool_name || "";
    if (tn !== "Edit" && tn !== "Write" && tn !== "MultiEdit" && tn !== "NotebookEdit" && tn !== "apply_patch") return;
    const ti = event.tool_input || {};
    const file = ti.file_path || ti.path || ti.target_file || (Array.isArray(event.files_modified) ? event.files_modified[0] : null);
    if (!file) return;
    appendJsonl(FILES_TOUCHED_PATH, {
        ts: new Date().toISOString(),
        file,
        session_id: sessionId || null,
        agent: agentName || null,
        tool: tn,
        lines_added: event.lines_added || 0,
        lines_removed: event.lines_removed || 0,
        hunks_count: event.hunks_count || 0,
        content_sha256: event.content_sha256 || null,
        turn_id: event.turn_id || null,
        tool_outcome: event.tool_outcome || null,
    });
}

// --- tests.jsonl — structured test/typecheck/lint command outcomes ---
// Detected from Bash PostToolUse by matching the command shape against a
// known set of test-runners. Without explicit exit_code from Claude Code's
// tool_response, success/failure is inferred from stderr length + duration
// + the tool's own success status field.
const TEST_COMMAND_PATTERNS = [
    { kind: "vitest",  match: /\\bvitest\\b/ },
    { kind: "jest",    match: /\\bjest\\b/ },
    { kind: "pytest",  match: /\\bpytest\\b/ },
    { kind: "go-test", match: /\\bgo\\s+test\\b/ },
    { kind: "cargo-test", match: /\\bcargo\\s+test\\b/ },
    { kind: "npm-test",   match: /\\bnpm\\s+(?:run\\s+)?test\\b/ },
    { kind: "yarn-test",  match: /\\byarn\\s+(?:run\\s+)?test\\b/ },
    { kind: "pnpm-test",  match: /\\bpnpm\\s+(?:run\\s+)?test\\b/ },
    { kind: "tsc",        match: /\\b(?:npx\\s+)?tsc\\b/ },
    { kind: "biome",      match: /\\bbiome\\b/ },
    { kind: "oxlint",     match: /\\boxlint\\b/ },
    { kind: "eslint",     match: /\\beslint\\b/ },
    { kind: "ruff",       match: /\\bruff\\b/ },
    { kind: "mypy",       match: /\\bmypy\\b/ },
    { kind: "interlinked-verify", match: /\\binterlinked\\s+verify\\b/ },
];

function classifyTestCommand(command) {
    if (!command || typeof command !== "string") return null;
    for (const p of TEST_COMMAND_PATTERNS) {
        if (p.match.test(command)) return p.kind;
    }
    return null;
}

function emitTestRunIfApplicable(sessionId, agentName, event) {
    if (event.tool_name !== "Bash" && event.tool_name !== "Shell" && event.tool_name !== "shell" && event.tool_name !== "run_command") return;
    const ti = event.tool_input || {};
    const cmd = typeof ti.command === "string" ? ti.command : null;
    const kind = classifyTestCommand(cmd);
    if (!kind) return;
    const tr = event.tool_response;
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    if (tr && typeof tr === "object") {
        stdout = typeof tr.stdout === "string" ? tr.stdout : "";
        stderr = typeof tr.stderr === "string" ? tr.stderr : "";
        interrupted = tr.interrupted === true;
    }
    // Claude Code's PostToolUseFailure has no tool_response: the normalizer's
    // stderr (the error text) and exit_code are the only evidence.
    if (!stderr && typeof event.stderr === "string") stderr = event.stderr;
    const exitCode = typeof event.exit_code === "number" ? event.exit_code : null;
    // Outcome: explicit interrupt → interrupted; an explicit exit code decides;
    // else a known-failure marker → fail, a pass marker → pass, else the
    // normalizer's tool_outcome. Consumers can re-derive from the command.
    const failureMarkers = /(?:^|\\n)\\s*(?:FAIL|FAILED|✘|error TS\\d+|error:|Test (?:Suites|Files): \\d+ failed)/m;
    const passMarkers = /(?:^|\\n)\\s*(?:PASS|✓|passed|OK\\b|0 errors|all clean|Tests: \\d+ passed)/m;
    let outcome = "unknown";
    if (interrupted || event.tool_outcome === "interrupted") outcome = "interrupted";
    else if (exitCode !== null) outcome = exitCode === 0 ? "pass" : "fail";
    else if (failureMarkers.test(stdout) || failureMarkers.test(stderr)) outcome = "fail";
    else if (passMarkers.test(stdout) || passMarkers.test(stderr)) outcome = "pass";
    else if (event.tool_outcome === "error") outcome = "fail";
    else if (event.tool_outcome === "success") outcome = "pass";

    appendJsonl(TESTS_PATH, {
        ts: new Date().toISOString(),
        kind,
        command: cmd ? (cmd.length > 400 ? cmd.slice(0, 400) + "..." : cmd) : null,
        outcome,
        exit_code: exitCode,
        duration_ms: event.duration_ms || null,
        session_id: sessionId || null,
        agent: agentName || null,
        turn_id: event.turn_id || null,
        // Bounded tail of stderr/stdout for diagnostic context. The full
        // text is still in activity.jsonl's tool_response for the same
        // turn, joinable via turn_id.
        stderr_tail: stderr ? stderr.slice(-1024) : null,
        stdout_tail: stdout ? stdout.slice(-512) : null,
    });
}

// --- costs.jsonl — token usage per turn from transcript_path ---
// Reads Claude Code assistant usage and Codex token_count events
// incrementally. Codex's total_token_usage is cumulative; last_token_usage
// is the per-model-call delta that belongs in this append-only ledger.
function costProviderName(provider) {
    if (provider === "claude") return "claude-code";
    return typeof provider === "string" && provider ? provider : null;
}

function costsCursorKey(sessionId, transcriptPath, context) {
    const provider = costProviderName(context && context.provider);
    const subagentId = context && context.subagent_id;
    // Keep the legacy Claude root key so upgrading does not replay a whole
    // transcript into costs.jsonl. Provider/actor/path isolation is required
    // for Codex and subagents because sibling hooks share the parent session.
    if (provider === "claude-code" && !subagentId) return sessionId;
    const identity = JSON.stringify([provider || "unknown", sessionId, subagentId || "root", transcriptPath]);
    return "v2:" + createHash("sha256").update(identity).digest("hex");
}

function costTokenCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emitCostsFromTranscript(sessionId, transcriptPath, context) {
    if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) return;
    const costContext = context || {};
    const provider = costProviderName(costContext.provider);
    const cursorKey = costsCursorKey(sessionId, transcriptPath, costContext);
    let cursor = {};
    try { cursor = JSON.parse(readFileSync(COSTS_CURSOR_PATH, "utf-8")) || {}; }
    catch (_err) { cursor = {}; }
    const cursorEntry = cursor[cursorKey] && typeof cursor[cursorKey] === "object" ? cursor[cursorKey] : {};
    const previousOffset = typeof cursorEntry.offset === "number" ? cursorEntry.offset : 0;
    let stat;
    try { stat = statSync(transcriptPath); } catch { return; }
    if (stat.size <= previousOffset) return;
    const fd = openSync(transcriptPath, "r");
    let chunk = "";
    try {
        const buf = Buffer.alloc(stat.size - previousOffset);
        readSync(fd, buf, 0, buf.length, previousOffset);
        chunk = buf.toString("utf-8");
    } finally { closeSync(fd); }
    let emitted = 0;
    let codexModel = typeof cursorEntry.last_model === "string"
        ? cursorEntry.last_model
        : (typeof costContext.model === "string" ? costContext.model : null);
    for (const line of chunk.split("\\n")) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const payload = obj && obj.payload;
        if ((obj.type === "turn_context" || (obj.type === "response_item" && payload && payload.type === "turn_context"))
            && payload && typeof payload.model === "string" && payload.model) {
            codexModel = payload.model;
        }
        if (obj.type === "assistant") {
            const usage = (obj.message && obj.message.usage) || obj.usage;
            if (!usage) continue;
            const row = {
                ts: obj.timestamp || new Date().toISOString(),
                session_id: sessionId,
                message_id: (obj.message && obj.message.id) || obj.uuid || null,
                model: (obj.message && obj.message.model) || obj.model || null,
                input_tokens: usage.input_tokens || 0,
                output_tokens: usage.output_tokens || 0,
                cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
                stop_reason: (obj.message && obj.message.stop_reason) || null,
            };
            if (provider) row.provider = provider;
            if (costContext.subagent_id) row.subagent_id = costContext.subagent_id;
            appendJsonl(COSTS_PATH, row);
            emitted++;
            continue;
        }
        if (obj.type !== "event_msg" || !payload || payload.type !== "token_count") continue;
        const info = payload.info;
        // Deliberately ignore total_token_usage: it is a running total and
        // appending it once per event would multiply the reported spend.
        const usage = info && info.last_token_usage;
        if (!usage || typeof usage !== "object") continue;
        const row = {
            ts: obj.timestamp || new Date().toISOString(),
            session_id: sessionId,
            message_id: null,
            model: codexModel,
            input_tokens: costTokenCount(usage.input_tokens),
            output_tokens: costTokenCount(usage.output_tokens),
            cache_read_input_tokens: costTokenCount(usage.cached_input_tokens),
            cache_creation_input_tokens: costTokenCount(usage.cache_write_input_tokens),
            reasoning_output_tokens: costTokenCount(usage.reasoning_output_tokens),
            total_tokens: costTokenCount(usage.total_tokens),
            stop_reason: null,
        };
        if (provider) row.provider = provider;
        if (costContext.subagent_id) row.subagent_id = costContext.subagent_id;
        appendJsonl(COSTS_PATH, row);
        emitted++;
    }
    cursor[cursorKey] = {
        offset: stat.size,
        last_emit_at: new Date().toISOString(),
        ...(codexModel ? { last_model: codexModel } : {}),
    };
    // Bound the cursor file at 100 sessions
    const keys = Object.keys(cursor);
    if (keys.length > 100) {
        for (const k of keys.slice(0, keys.length - 100)) delete cursor[k];
    }
    try { writeFileSync(COSTS_CURSOR_PATH, JSON.stringify(cursor)); } catch (_err) { void 0; /* intentional: cursor write best-effort */ }
    return emitted;
}

// --- graph-history.jsonl — once-per-day project graph snapshot ---
// Triggered on SessionStart. Cheap O(1) check on file mtime first; the
// expensive walk only runs when stale. Counts files, lines, exported
// symbol candidates (regex), and dependency edges (regex). Trades a bit
// of accuracy for hook latency vs. running tsc/dependency-cruiser.
const GRAPH_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
function maybeSnapshotGraph(cwd) {
    try {
        if (!existsSync(GRAPH_HISTORY_PATH)) {
            // First run — proceed.
        } else {
            const last = statSync(GRAPH_HISTORY_PATH).mtimeMs;
            if (Date.now() - last < GRAPH_SNAPSHOT_TTL_MS) return;
        }
        const snap = computeGraphSnapshot(cwd);
        if (!snap) return;
        appendJsonl(GRAPH_HISTORY_PATH, snap);
    } catch (_err) { void 0; /* intentional: snapshot best-effort */ }
}

function computeGraphSnapshot(cwd) {
    const SRC_EXTS = /\\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp)$/;
    const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "target", ".venv", "venv", "__pycache__"]);
    let files = 0, lines = 0, exports = 0, imports = 0, cycleHints = 0, hubs = 0;
    const importers = new Map();
    const dirsToVisit = [cwd || process.cwd()];
    while (dirsToVisit.length > 0 && files < 20000) {
        const d = dirsToVisit.pop();
        let entries = [];
        try { entries = readdirSync(d, { withFileTypes: true }); }
        catch (_err) { continue; }
        for (const e of entries) {
            if (SKIP_DIRS.has(e.name)) continue;
            const full = join(d, e.name);
            if (e.isDirectory()) { dirsToVisit.push(full); continue; }
            if (!e.isFile() || !SRC_EXTS.test(e.name)) continue;
            files++;
            let content;
            try { content = readFileSync(full, "utf-8"); } catch { continue; }
            lines += (content.match(/\\n/g) || []).length + 1;
            const ex = content.match(/\\bexport\\s+(?:default\\s+|const\\s+|function\\s+|class\\s+|interface\\s+|type\\s+|enum\\s+)/g);
            if (ex) exports += ex.length;
            const im = content.match(/^\\s*import\\s.*?from\\s+["']([^"']+)["']|^\\s*from\\s+(\\S+)\\s+import/gm);
            if (im) {
                imports += im.length;
                for (const m of im) {
                    const targetMatch = m.match(/from\\s+["']([^"']+)["']/);
                    const target = targetMatch ? targetMatch[1] : null;
                    if (target && target.startsWith(".")) {
                        importers.set(target, (importers.get(target) || 0) + 1);
                    }
                }
            }
        }
    }
    for (const [, count] of importers) if (count >= 8) hubs++;
    // Cycle hint: relative imports that look like ../<self> patterns.
    // Replaced by the harness's full graph if available, but this gives
    // a coarse trend signal without that dependency.
    cycleHints = 0;
    return {
        ts: new Date().toISOString(),
        files,
        lines,
        export_decls: exports,
        import_decls: imports,
        hub_files: hubs,
        cycle_hints: cycleHints,
    };
}

// --- suggestion-outcomes.jsonl — close the loop on advisory warnings ---
// suggestion-telemetry.jsonl rows have outcome=null because the harness
// emits them at warn-time with no knowledge of what happens next. This
// reconciler walks the telemetry stream, groups by (file, check, line),
// and resolves each shown warning by checking the current file state:
//   - line gone → outcome="fixed" (agent or human edited the line)
//   - line still present → outcome="ignored"
//   - file gone → outcome="file_removed"
// Cap on the number of rows examined per call (most recent 5000) so a
// long-running session doesn't pay quadratic time on every reconcile.
function reconcileSuggestionOutcomes(cwd) {
    try {
        const telemetryPath = join(DATA_DIR, "suggestion-telemetry.jsonl");
        const cursorPath = join(DATA_DIR, "suggestion-outcomes-cursor.json");
        if (!existsSync(telemetryPath)) return;
        let cursor = { offset: 0 };
        try { cursor = JSON.parse(readFileSync(cursorPath, "utf-8")) || cursor; }
        catch (_err) { /* intentional: stale cursor → start over */ }
        const stat = statSync(telemetryPath);
        if (stat.size <= cursor.offset) return;
        const fd = openSync(telemetryPath, "r");
        const buf = Buffer.alloc(stat.size - cursor.offset);
        try { readSync(fd, buf, 0, buf.length, cursor.offset); }
        finally { closeSync(fd); }
        const lines = buf.toString("utf-8").split("\\n").filter(Boolean);
        const fileCache = new Map();
        let emitted = 0;
        for (const line of lines) {
            let r;
            try { r = JSON.parse(line); } catch { continue; }
            if (!r.shown) continue;
            const file = r.file;
            if (!file || typeof file !== "string") continue;
            let content = fileCache.get(file);
            if (content === undefined) {
                try {
                    const abs = file.startsWith("/") ? file : join(cwd, file);
                    content = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
                } catch { content = null; }
                fileCache.set(file, content);
            }
            let outcome;
            if (content === null) outcome = "file_removed";
            else if (typeof r.line === "number" && r.message) {
                // Did the warned-about source text survive? Use the message
                // as a proxy — it usually contains the offending snippet.
                const snippet = String(r.message).split("\\n")[0].slice(0, 120);
                if (snippet && content.includes(snippet)) outcome = "ignored";
                else outcome = "fixed";
            } else {
                outcome = "unresolved";
            }
            appendJsonl(SUGGESTION_OUTCOMES_PATH, {
                ts: new Date().toISOString(),
                file,
                check: r.check,
                line: r.line,
                session_id: r.session_id,
                agent: r.agent_name,
                outcome,
                threshold: r.threshold,
                score: r.score,
            });
            emitted++;
        }
        cursor.offset = stat.size;
        try { writeFileSync(cursorPath, JSON.stringify(cursor)); } catch (_err) { void 0; /* intentional: cursor write best-effort */ }
        return emitted;
    } catch (_err) { void 0; /* intentional: reconciler best-effort */ }
}

// --- rules-stats.json — periodic rollup of guard rule activity ---
// Aggregates guard_allow/guard_warn/guard_block rows from activity.jsonl
// over the last N days. Emitted once per ROLLUP_TTL window so SessionEnd
// hooks don't pay O(activity.jsonl) on every session close.
const RULES_STATS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function maybeRollupRulesStats() {
    try {
        let mtime = 0;
        if (existsSync(RULES_STATS_PATH)) {
            mtime = statSync(RULES_STATS_PATH).mtimeMs;
        }
        if (Date.now() - mtime < RULES_STATS_TTL_MS) return;
        if (!existsSync(ACTIVITY_PATH)) return;
        const stat = statSync(ACTIVITY_PATH);
        // Only scan up to last 50 MB of activity.jsonl (~1M events) — older
        // rule activity is captured in prior rollup files anyway.
        const SCAN_BYTES = 50 * 1024 * 1024;
        const start = Math.max(0, stat.size - SCAN_BYTES);
        const fd = openSync(ACTIVITY_PATH, "r");
        const buf = Buffer.alloc(stat.size - start);
        try { readSync(fd, buf, 0, buf.length, start); }
        finally { closeSync(fd); }
        const text = buf.toString("utf-8");
        // First newline boundary so we don't try to parse a partial line.
        const firstNl = text.indexOf("\\n");
        const lines = firstNl >= 0 ? text.slice(firstNl + 1).split("\\n") : text.split("\\n");
        const counts = {}; // rule_id → {allow, warn, block, ask}
        let total = 0;
        for (const line of lines) {
            if (!line.trim()) continue;
            let r;
            try { r = JSON.parse(line); } catch { continue; }
            const t = r.type;
            if (t !== "guard_allow" && t !== "guard_warn" && t !== "guard_block") continue;
            const id = r.guard_rule_id || "<no_rule_id>";
            if (!counts[id]) counts[id] = { allow: 0, warn: 0, block: 0, ask: 0 };
            if (t === "guard_allow") counts[id].allow++;
            else if (t === "guard_warn") counts[id].warn++;
            else if (t === "guard_block") {
                if (r.guard_decision === "ask") counts[id].ask++;
                else counts[id].block++;
            }
            total++;
        }
        const top = Object.entries(counts)
            .map(([id, c]) => ({
                rule_id: id,
                allow: c.allow,
                warn: c.warn,
                block: c.block,
                ask: c.ask,
                total: c.allow + c.warn + c.block + c.ask,
                noise_ratio: c.warn + c.block === 0 ? 0 : Number((c.allow / (c.allow + c.warn + c.block + c.ask)).toFixed(3)),
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 100);
        const rollup = {
            generated_at: new Date().toISOString(),
            scanned_events: total,
            scanned_bytes: buf.length,
            window: "last 50 MB of activity.jsonl",
            rules: top,
        };
        try { writeFileSync(RULES_STATS_PATH, JSON.stringify(rollup, null, 2)); }
        catch (_err) { void 0; /* intentional: rollup write best-effort */ }
    } catch (_err) { void 0; /* intentional: rollup best-effort */ }
}

// --- Thinking Extraction — real-time capture from transcript ---
// Reads new thinking blocks from the Claude Code transcript JSONL on each
// hook invocation. Uses a byte-offset cursor persisted to disk so the
// short-lived hook process only reads incremental content.
const THINKING_CURSOR_PATH = join(DATA_DIR, "thinking-cursor.json");

function extractNewThinking(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    try {
        const stat = statSync(transcriptPath);
        const fileSize = stat.size;

        let cursor = { path: "", offset: 0 };
        try { cursor = JSON.parse(readFileSync(THINKING_CURSOR_PATH, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }

        // Reset cursor if transcript changed (new session)
        if (cursor.path !== transcriptPath) cursor = { path: transcriptPath, offset: 0 };
        if (cursor.offset >= fileSize) return null;

        // Read only new bytes since last invocation
        const fd = openSync(transcriptPath, "r");
        const buf = Buffer.alloc(fileSize - cursor.offset);
        readSync(fd, buf, 0, buf.length, cursor.offset);
        closeSync(fd);

        const newContent = buf.toString("utf-8");

        // Extract thinking blocks from new JSONL lines
        const thinkingParts = [];
        for (const line of newContent.split("\\n")) {
            if (!line.trim()) continue;
            try {
                const obj = JSON.parse(line);
                if (obj.type === "assistant") {
                    for (const block of (obj.message?.content || [])) {
                        if (block.type === "thinking" && block.thinking) {
                            thinkingParts.push(block.thinking);
                        }
                    }
                }
            } catch (_err) { void 0; /* intentional: no-op */ }
        }

        // Persist updated cursor
        try { writeFileSync(THINKING_CURSOR_PATH, JSON.stringify({ path: transcriptPath, offset: fileSize })); } catch (_err) { void 0; /* intentional: no-op */ }

        if (thinkingParts.length === 0) return null;

        let combined = thinkingParts.join("\\n---\\n");
        // No cap: the full reasoning trace is captured locally (scrubbed for
        // secrets + PII by scrubPayload in appendLocal). The server-bound copy
        // is bounded separately at the realtime-payload site, so uncapping here
        // does not increase what leaves the machine.
        return combined;
    } catch {
        return null;
    }
}

// --- Git context (commit attribution) ---
// Resolve HEAD sha + branch by reading .git directly — no subprocess, so it
// stays well within the hook budget. Memoized per process: the .mjs runs
// once per event, so a single resolution serves every record it writes.
// Fail-open to nulls on any error (missing .git, detached HEAD, worktree
// pointer files) — git context is an annotation, never a gate.
let _gitContextCache = null;
function gitContext(startDir) {
    if (_gitContextCache) return _gitContextCache;
    _gitContextCache = resolveGitContext(startDir);
    return _gitContextCache;
}
function resolveGitContext(startDir) {
    try {
        let dir = startDir || process.cwd();
        let gitPath = null;
        for (let i = 0; i < 25; i++) {
            const candidate = join(dir, ".git");
            if (existsSync(candidate)) { gitPath = candidate; break; }
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        if (!gitPath) return { git_head: null, git_branch: null };
        let gitDir = gitPath;
        if (statSync(gitPath).isFile()) {
            // Worktree / submodule: .git is a "gitdir: <path>" pointer file.
            const ptr = readFileSync(gitPath, "utf-8").trim().match(/^gitdir:\\s*(.+)$/);
            if (!ptr) return { git_head: null, git_branch: null };
            gitDir = ptr[1].charAt(0) === "/" ? ptr[1] : join(dir, ptr[1]);
        }
        const headTxt = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
        const refMatch = headTxt.match(/^ref:\\s*(.+)$/);
        if (!refMatch) {
            // Detached HEAD — the file holds the commit sha directly.
            return { git_head: headTxt.slice(0, 40) || null, git_branch: null };
        }
        const ref = refMatch[1];
        const branch = ref.replace(/^refs\\/heads\\//, "");
        let head = null;
        const loosePath = join(gitDir, ref);
        if (existsSync(loosePath)) {
            head = readFileSync(loosePath, "utf-8").trim();
        } else {
            const packedPath = join(gitDir, "packed-refs");
            if (existsSync(packedPath)) {
                for (const line of readFileSync(packedPath, "utf-8").split("\\n")) {
                    if (!line || line.charAt(0) === "#" || line.charAt(0) === "^") continue;
                    const sp = line.indexOf(" ");
                    if (sp > 0 && line.slice(sp + 1) === ref) { head = line.slice(0, sp); break; }
                }
            }
        }
        return { git_head: head ? head.slice(0, 40) : null, git_branch: branch || null };
    } catch (_err) {
        return { git_head: null, git_branch: null };
    }
}

// --- Audit chain helpers (borrowed from Microsoft AGT's audit.mjs pattern, MIT) ---
// Used by appendGuardDecision (guard_* decisions) and appendLocal (session_end
// records carrying Claude Code's \`reason\` field). All chained record types
// share the same canonical-JSON + sha256 + genesis chain. Verifier lives in
// src/lib/audit-chain.ts. Maps to OWASP ASI11 (Agent Untraceability).
//
// The constant name is historical — it was guard-only before session_end was
// added 2026-05. Semantically this is "chained record types," not just guards.
const AUDIT_GUARD_TYPES = { guard_block: 1, guard_warn: 1, guard_allow: 1, session_end: 1 };
const AUDIT_GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function auditCanonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(auditCanonicalJson).join(",") + "]";
    const keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + auditCanonicalJson(value[k]); }).join(",") + "}";
}

function computeAuditHash(record) {
    // Exclude 'hash' itself — chain over everything else including previousHash.
    const rest = {};
    for (const k of Object.keys(record)) { if (k !== "hash") rest[k] = record[k]; }
    return createHash("sha256").update(auditCanonicalJson(rest)).digest("hex");
}

// Tail-read activity.jsonl to find the most recent hash-bearing guard_* entry.
// Cost is one read of up to AUDIT_TAIL_BYTES from EOF (typically ~one syscall);
// for a healthy log the last line is reachable inside the first chunk.
const AUDIT_TAIL_BYTES = 64 * 1024;
function readPreviousGuardHash() {
    try {
        if (!existsSync(ACTIVITY_PATH)) return AUDIT_GENESIS_HASH;
        const size = statSync(ACTIVITY_PATH).size;
        if (size === 0) return AUDIT_GENESIS_HASH;
        const readSize = Math.min(AUDIT_TAIL_BYTES, size);
        const buf = Buffer.alloc(readSize);
        const fd = openSync(ACTIVITY_PATH, "r");
        try { readSync(fd, buf, 0, readSize, size - readSize); } finally { closeSync(fd); }
        const lines = buf.toString("utf-8").split("\\n");
        // Walk newest-first; first line may be partial if the tail clipped mid-record.
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
                const rec = JSON.parse(line);
                if (rec && AUDIT_GUARD_TYPES[rec.type] && typeof rec.hash === "string" && rec.hash.length === 64) {
                    return rec.hash;
                }
            } catch (_e) { /* partial / malformed — keep walking */ }
        }
        return AUDIT_GENESIS_HASH;
    } catch (_err) {
        return AUDIT_GENESIS_HASH;
    }
}

// --- Local JSONL append (full capture, sync) ---
// Unified log-format version for activity.jsonl. BOTH record families —
// activity/lifecycle events (appendLocal) and guard decisions
// (appendGuardDecision) — share this one version. The record FAMILY is
// distinguished by \`type\` (guard_* vs tool_use/user_prompt/...), never by the
// version number. (Historically activity=4, guard=3; unified to 5 so the
// number means "format", and \`type\` means "family".)
const ACTIVITY_SCHEMA_VERSION = 5;
function appendLocal(event, hookEvent, sessionId, agentName, workspaceKey, projectKey) {
    try {
        const dir = dirname(ACTIVITY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const record = {
            schema_version: ACTIVITY_SCHEMA_VERSION,
            ts: new Date().toISOString(),
            agent: agentName || "unknown",
            workspace_key: workspaceKey || null,
            project_key: projectKey || null,
            type: event.event_type,
            tool: event.tool_name || null,
            summary: event.tool_input_summary || null,
            session: sessionId || null,
            hook: hookEvent || null,
        };
        // v2 fields
        if (event.tokens) record.tokens = event.tokens;
        if (event.duration_ms) record.duration_ms = event.duration_ms;
        if (event.parent_agent) record.parent_agent = event.parent_agent;
        if (event.subagent_id) record.subagent_id = event.subagent_id;
        if (event.files_modified) record.files_modified = event.files_modified;
        // v3 full-capture fields
        if (event.tool_input !== undefined) record.tool_input = event.tool_input;
        if (event.tool_response !== undefined) record.tool_response = event.tool_response;
        if (event.tool_use_id) record.tool_use_id = event.tool_use_id;
        if (event.error !== undefined) record.error = event.error;
        if (event.is_interrupt !== undefined) record.is_interrupt = event.is_interrupt;
        // v4 derived outcome fields (canonical across all clients — set
        // by attachOutcome in the per-client PostToolUse normalizers)
        if (event.tool_outcome) record.tool_outcome = event.tool_outcome;
        if (event.exit_code !== undefined && event.exit_code !== null) record.exit_code = event.exit_code;
        if (event.stderr) record.stderr = event.stderr;
        if (event.stdout) record.stdout = event.stdout;
        if (event.tool_response_sha256) record.tool_response_sha256 = event.tool_response_sha256;
        // v4 error annotation — canonical diagnostic text + coarse category,
        // both set by attachOutcome. Previously computed and dropped here.
        if (event.error_message) record.error_message = event.error_message;
        if (event.error_category) record.error_category = event.error_category;
        // v4 payload sizes — original (pre-cap) byte counts from the
        // normalizer, so a truncated tool_response is still measurable.
        if (event.tool_input_bytes !== undefined) record.tool_input_bytes = event.tool_input_bytes;
        if (event.tool_output_bytes !== undefined) record.tool_output_bytes = event.tool_output_bytes;
        // v4 diff fingerprints (set by attachEditMetrics for Edit/Write/MultiEdit/NotebookEdit)
        if (event.lines_added !== undefined) record.lines_added = event.lines_added;
        if (event.lines_removed !== undefined) record.lines_removed = event.lines_removed;
        if (event.net_loc_delta !== undefined) record.net_loc_delta = event.net_loc_delta;
        if (event.hunks_count !== undefined) record.hunks_count = event.hunks_count;
        if (event.content_sha256) record.content_sha256 = event.content_sha256;
        // v4 turn linkage
        if (event.turn_id) record.turn_id = event.turn_id;
        if (event.parent_tool_use_id) record.parent_tool_use_id = event.parent_tool_use_id;
        if (event.parent_session_id) record.parent_session_id = event.parent_session_id;
        // Side-streams: derivative views written alongside activity.jsonl.
        // Each is a no-op for irrelevant events, so the cost on the hot
        // path (PreToolUse for non-edit tools) is one early-return apiece.
        try { emitFilesTouched(sessionId, agentName, event); } catch (_err) { void 0; /* intentional: best-effort side-stream */ }
        try { emitTestRunIfApplicable(sessionId, agentName, event); } catch (_err) { void 0; /* intentional: best-effort side-stream */ }
        if (event.cwd) record.cwd = event.cwd;
        if (event.permission_mode) record.permission_mode = event.permission_mode;
        if (event.transcript_path) record.transcript_path = event.transcript_path;
        if (event.model) record.model = event.model;
        if (event.source) record.source = event.source;
        if (event.agent_type) record.agent_type = event.agent_type;
        if (event.last_assistant_message !== undefined) record.last_assistant_message = event.last_assistant_message;
        if (event.agent_transcript_path) record.agent_transcript_path = event.agent_transcript_path;
        if (event.prompt !== undefined) record.prompt = event.prompt;
        if (event.notification_type) record.notification_type = event.notification_type;
        if (event.notification_title) record.notification_title = event.notification_title;
        if (event.notification_message) record.notification_message = event.notification_message;
        if (event.task_id) record.task_id = event.task_id;
        if (event.task_subject) record.task_subject = event.task_subject;
        if (event.task_description) record.task_description = event.task_description;
        if (event.teammate_name) record.teammate_name = event.teammate_name;
        if (event.team_name) record.team_name = event.team_name;
        if (event.trigger) record.trigger = event.trigger;
        if (event.custom_instructions) record.custom_instructions = event.custom_instructions;
        if (event.reason) record.reason = event.reason;
        if (event.stop_hook_active !== undefined) record.stop_hook_active = event.stop_hook_active;
        if (event.permission_suggestions) record.permission_suggestions = event.permission_suggestions;
        if (event.thinking) record.thinking = event.thinking;
        // Git context — ties every event to a commit without timestamp-
        // fuzzing the reflog. Memoized; reads .git directly, no subprocess.
        const gc = gitContext(event.cwd);
        if (gc.git_head) record.git_head = gc.git_head;
        if (gc.git_branch) record.git_branch = gc.git_branch;
        // The local activity.jsonl is kept 100% FAITHFUL — NO secret/PII redaction
        // here. This is the full-fidelity capture for replay / trajectory /
        // prediction / training. Redaction is an EGRESS-ONLY transform: every
        // server-bound path (the realtime POST + batchSync below, the
        // \`interlinked sync\` CLI, and the daemon server-bridge) runs the shared
        // scrubber before sending. Two-tier model: raw local, redacted egress.
        // Audit chain extension: for session_end records, apply chain fields
        // (previousHash + hash) so the chain captures *how* the session ended
        // via Claude Code's \`reason\` field. The chain still includes guard_*
        // decisions written by appendGuardDecision; session_end is just the
        // second chained record type. Maps to OWASP ASI11. Verify with:
        //   interlinked audit verify
        withFileMutationLock(ACTIVITY_PATH, function() {
            if (AUDIT_GUARD_TYPES[record.type]) {
                record.previousHash = readPreviousGuardHash();
                record.hash = computeAuditHash(record);
            }
            appendFileSync(ACTIVITY_PATH, JSON.stringify(record) + "\\n");
        });
    } catch (_err) { void 0; /* intentional: no-op */ }
}

function appendGuardDecision(decision, guardResult, event, hookEvent, sessionId, agentName, workspaceKey, projectKey, harnessMs) {
    try {
        const dir = dirname(ACTIVITY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const typeMap = { block: "guard_block", warn: "guard_warn", allow: "guard_allow" };
        const record = {
            schema_version: ACTIVITY_SCHEMA_VERSION,
            ts: new Date().toISOString(),
            agent: agentName || "unknown",
            workspace_key: workspaceKey || null,
            project_key: projectKey || null,
            type: typeMap[decision] || "guard_allow",
            tool: event.tool_name || null,
            summary: truncate(guardResult.reason || (guardResult.warnings || []).join("; ") || "allow", 500),
            session: sessionId || null,
            hook: hookEvent || null,
            guard_decision: decision,
            guard_rule_id: guardResult.rule_id || null,
            guard_severity: guardResult.severity || null,
            guard_category: guardResult.category || null,
            guard_reason: guardResult.reason || null,
            guard_warnings: guardResult.warnings || null,
            guard_harness_ms: typeof harnessMs === "number" ? harnessMs : null,
        };
        if (event.model) record.model = event.model;
        if (event.cwd) record.cwd = event.cwd;
        const guardGc = gitContext(event.cwd);
        if (guardGc.git_head) record.git_head = guardGc.git_head;
        if (guardGc.git_branch) record.git_branch = guardGc.git_branch;
        // Enriched data from harness (PostToolUse check results, timing, grep stats)
        if (guardResult.check_results) record.guard_check_results = guardResult.check_results;
        if (guardResult.checks_timing_ms != null) record.guard_checks_timing_ms = guardResult.checks_timing_ms;
        if (guardResult.checks_ran) record.guard_checks_ran = guardResult.checks_ran;
        if (guardResult.grep_stats) record.guard_grep_stats = guardResult.grep_stats;
        // Hash chain (OWASP ASI11): previousHash links to the most recent
        // hash-bearing guard_* entry; hash is sha256 over canonical JSON of
        // every field except 'hash' itself. Verify with: interlinked audit verify.
        withFileMutationLock(ACTIVITY_PATH, function() {
            record.previousHash = readPreviousGuardHash();
            record.hash = computeAuditHash(record);
            appendFileSync(ACTIVITY_PATH, JSON.stringify(record) + "\\n");
        });
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// Sync-errors log rotation: keep file under SYNC_ERRORS_MAX_BYTES
// (default 10 MB). On rollover, rename current → .1 (overwriting any
// existing .1 — single-generation retention) and start fresh. Without
// this cap, a long-running agent with a flaky network can grow this
// file by ~100 bytes/event for every realtime POST that fails — the
// real production observation was 3 GB on a single workspace.
const SYNC_ERRORS_MAX_BYTES = 10 * 1024 * 1024;
// Realtime sync is observability, not the safety path. Keep network work
// tightly bounded inside hook processes so slash commands and tool gates do
// not wait behind a slow or unreachable server.
const REALTIME_POST_TIMEOUT_MS = 500;
const REALTIME_RETRY_TIMEOUT_MS = 250;
const REALTIME_RETRY_MAX_PER_HOOK = 3;

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function rotateSyncErrorsIfNeeded() {
    try {
        if (!existsSync(SYNC_ERRORS_PATH)) return;
        const size = statSync(SYNC_ERRORS_PATH).size;
        if (size < SYNC_ERRORS_MAX_BYTES) return;
        const archived = SYNC_ERRORS_PATH + ".1";
        if (existsSync(archived)) {
            try { unlinkSync(archived); } catch (_err) { void 0; /* intentional: no-op */ }
        }
        renameSync(SYNC_ERRORS_PATH, archived);
    } catch (_err) { void 0; /* intentional: rotation is best-effort */ }
}

function appendSyncError(stage, message) {
    try {
        const dir = dirname(SYNC_ERRORS_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        rotateSyncErrorsIfNeeded();
        appendFileSync(
            SYNC_ERRORS_PATH,
            JSON.stringify({
                ts: new Date().toISOString(),
                stage,
                message: truncate(String(message || ""), 400),
            }) + "\\n",
        );
    } catch (_err) { void 0; /* intentional: no-op */ }
}

function enqueueRealtimeRetry(payload) {
    try {
        const dir = dirname(REALTIME_RETRY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(REALTIME_RETRY_PATH, JSON.stringify(payload) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

async function flushRealtimeRetry(serverUrl, authHeader) {
    try {
        if (!existsSync(REALTIME_RETRY_PATH)) return;
        const lines = readFileSync(REALTIME_RETRY_PATH, "utf-8").split("\\n").filter(Boolean);
        if (lines.length === 0) return;

        const remaining = [];
        let attempted = 0;
        for (const line of lines) {
            if (attempted >= REALTIME_RETRY_MAX_PER_HOOK) {
                remaining.push(line);
                continue;
            }
            let payload = null;
            try { payload = JSON.parse(line); } catch (_err) { void 0; /* intentional: no-op */ }
            if (!payload) continue;
            attempted++;
            try {
                const res = await fetchWithTimeout(serverUrl + "/api/hooks/activity", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(authHeader ? { Authorization: authHeader } : {}),
                    },
                    body: JSON.stringify(payload),
                }, REALTIME_RETRY_TIMEOUT_MS);
                if (!res.ok) {
                    remaining.push(line);
                    appendSyncError("realtime_retry_http", "status " + res.status);
                }
            } catch (e) {
                remaining.push(line);
                appendSyncError(
                    "realtime_retry_network",
                    e instanceof Error ? e.message : String(e),
                );
            }
        }

        writeFileSync(
            REALTIME_RETRY_PATH,
            remaining.length > 0 ? (remaining.join("\\n") + "\\n") : "",
        );
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// Compact target for tool_sequence entries. file_path → basename for file
// tools, first command word for Bash, first 30 chars of pattern for Grep,
// host for WebFetch. Empty string means "no target" (caller drops the
// suffix).
function sessionTarget(event) {
    const ti = event.tool_input || {};
    const tn = event.tool_name || "";
    if (typeof ti.file_path === "string" && ti.file_path) {
        const parts = ti.file_path.split("/");
        return parts[parts.length - 1] || ti.file_path;
    }
    if (typeof ti.path === "string" && ti.path) {
        const parts = ti.path.split("/");
        return parts[parts.length - 1] || ti.path;
    }
    if (typeof ti.command === "string" && ti.command) {
        const first = ti.command.trim().split(/\\s+/)[0] || "";
        return first.slice(0, 30);
    }
    if (typeof ti.pattern === "string" && ti.pattern) return ti.pattern.slice(0, 30);
    if (typeof ti.url === "string" && ti.url) {
        const m = ti.url.match(/^https?:\\/\\/([^/]+)/);
        return m ? m[1] : ti.url.slice(0, 30);
    }
    if (typeof ti.query === "string" && ti.query) return ti.query.slice(0, 30);
    return tn === "Bash" ? "?" : "";
}

// --- Capture code edit from PostToolUse Edit/Write ---
function captureCodeEdit(sessionId, agentName, event) {
    if (!sessionId) return;
    const toolName = event.tool_name;
    if (toolName !== "Edit" && toolName !== "Write") return;
    const toolInput = event.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || null;
    if (!filePath) return;

    const MAX_DIFF_SIZE = 10240; // 10KB cap per string
    const edit = {
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        agent_name: agentName || "unknown",
        file: filePath,
        tool: toolName,
        lines_added: 0,
        lines_removed: 0,
    };

    if (toolName === "Edit") {
        const oldStr = toolInput.old_string || "";
        const newStr = toolInput.new_string || "";
        const oldLines = oldStr ? oldStr.split("\\n").length : 0;
        const newLines = newStr ? newStr.split("\\n").length : 0;
        edit.lines_added = Math.max(0, newLines - oldLines);
        edit.lines_removed = Math.max(0, oldLines - newLines);
        if (oldStr.length <= MAX_DIFF_SIZE) edit.old_string = oldStr;
        if (newStr.length <= MAX_DIFF_SIZE) edit.new_string = newStr;
    } else {
        // Write: count lines, don't store full content
        const content = toolInput.content || "";
        edit.lines_added = content ? content.split("\\n").length : 0;
        edit.full_write = true;
    }

    // Append to session state
    try {
        const sessionPath = safeSessionFilePath(sessionId, ".json");
        if (!sessionPath) return;
        let state = null;
        if (existsSync(sessionPath)) {
            try { state = JSON.parse(readFileSync(sessionPath, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }
        }
        if (!state) return;
        if (!state.edits) state.edits = [];
        state.edits.push(edit);

        // Update per-agent contribution
        if (!state.by_agent) state.by_agent = {};
        const contrib = state.by_agent[edit.agent_name] || {
            agent_name: edit.agent_name,
            session_id: sessionId,
            files_touched: [],
            total_added: 0,
            total_removed: 0,
            edit_count: 0,
        };
        contrib.total_added += edit.lines_added;
        contrib.total_removed += edit.lines_removed;
        contrib.edit_count += 1;
        if (!contrib.files_touched.includes(edit.file)) contrib.files_touched.push(edit.file);
        state.by_agent[edit.agent_name] = contrib;

        writeFileSync(sessionPath, JSON.stringify(state) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// --- Git SHA validation (prevents argument injection into git invocations) ---
// Session state is loaded from an on-disk JSON file under .interlinked/sessions/;
// a prompt-injected agent with a Write primitive can attempt to stage a crafted
// state file, so any string that flows into a git subprocess must be validated
// as a real object name before use. Git SHAs are 7–40 lowercase hex chars
// (short and long forms); we also reject leading "-" so the value can never be
// misparsed as an option even if argv semantics change.
function isGitSha(v) {
    return typeof v === "string" && /^[0-9a-fA-F]{7,40}$/.test(v) && v[0] !== "-";
}

// --- Session-end commit reconciliation ---
function reconcileCommits(sessionId) {
    if (!sessionId) return;
    try {
        const sessionPath = safeSessionFilePath(sessionId, ".json");
        if (!sessionPath) return;
        if (!existsSync(sessionPath)) return;
        let state = null;
        try { state = JSON.parse(readFileSync(sessionPath, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }
        if (!state || !state.session_start_head) return;
        if (!isGitSha(state.session_start_head)) return;
        if (!state.edits || state.edits.length === 0) return;

        // Collect files we edited in this session
        const editedFiles = new Set(state.edits.map(e => e.file));

        // Find commits since session start. execFileSync (argv, not shell) plus
        // isGitSha() validation eliminates shell-metachar injection via state.
        let commitLog = "";
        try {
            commitLog = execFileSync(
                "git",
                ["log", state.session_start_head + "..HEAD", "--format=%H %s", "--no-merges"],
                { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
            ).trim();
        } catch { return; }
        if (!commitLog) return;

        const commits = [];
        for (const line of commitLog.split("\\n")) {
            if (!line.trim()) continue;
            const spaceIdx = line.indexOf(" ");
            if (spaceIdx < 0) continue;
            const hash = line.slice(0, spaceIdx);
            const message = line.slice(spaceIdx + 1);
            // Defense in depth: git should only emit a 40-char hex hash here,
            // but belt-and-suspenders guards against corrupted state files.
            if (!isGitSha(hash)) continue;

            // Get files in this commit
            let nameOnly = "";
            try {
                nameOnly = execFileSync(
                    "git",
                    ["diff", hash + "~1", hash, "--name-only"],
                    { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
                ).trim();
            } catch { continue; }

            const commitFiles = nameOnly.split("\\n").filter(f => f.trim());
            // File-overlap filter: only attribute commits touching files we edited
            const overlap = commitFiles.filter(f => {
                for (const ef of editedFiles) {
                    if (ef.endsWith(f) || f.endsWith(ef) || ef.includes(f) || f.includes(ef)) return true;
                }
                return false;
            });
            if (overlap.length === 0) continue;

            // Get numstat for attribution
            let numstat = "";
            try {
                numstat = execFileSync(
                    "git",
                    ["diff", hash + "~1", hash, "--numstat"],
                    { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
                ).trim();
            } catch { continue; }

            const files = [];
            for (const nline of numstat.split("\\n")) {
                const parts = nline.split("\\t");
                if (parts.length < 3) continue;
                const added = parseInt(parts[0], 10) || 0;
                const removed = parseInt(parts[1], 10) || 0;
                const file = parts[2];
                // Proportional attribution from tracked edits
                const agents = {};
                for (const edit of (state.edits || [])) {
                    if (edit.file.endsWith(file) || file.endsWith(edit.file) || edit.file.includes(file) || file.includes(edit.file)) {
                        if (!agents[edit.agent_name]) agents[edit.agent_name] = { added: 0, removed: 0 };
                        agents[edit.agent_name].added += edit.lines_added;
                        agents[edit.agent_name].removed += edit.lines_removed;
                    }
                }
                const totalTracked = Object.values(agents).reduce((s, a) => s + a.added + a.removed, 0);
                const agentList = Object.entries(agents).map(([name, a]) => ({
                    agent_name: name,
                    added: a.added,
                    removed: a.removed,
                    percentage: totalTracked > 0 ? Math.round(((a.added + a.removed) / totalTracked) * 100) : 100,
                }));
                if (agentList.length === 0) {
                    agentList.push({ agent_name: state.agent || "unknown", added, removed, percentage: 100 });
                }
                files.push({ file, net_added: added, net_removed: removed, agents: agentList });
            }

            commits.push({
                commit_hash: hash,
                timestamp: new Date().toISOString(),
                message,
                files,
            });
        }

        if (commits.length > 0) {
            state.commits = (state.commits || []).concat(commits);
            // Dedup by commit_hash
            const seen = new Set();
            state.commits = state.commits.filter(c => {
                if (seen.has(c.commit_hash)) return false;
                seen.add(c.commit_hash);
                return true;
            });
            writeFileSync(sessionPath, JSON.stringify(state) + "\\n");
        }
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// --- Turn ID stamping ---
// A "turn" is the unit of work between two user_prompt events. We persist a
// {session_id → turn_id} cursor so every tool/guard/post event between two
// prompts shares an identifier. Without this, "how many tools did the agent
// use to answer prompt X?" is unanswerable from activity.jsonl alone.
const TURN_CURSOR_PATH = join(DATA_DIR, "turn-cursor.json");
function readTurnCursor() {
    if (!existsSync(TURN_CURSOR_PATH)) return {};
    try { return JSON.parse(readFileSync(TURN_CURSOR_PATH, "utf-8")) || {}; }
    catch (_err) { return {}; }
}
function writeTurnCursor(cursor) {
    try {
        writeFileSync(TURN_CURSOR_PATH, JSON.stringify(cursor));
    } catch (_err) { void 0; /* intentional: no-op */ }
}
function stampTurnId(sessionId, event) {
    if (!sessionId) return;
    if (event.event_type === "user_prompt") {
        // Mint a new turn id keyed on this session.
        const cursor = readTurnCursor();
        const turnId = sessionId.slice(0, 8) + "-" + Date.now().toString(36);
        cursor[sessionId] = turnId;
        // Bound the cursor file: keep only the last 50 sessions.
        const keys = Object.keys(cursor);
        if (keys.length > 50) {
            for (const k of keys.slice(0, keys.length - 50)) delete cursor[k];
        }
        writeTurnCursor(cursor);
        event.turn_id = turnId;
        return;
    }
    // For all other events, attach the current turn id (if any).
    const cursor = readTurnCursor();
    if (cursor[sessionId]) event.turn_id = cursor[sessionId];
}

// --- Session state update (v2: tokens, subagents) ---
function updateSessionState(sessionId, agentName, event) {
    if (!sessionId) return;
    try {
        if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
        const filePath = safeSessionFilePath(sessionId, ".json");
        if (!filePath) return;
        let existing = null;
        if (existsSync(filePath)) {
            try { existing = JSON.parse(readFileSync(filePath, "utf-8")); } catch (_err) { void 0; /* intentional: no-op */ }
        }
        const now = new Date().toISOString();
        const isEnd = event.event_type === "session_end" || event.event_type === "agent_stop";
        const isTool = event.event_type === "tool_use" || event.event_type === "tool_use_start";
        const isError = event.event_type === "tool_use_error";
        const isSubagentStart = event.event_type === "subagent_start";
        const isSubagentStop = event.event_type === "subagent_stop";

        const toolsUsed = existing?.tools_used || {};
        if (isTool && event.tool_name) toolsUsed[event.tool_name] = (toolsUsed[event.tool_name] || 0) + 1;

        // Tool sequence — ordered list of tool invocations. Distinct from the
        // count map above: order is what reveals retry-loops and thrashing.
        // Capped at 500 entries (sliding window) so long sessions don't
        // unbound the JSON file.
        const toolSequence = existing?.tool_sequence || [];
        if (isTool && event.tool_name && event.event_type === "tool_use") {
            const target = sessionTarget(event);
            const entry = target ? (event.tool_name + ":" + target) : event.tool_name;
            toolSequence.push(entry);
            if (toolSequence.length > 500) toolSequence.splice(0, toolSequence.length - 500);
        }

        const filesTouched = new Set(existing?.files_touched || []);
        if (isTool && event.tool_name && ["Read","Write","Edit","Update","ReadFile","WriteFile","EditFile","read_file","write_file","edit_file"].includes(event.tool_name) && event.tool_input_summary) {
            filesTouched.add(event.tool_input_summary);
        }

        // Track subagent state
        if (isSubagentStart && event.tool_name) {
            activeSubagent = event.tool_name;
        }
        if (isSubagentStop && event.tool_name) {
            activeSubagent = null;
        }

        // Accumulate token totals
        const tokensTotal = existing?.tokens_total || { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
        let tokenEvents = existing?.token_events || 0;
        if (event.tokens) {
            tokensTotal.input += event.tokens.input || 0;
            tokensTotal.output += event.tokens.output || 0;
            tokensTotal.cache_read += event.tokens.cache_read || 0;
            tokensTotal.cache_creation += event.tokens.cache_creation || 0;
            tokenEvents += 1;
        }

        // Track per-subagent state
        const subagents = existing?.subagents || {};
        if (activeSubagent && isTool) {
            if (!subagents[activeSubagent]) {
                subagents[activeSubagent] = { files_touched: [], tools_used: {}, tool_count: 0 };
            }
            const sa = subagents[activeSubagent];
            sa.tool_count += 1;
            if (event.tool_name) sa.tools_used[event.tool_name] = (sa.tools_used[event.tool_name] || 0) + 1;
            if (event.tool_name && ["Read","Write","Edit","Update","ReadFile","WriteFile","EditFile","read_file","write_file","edit_file"].includes(event.tool_name) && event.tool_input_summary) {
                if (!sa.files_touched.includes(event.tool_input_summary)) sa.files_touched.push(event.tool_input_summary);
            }
        }
        if (isSubagentStop && event.tool_name && subagents[event.tool_name] && event.tokens) {
            subagents[event.tool_name].tokens = {
                input: (subagents[event.tool_name].tokens?.input || 0) + (event.tokens.input || 0),
                output: (subagents[event.tool_name].tokens?.output || 0) + (event.tokens.output || 0),
            };
        }

        // Capture git HEAD on session start for commit reconciliation
        let sessionStartHead = existing?.session_start_head || null;
        if (!existing && event.event_type === "session_start") {
            try {
                sessionStartHead = execSync("git rev-parse HEAD 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
            } catch (_err) { void 0; /* intentional: no-op */ }

            // Phase 1 Workstream B — full session-start anchor.
            // \`git stash create\` writes a stash commit to the object DB
            // representing the working-tree + index state WITHOUT modifying
            // refs or the working tree itself. Combined with the untracked
            // file list (which stash-create excludes by default), it gives
            // a SHA pointer plus path list sufficient to reconstruct the
            // world-state at session start. All shell args validated as
            // SHAs / sanitized paths before any further interpolation.
            try {
                const SHA_RE = /^[0-9a-f]{40}$/;
                const BRANCH_RE = /^[A-Za-z0-9._/\\-]+$/;
                let worktreeSha = null;
                try {
                    const out = execSync("git stash create 2>/dev/null", { encoding: "utf-8", timeout: 5000 }).trim();
                    if (out && SHA_RE.test(out)) worktreeSha = out;
                } catch (_e) { void 0; /* intentional: clean tree → empty stdout, not an error */ }
                let untracked = [];
                try {
                    const out = execSync("git ls-files --others --exclude-standard 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
                    untracked = out.split("\\n").map((l) => l.trim()).filter(Boolean).slice(0, 5000);
                } catch (_e) { void 0; }
                let branch = null;
                try {
                    const out = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
                    if (out && BRANCH_RE.test(out)) branch = out;
                } catch (_e) { void 0; }
                const anchor = {
                    schema: 1,
                    session_id: sessionId,
                    captured_at: now,
                    head: sessionStartHead && SHA_RE.test(sessionStartHead) ? sessionStartHead : null,
                    worktree: worktreeSha,
                    branch,
                    untracked,
                };
                try {
                    const anchorPath = safeSessionFilePath(sessionId, ".anchor.json");
                    if (!anchorPath) return;
                    writeFileSync(anchorPath, JSON.stringify(anchor) + "\\n");
                } catch (_e) { void 0; /* intentional: anchor capture is best-effort */ }
            } catch (_err) { void 0; /* intentional: best-effort */ }
        }

        const state = {
            session_id: sessionId,
            agent: agentName || existing?.agent || "unknown",
            phase: isEnd ? "ENDED" : "ACTIVE",
            started_at: existing?.started_at || now,
            last_event_at: now,
            tool_count: (existing?.tool_count || 0) + (isTool ? 1 : 0),
            error_count: (existing?.error_count || 0) + (isError ? 1 : 0),
            files_touched: [...filesTouched],
            tools_used: toolsUsed,
            tool_sequence: toolSequence,
        };
        if (event.parent_session_id) state.parent_session_id = event.parent_session_id;
        // Only include v2 fields if they have data
        const hasTokens = tokensTotal.input > 0 || tokensTotal.output > 0;
        if (hasTokens) state.tokens_total = tokensTotal;
        if (tokenEvents > 0) state.token_events = tokenEvents;
        if (Object.keys(subagents).length > 0) state.subagents = subagents;
        // Preserve v3 code activity fields
        if (sessionStartHead) state.session_start_head = sessionStartHead;
        if (existing?.edits) state.edits = existing.edits;
        if (existing?.by_agent) state.by_agent = existing.by_agent;
        if (existing?.commits) state.commits = existing.commits;

        writeFileSync(filePath, JSON.stringify(state) + "\\n");
    } catch (_err) { void 0; /* intentional: no-op */ }
}

// --- Batch sync: read unsynced events and POST in chunks ---
async function batchSync(serverUrl, authHeader, workspaceId, workspaceKey, projectKey, agentName) {
    try {
        if (!existsSync(ACTIVITY_PATH)) return;

        // Read sync cursor
        let syncedBytes = 0;
        if (existsSync(SYNC_STATE_PATH)) {
            try {
                const state = JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8"));
                syncedBytes = state.synced_through_bytes || 0;
            } catch (_err) { void 0; /* intentional: no-op */ }
        }

        const fileSize = statSync(ACTIVITY_PATH).size;
        if (syncedBytes >= fileSize) return;

        // Read from cursor to EOF
        const bytesToRead = fileSize - syncedBytes;
        const fd = openSync(ACTIVITY_PATH, "r");
        const buffer = Buffer.alloc(bytesToRead);
        readSync(fd, buffer, 0, bytesToRead, syncedBytes);
        closeSync(fd);

        const chunk = buffer.toString("utf-8");
        const lines = chunk.split("\\n").filter(Boolean);
        const events = [];
        for (const line of lines) {
            try {
                const e = JSON.parse(line);
                const ev = {
                    agent_name: e.agent || agentName || "unknown",
                    workspace_key: e.workspace_key || workspaceKey || undefined,
                    project_key: e.project_key || projectKey || undefined,
                    event_type: e.type || "unknown",
                    tool_name: e.tool || null,
                    tool_input_summary: e.summary || null,
                    occurred_at: e.ts || new Date().toISOString(),
                };
                // v2 fields
                if (e.duration_ms) ev.duration_ms = e.duration_ms;
                if (e.tokens?.input) ev.tokens_input = e.tokens.input;
                if (e.tokens?.output) ev.tokens_output = e.tokens.output;
                if (e.tokens?.cache_read) ev.tokens_cache_read = e.tokens.cache_read;
                if (e.tokens?.cache_creation) ev.tokens_cache_creation = e.tokens.cache_creation;
                if (e.parent_agent) ev.parent_agent = e.parent_agent;
                if (e.subagent_id) ev.subagent_id = e.subagent_id;
                if (e.files_modified) ev.files_modified = e.files_modified;
                // v3 fields
                if (e.hook) ev.hook_event = e.hook;
                if (e.error) ev.error_message = String(e.error);
                if (e.error) ev.error_detail = String(e.error);
                // v4 full-capture fields
                if (e.tool_input !== undefined) ev.tool_input_json = typeof e.tool_input === "string" ? e.tool_input : JSON.stringify(e.tool_input);
                if (e.tool_response !== undefined) ev.tool_response_json = typeof e.tool_response === "string" ? e.tool_response : JSON.stringify(e.tool_response);
                if (e.prompt) ev.prompt = e.prompt;
                if (e.last_assistant_message) ev.last_assistant_message = e.last_assistant_message;
                if (e.cwd) ev.cwd = e.cwd;
                if (e.model) ev.model = e.model;
                if (e.source) ev.source = e.source;
                if (e.agent_type) ev.agent_type_hook = e.agent_type;
                if (e.tool_use_id) ev.tool_use_id = e.tool_use_id;
                if (e.session) ev.session_id = e.session;
                if (e.is_interrupt !== undefined) ev.is_interrupt = e.is_interrupt;
                if (e.notification_type) ev.notification_type = e.notification_type;
                if (e.notification_title) ev.notification_title = e.notification_title;
                if (e.task_subject) ev.task_subject = e.task_subject;
                if (e.task_id) ev.task_id_hook = e.task_id;
                if (e.task_description) ev.task_description_hook = e.task_description;
                if (e.trigger) ev.trigger = e.trigger;
                if (e.reason) ev.reason = e.reason;
                if (e.permission_mode) ev.permission_mode = e.permission_mode;
                if (e.transcript_path) ev.transcript_path = e.transcript_path;
                if (e.teammate_name) ev.teammate_name = e.teammate_name;
                if (e.team_name) ev.team_name = e.team_name;
                if (e.custom_instructions) ev.custom_instructions = e.custom_instructions;
                if (e.stop_hook_active !== undefined) ev.stop_hook_active = e.stop_hook_active;
                if (e.permission_suggestions) ev.permission_suggestions = typeof e.permission_suggestions === "string" ? e.permission_suggestions : JSON.stringify(e.permission_suggestions);
                if (e.agent_transcript_path) ev.agent_transcript_path = e.agent_transcript_path;
                if (e.thinking) ev.thinking = e.thinking;
                // Scrub secrets before sending to server
                scrubPayload(ev);
                events.push(ev);
            } catch (_err) { void 0; /* intentional: no-op */ }
        }

        if (events.length === 0) return;

        // POST in 100-event chunks
        const CHUNK_SIZE = 100;
        let allSuccess = true;
        for (let i = 0; i < events.length; i += CHUNK_SIZE) {
            const batch = events.slice(i, i + CHUNK_SIZE);
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);
                const res = await fetch(serverUrl + "/api/hooks/activity/batch", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(authHeader ? { Authorization: authHeader } : {}),
                    },
                    signal: controller.signal,
                    body: JSON.stringify({
                        workspace_uuid: workspaceId,
                        workspace_key: workspaceKey || undefined,
                        project_key: projectKey || undefined,
                        events: batch,
                    }),
                });
                clearTimeout(timeout);
                if (!res.ok) {
                    appendSyncError("batch_sync_http", "status " + res.status);
                    allSuccess = false;
                    break;
                }
            } catch (e) {
                appendSyncError(
                    "batch_sync_network",
                    e instanceof Error ? e.message : String(e),
                );
                allSuccess = false;
                break;
            }
        }

        // Advance cursor only if all batches succeeded
        if (allSuccess) {
            writeFileSync(SYNC_STATE_PATH, JSON.stringify({
                synced_through_bytes: fileSize,
                last_sync_at: new Date().toISOString(),
            }) + "\\n");
        }
    } catch (e) {
        appendSyncError(
            "batch_sync_error",
            e instanceof Error ? e.message : String(e),
        );
        // Swallow — never block the agent
    }
}`;
