/**
 * Model, system prompt, tools and stream wiring for the capacity intake
 * agent. Kept separate from the Durable Object so they can be exercised
 * directly.
 */
import { createWorkersAI } from "workers-ai-provider";
import {
  simulateStreamingMiddleware,
  stepCountIs,
  tool,
  wrapLanguageModel,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type ModelMessage,
  type StreamTextTransform,
  type ToolSet
} from "ai";
import { z } from "zod";
import {
  REGIONS,
  applyGiveBack,
  buildRequestRecord,
  calculateCapex,
  calculateResources,
  formatMoney,
  listDataCenters,
  summaryTable,
  validateDetails,
  type RequestDetails,
  type RequestRecord
} from "./capacity";

// Workers AI model (free-plan eligible, supports function calling).
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Llama 3.3's streamed tool-call deltas arrive duplicated/interleaved through
 * workers-ai-provider, producing invalid arguments. simulateStreamingMiddleware
 * runs each step non-streamed and replays it as a stream, so the chat UI still
 * receives a normal UI message stream.
 */
export function createModel(ai: Ai, sessionAffinity?: string) {
  const workersai = createWorkersAI({ binding: ai });
  return wrapLanguageModel({
    model: workersai(MODEL, { sessionAffinity }),
    middleware: simulateStreamingMiddleware()
  });
}

export const SYSTEM_PROMPT = `You are an on-prem capacity intake coordinator. You take infrastructure capacity requests for the company's OWN data centers (not public cloud).

Collect, asking for missing details one or two at a time:
- The need: either hosts x per-host spec (cores, memory GB, disk TB per host), or totals of cores, memory and disk. If the user gives a host count without a per-host spec, ask for cores, memory and disk per host.
- Region (Americas, EMEA or APAC) and data center within that region. Call listDataCenters with the region and data center to check it. If it is not valid, say so and list the valid ones from the tool result.
- Requester details, all required: App name, App ID, Business Unit, Requester (owner), MD approver name, Environment (prod or non-prod).

Flow:
1. When you have the full need, call calculateResources. The server then calculates capex and shows the user a capacity estimate block followed by the give-back question.
2. When the user answers the give-back question, call applyGiveBack. If the give-back is a host count, first ask how many cores each returned host has. Do not assume returned hosts match the new hosts. Accept mixed groups (e.g. 20 x 12 cores and 20 x 24 cores). If there is no give-back, call applyGiveBack with giveBackCores 0.
3. Make sure you have every requester detail, region and data center. Ask for anything missing. Never fill in "unknown" or a guess.
4. Call buildSummary with the requester details, region and data center. The server shows the summary table and asks the user to Approve or Reject submission with buttons.
5. If the user clicks Reject, ask what they want to change. Do not call submitRequest again until buildSummary has been called with the changes (or the user asks to submit as is).

Rules:
- Never guess or invent numbers or details. Never do arithmetic yourself.
- Blocks marked as already shown to the user (capacity estimate, give-back, summary, submission) are displayed by the server. Do not repeat or rewrite them.
- Capex is based on cores only. Memory and disk are not priced.
- Write numbers with thousands separators (1,600) and money in $200K style.
- Pass numbers as JSON numbers, not strings.
- If a tool returns ok: false, explain the error briefly and ask for what is needed.
- Keep replies plain and short.`;

// ── Lenient input parsing ────────────────────────────────────────────
// Llama often sends numbers as strings ("50", "1,600") and arrays as JSON
// strings. Normalise those before validation instead of failing the call.

const toNumber = (v: unknown) => {
  if (typeof v !== "string") return v;
  const s = v.replace(/,/g, "").trim();
  if (s === "") return v;
  const n = Number(s);
  return Number.isNaN(n) ? v : n;
};

const parseJsonString = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const num = () => z.preprocess(toNumber, z.number());
const optNum = () => z.preprocess(toNumber, z.number().nullish());

// ── Server-side draft ────────────────────────────────────────────────
// Everything that gets saved comes from earlier tool results held on the
// server, never from what the model passes to submitRequest.

export interface Draft {
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  giveBackCores: number | null;
  /** Validated details from the last buildSummary (null until built). */
  details: RequestDetails | null;
}

export interface DraftStore {
  get(): Draft | null;
  set(draft: Draft | null): void;
  /** Persists the record and returns its CAP-#### ID. */
  saveRequest(record: RequestRecord): string;
}

/** Read-only view of the conversation, used to ground requester details. */
export interface Conversation {
  /** Concatenated text of all user messages. */
  userText(): string;
}

const NO_DRAFT = {
  ok: false as const,
  error:
    "No resource totals yet. Collect the need and call calculateResources first."
};

const NO_GIVE_BACK = {
  ok: false as const,
  error:
    "Give-back not recorded yet. Ask the give-back question and call applyGiveBack (giveBackCores 0 if none)."
};

/** Current draft as a record, or an error explaining what is missing. */
function recordFromDraft(draft: Draft | null) {
  if (!draft) return NO_DRAFT;
  if (draft.giveBackCores === null) return NO_GIVE_BACK;
  if (!draft.details) {
    return {
      ok: false as const,
      error: "No summary yet. Call buildSummary first."
    };
  }
  return buildRequestRecord(draft.details, {
    totalCores: draft.totalCores,
    totalMemoryGB: draft.totalMemoryGB,
    totalDiskTB: draft.totalDiskTB,
    giveBackCores: draft.giveBackCores
  });
}

export function createCapacityTools(
  store: DraftStore,
  conversation: Conversation
) {
  return {
    listDataCenters: tool({
      description:
        "List on-prem regions and their data centers. Pass region (and optionally dataCenter) to check that a data center belongs to that region.",
      inputSchema: z.object({
        region: z
          .string()
          .nullish()
          .describe("Optional region: Americas, EMEA or APAC"),
        dataCenter: z
          .string()
          .nullish()
          .describe("Optional data center code to validate, e.g. USDC1")
      }),
      execute: async ({ region, dataCenter }) =>
        listDataCenters(region ?? undefined, dataCenter ?? undefined)
    }),

    calculateResources: tool({
      description:
        'Compute total cores, memory (GB) and disk (TB). Use mode "perHost" with hostCount, coresPerHost, memoryGBPerHost, diskTBPerHost; or mode "totals" with totalCores, totalMemory (+memoryUnit) and totalDisk (+diskUnit). Pass numbers exactly as the user stated them.',
      inputSchema: z.object({
        mode: z.enum(["perHost", "totals"]),
        hostCount: optNum(),
        coresPerHost: optNum(),
        memoryGBPerHost: optNum(),
        diskTBPerHost: optNum(),
        totalCores: optNum(),
        totalMemory: optNum(),
        memoryUnit: z
          .enum(["GB", "TB"])
          .nullish()
          .describe("Unit of totalMemory as the user stated it (default GB)"),
        totalDisk: optNum(),
        diskUnit: z
          .enum(["TB", "GB"])
          .nullish()
          .describe("Unit of totalDisk as the user stated it (default TB)")
      }),
      execute: async (input) => {
        const result = calculateResources({
          mode: input.mode,
          hostCount: input.hostCount ?? undefined,
          coresPerHost: input.coresPerHost ?? undefined,
          memoryGBPerHost: input.memoryGBPerHost ?? undefined,
          diskTBPerHost: input.diskTBPerHost ?? undefined,
          totalCores: input.totalCores ?? undefined,
          totalMemory: input.totalMemory ?? undefined,
          memoryUnit: input.memoryUnit ?? undefined,
          totalDisk: input.totalDisk ?? undefined,
          diskUnit: input.diskUnit ?? undefined
        });
        if (result.ok) {
          // New totals invalidate any earlier give-back and summary.
          store.set({
            totalCores: result.totalCores,
            totalMemoryGB: result.totalMemoryGB,
            totalDiskTB: result.totalDiskTB,
            giveBackCores: null,
            details: null
          });
        }
        return result;
      }
    }),

    calculateCapex: tool({
      description:
        "Calculate capex for the current request from its total cores (cores x per-core rate). Memory and disk are not priced. Runs automatically after calculateResources.",
      inputSchema: z.object({}),
      execute: async () => {
        const draft = store.get();
        if (!draft) return NO_DRAFT;
        return calculateCapex(draft);
      }
    }),

    applyGiveBack: tool({
      description:
        "Apply a core give-back from retiring hosts/apps to the current request and recalculate capex. Provide EITHER giveBackCores OR giveBackGroups (list of {hostCount, coresPerHost}).",
      inputSchema: z.object({
        giveBackCores: optNum(),
        giveBackGroups: z.preprocess(
          parseJsonString,
          z
            .array(
              z.object({
                hostCount: num(),
                coresPerHost: num()
              })
            )
            .nullish()
        )
      }),
      execute: async ({ giveBackCores, giveBackGroups }) => {
        const draft = store.get();
        if (!draft) return NO_DRAFT;
        const result = applyGiveBack({
          requestedCores: draft.totalCores,
          giveBackCores: giveBackCores ?? undefined,
          giveBackGroups: giveBackGroups ?? undefined
        });
        if (result.ok) {
          store.set({
            ...draft,
            giveBackCores: result.giveBackCores,
            details: null
          });
        }
        return result;
      }
    }),

    buildSummary: tool({
      description:
        "Validate the requester details, region and data center and show the final summary table to the user. Call once every detail has been given by the user and the give-back is applied.",
      inputSchema: z.object({
        appName: z.string(),
        appId: z.string(),
        businessUnit: z.string(),
        requester: z.string().describe("Requester / owner name"),
        mdApprover: z.string().describe("MD approver name"),
        // Plain string so a bad value gets a "please provide" reply from
        // validateDetails instead of a schema error card in the chat.
        environment: z.string().describe('"prod" or "non-prod"'),
        region: z.enum(REGIONS),
        dataCenter: z.string()
      }),
      execute: async (input) => {
        const draft = store.get();
        if (!draft) return NO_DRAFT;
        if (draft.giveBackCores === null) return NO_GIVE_BACK;
        const valid = validateDetails(input, conversation.userText());
        if (!valid.ok) return valid;
        const built = recordFromDraft({ ...draft, details: valid.details });
        if (!built.ok) return built;
        store.set({ ...draft, details: valid.details });
        return {
          ok: true as const,
          display: `**Summary**\n\n${summaryTable(built.record)}\n\nReview the request, then click **Approve** to submit it or **Reject** to make changes.`,
          note: "The summary table has already been shown to the user. Now call submitRequest; the user approves it with buttons."
        };
      }
    }),

    submitRequest: tool({
      description:
        "Submit the request summarized by buildSummary. Takes no arguments. The user must approve it with the Approve / Reject buttons.",
      inputSchema: z.object({}),
      // Ask for approval only when there is a valid summary to approve;
      // otherwise execute right away and return the error to the model.
      needsApproval: async () => recordFromDraft(store.get()).ok,
      execute: async () => {
        const draft = store.get();
        const built = recordFromDraft(draft);
        if (!built.ok) return built;
        // Re-check grounding at save time in case the transcript changed.
        const valid = validateDetails(built.record, conversation.userText());
        if (!valid.ok) return valid;
        const requestId = store.saveRequest(built.record);
        store.set(null);
        return {
          ok: true as const,
          requestId,
          ...built.record,
          display: `Request **${requestId}** submitted: ${built.record.appName} (${built.record.appId}), ${built.record.dataCenter}, capex ${formatMoney(built.record.capexAfter)} after give-back. MD approver ${built.record.mdApprover} is recorded on the request.`,
          note: "The confirmation with the request ID has already been shown to the user. Do not repeat it."
        };
      }
    })
  };
}

// ── Stream wiring ────────────────────────────────────────────────────

type CapacityTools = ReturnType<typeof createCapacityTools>;

type AnyStep = StepResult<ToolSet>;

/** Successful (ok !== false) results of a tool in a step. */
function okResult(step: AnyStep | undefined, toolName: keyof CapacityTools) {
  return step?.toolResults.some(
    (r) =>
      r.toolName === toolName &&
      (r.output as { ok?: boolean } | undefined)?.ok !== false
  );
}

/** True when the latest message is a denied (rejected) submitRequest. */
function submitJustRejected(messages: ModelMessage[]) {
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role !== "tool") return false;
  return lastMsg.content.some(
    (p) =>
      p.type === "tool-result" &&
      p.toolName === "submitRequest" &&
      p.output.type === "execution-denied"
  );
}

/**
 * Forces the next deterministic step: capex right after resources, and the
 * approval-gated submit right after the summary is shown.
 */
export const capacityPrepareStep: PrepareStepFunction<ToolSet> = ({
  steps,
  messages
}) => {
  // After the user clicks Reject, make the model answer in text (ask what
  // to change) instead of immediately calling submitRequest again.
  if (steps.length === 0 && submitJustRejected(messages)) {
    // Workers AI rejects an empty tools array, so keep one harmless tool
    // active and disable tool calls for this step.
    return { activeTools: ["listDataCenters"], toolChoice: "none" };
  }
  const last = steps[steps.length - 1];
  if (
    okResult(last, "calculateResources") &&
    !okResult(last, "calculateCapex")
  ) {
    return { toolChoice: { type: "tool", toolName: "calculateCapex" } };
  }
  if (okResult(last, "buildSummary")) {
    return { toolChoice: { type: "tool", toolName: "submitRequest" } };
  }
  return undefined;
};

/**
 * Ends the turn once the server has shown the capex block (which ends with
 * the give-back question) or the submit confirmation, so the model does not
 * talk over them.
 */
export const capacityStopWhen: StopCondition<ToolSet>[] = [
  stepCountIs(10),
  ({ steps }) => {
    const last = steps[steps.length - 1];
    const needsUser = last?.toolResults.some(
      (r) =>
        (r.output as { needsUserInput?: boolean } | undefined)
          ?.needsUserInput === true
    );
    return Boolean(
      okResult(last, "calculateCapex") ||
      okResult(last, "submitRequest") ||
      needsUser
    );
  }
];

/**
 * Adds thousands separators to bare integers of 4+ digits in model text
 * (1600 -> 1,600). Skips numbers that are part of IDs, codes, dates or
 * decimals, e.g. APP-10234, CAP-0001, USDC1, 2026-11-25, 12.5.
 */
export function addThousandsSeparators(text: string) {
  return text.replace(/(?<![\w.,\-/:#])\d{4,}(?![\w,]|[.\-/:]\d)/g, (digits) =>
    Number(digits).toLocaleString("en-US")
  );
}

/**
 * Stream transform that (1) writes each tool's ready-to-show `display` block
 * into the chat as assistant text right after the tool result, and
 * (2) formats numbers in model-written text.
 */
export const displayTransform: StreamTextTransform<ToolSet> = () => {
  let n = 0;
  // After Approve or Reject, the outcome is handled before the model's first
  // step, so stopWhen can't end the turn. The server shows a fixed message
  // and drops any model text that follows it.
  let silenced = false;
  return new TransformStream({
    transform(part, controller) {
      if (
        silenced &&
        (part.type === "text-start" ||
          part.type === "text-delta" ||
          part.type === "text-end")
      ) {
        return;
      }
      if (part.type === "text-delta") {
        controller.enqueue({
          ...part,
          text: addThousandsSeparators(part.text)
        });
        return;
      }
      controller.enqueue(part);
      if (
        part.type === "tool-output-denied" &&
        part.toolName === "submitRequest"
      ) {
        const id = `display-${part.toolCallId}-${n++}`;
        controller.enqueue({ type: "text-start", id });
        controller.enqueue({
          type: "text-delta",
          id,
          text: "Submission cancelled. Nothing was saved. What would you like to change?"
        });
        controller.enqueue({ type: "text-end", id });
        silenced = true;
      }
      if (part.type === "tool-result") {
        const output = part.output as
          | { ok?: boolean; display?: unknown }
          | undefined;
        if (typeof output?.display === "string") {
          const id = `display-${part.toolCallId}-${n++}`;
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, text: output.display });
          controller.enqueue({ type: "text-end", id });
        }
        if (part.toolName === "submitRequest" && output?.ok === true) {
          silenced = true;
        }
      }
    }
  });
};
