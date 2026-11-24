import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Run your Session Startup sequence - read the required files before responding to the user. If a runtime block such as [ELYTRAS TENANCY CONTEXT] is present, make your first real reply a short summary of the resolved runtime context instead of a generic greeting. Include the resolved user, role, team, active project if any, matched external identity, and current channel when available. If that runtime block is unresolved, ambiguous, or blocked, say that explicitly in the first reply. Only fall back to a normal persona greeting when no authoritative runtime context is present. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-4 sentences. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 */
export function buildBareSessionResetPrompt(cfg?: OpenClawConfig, nowMs?: number): string {
  return appendCronStyleCurrentTimeLine(
    BARE_SESSION_RESET_PROMPT_BASE,
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
