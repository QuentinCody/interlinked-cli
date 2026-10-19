import type { HarnessEvent } from "./types.js";

interface EventAttributionFields {
    subagent_id?: string;
    model?: string;
    parent_agent?: string;
    /** `HarnessEvent.dry_run` — the ONE simulation flag (`interlinked harness
     *  test` sets it; transient-debt-guard, ephemeral-write-log and every other
     *  persisting evaluator honor it). Stamped on every row the event produces
     *  so a log reader never counts a simulated probe as an executed call. */
    dry_run?: true;
}

/** Shared optional attribution projection. Keeping the branches here prevents
 * every observability writer from independently growing its hot-path score. */
export function eventAttributionFields(event: HarnessEvent): EventAttributionFields {
    const fields: EventAttributionFields = {};
    if (event.subagent_id) fields.subagent_id = event.subagent_id;
    if (event.model) fields.model = event.model;
    if (event.parent_agent) fields.parent_agent = event.parent_agent;
    if (event.dry_run === true) fields.dry_run = true;
    return fields;
}
