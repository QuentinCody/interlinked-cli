// Public, runtime-neutral hook integration API. No Node imports or implicit
// network/storage access: the owning application supplies policy and storage.
export { createThinkHookBridge } from "./think.js";
export type { BridgeOptions, HookBridgeIdentity } from "./think.js";
export type { ThinkHookBridge, ThinkToolCall, ThinkToolDecision, ToolPolicyDecision, HookToolReceipt, HookBridgeJournal, ToolJournalEntry } from "./think.js";
export { createDurableHookJournal } from "./durable-journal.js";
export type { JournalStorage } from "./durable-journal.js";
export type { HookRuntimeIdentity, HookOutcome, HookControl, HookTranslation } from "../../harness/adapters/hook-contract.js";
