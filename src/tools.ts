/**
 * Model, system prompt, tools and stream wiring for the capacity intake
 * agent. Kept separate from the Durable Object so they can be exercised
 * directly.
 */
import { createWorkersAI } from "workers-ai-provider";
import {
  getToolName,
  isToolUIPart,
  simulateStreamingMiddleware,
  stepCountIs,
  tool,
  wrapLanguageModel,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type ModelMessage,
  type StreamTextTransform,
  type TextStreamPart,
  type UIMessage,
  type ToolSet
} from "ai";
import { z } from "zod";
import {
  applyGiveBack,
  buildRequestRecord,
  calculateCapex,
  calculateResources,
  checkDetails,
  formatMoney,
  listDataCenters,
  formatRequestId,
  lastCapId,
  normalizeRegion,
  parseCapId,
  regionGiven,
  splitLabel,
  splitRatioGiven,
  splitTable,
  summaryTable,
  usedDataCenters,
  validateSplit,
  type AllocationInput,
  type AssumedDefaults,
  type DcAllocation,
  type HostSpec,
  type Region,
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
- The need: either hosts x per-host spec (cores per host, memory per host or per core, disk per host), or totals of cores, memory and disk. Memory and disk must come from the user. Never invent or derive them.
- Region (Americas, EMEA or APAC). The user must state it. Never assume a region.
- How to split the request across the two data centers in that region (all in one, 50/50, or a host count per data center). The user must state it. Never assume a split.
- Requester details, all required: App name, App ID, Business Unit, Requester (owner), MD approver name, Environment (prod or non-prod).

Flow:
1. Call calculateResources with only the numbers and units the user gave, exactly as stated (e.g. memory per core -> memoryGBPerCore; "100GB disk per host" -> diskPerHost 100 with diskUnit "GB"). Leave out anything the user did not give. If the user says they don't know the memory or disk, set memoryUnknown / diskUnknown to true and leave the value out; the server applies its defaults. The server asks for anything still missing, or calculates capex and shows the capacity estimate and the give-back question.
2. When the user answers the give-back question, call applyGiveBack. If the give-back is a host count, first ask how many cores each returned host has. Do not assume returned hosts match the new hosts. Accept mixed groups (e.g. 20 x 12 cores and 20 x 24 cores). If there is no give-back, call applyGiveBack with giveBackCores 0.
3. When the user gives a region and split, call validateSplit with allocations as the user stated them: hosts per data center for host-based requests, percent per data center for totals-based requests.
4. Call buildSummary with every detail the user has given (leave out anything not given; never fill in "unknown" or a guess). The server either lists what is still missing or shows the summary and Approve / Reject buttons.
5. If the user clicks Reject, ask what they want to change.
6. If the user refers to an earlier request ID (CAP-2, CAP-002, CAP-0002), call lookupRequest. A CAP ID is never an App ID or App name.

Rules:
- Never guess or invent numbers or details. Never do arithmetic yourself.
- Blocks marked as already shown to the user are displayed by the server. Do not repeat or rewrite them.
- Capex and give-back apply to the total request. Capex is based on cores only; memory and disk are not priced.
- Write numbers with thousands separators (1,600) and money in $200K style.
- Pass numbers as JSON numbers, not strings.
- Keep replies plain and short.`;

// ── Lenient input parsing ────────────────────────────────────────────
// Llama often sends numbers as strings ("50", "1,600") and arrays as JSON
// strings. Normalise those before validation instead of failing the call.

/**
 * Lenient number parsing: "1,600" -> 1600, "32 cores" -> 32. Anything that
 * isn't a number becomes undefined (treated as "not given") rather than
 * failing the whole tool call with a schema error.
 */
const toNumber = (v: unknown) => {
  if (v === null || v === undefined) return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const m = v.replace(/(\d),(\d{3})/g, "$1$2").match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : undefined;
  }
  return undefined;
};

const parseJsonString = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const optNum = () => z.preprocess(toNumber, z.number().nullish());
/** Lenient boolean: true / "true" / "yes" / 1 -> true; anything else -> false. */
const toBool = (v: unknown) => {
  if (v === null || v === undefined) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(true|yes|y|1)$/i.test(v.trim());
  return false;
};
const optBool = () => z.preprocess(toBool, z.boolean().nullish());
/** Lenient unit: "gb", "GBs", "terabytes" -> GB / TB; anything else -> undefined. */
const toUnit = (v: unknown) => {
  if (typeof v !== "string") return v === null ? null : undefined;
  const u = v.trim().toLowerCase();
  if (u.startsWith("t")) return "TB";
  if (u.startsWith("g")) return "GB";
  return undefined;
};
const optUnit = () => z.preprocess(toUnit, z.enum(["GB", "TB"]).nullish());
const optText = () =>
  z.preprocess(
    (v) =>
      v === null || v === undefined || typeof v === "string" ? v : String(v),
    z.string().nullish()
  );

/**
 * Picks perHost vs totals from the model's `mode` text, or from which fields
 * it filled in. A host count without total cores means a per-host request.
 */
function inferMode(input: {
  mode?: string | null;
  hostCount?: number | null;
  coresPerHost?: number | null;
  memoryGBPerHost?: number | null;
  memoryGBPerCore?: number | null;
  diskPerHost?: number | null;
  totalCores?: number | null;
}): "perHost" | "totals" {
  const m = (input.mode ?? "").toLowerCase();
  if (input.totalCores == null && input.hostCount != null) return "perHost";
  if (m.includes("host")) return "perHost";
  if (m.includes("total")) return "totals";
  if (
    input.coresPerHost != null ||
    input.memoryGBPerHost != null ||
    input.memoryGBPerCore != null ||
    input.diskPerHost != null
  )
    return "perHost";
  return "totals";
}

// ── Server-side draft ────────────────────────────────────────────────
// Everything that gets saved comes from earlier tool results held on the
// server, never from what the model passes to submitRequest.

export interface Draft {
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  /** Memory/disk values filled in from defaults ("assumed default"). */
  assumed: AssumedDefaults;
  /** Per-host spec when the request was given in hosts (null for totals). */
  hostSpec: HostSpec | null;
  /** False between calculateResources and the capex block being shown. */
  capexShown?: boolean;
  giveBackCores: number | null;
  /** Validated region + DC split (null until validated). */
  location: { region: Region; split: DcAllocation[] } | null;
  /** Validated details from the last buildSummary (null until built). */
  details: RequestDetails | null;
}

/** Requester details that can be reused from an earlier CAP request. */
export type ReusableDetails = Pick<
  RequestDetails,
  "appName" | "appId" | "businessUnit" | "requester" | "mdApprover"
>;

/** A looked-up CAP request whose details the user may reuse. */
export interface Reuse {
  requestId: string;
  details: ReusableDetails;
  /** True once the user clicked Approve on the reuse offer. */
  confirmed: boolean;
}

export interface DraftStore {
  get(): Draft | null;
  set(draft: Draft | null): void;
  /** Persists the record and returns its CAP-#### ID. */
  saveRequest(record: RequestRecord): string;
  /** A saved request by its sequence number (CAP-0002 -> 2), or null. */
  findRequest(seq: number): ({ requestId: string } & ReusableDetails) | null;
  getReuse(): Reuse | null;
  setReuse(reuse: Reuse | null): void;
}

/** Read-only view of the conversation, used to ground requester details. */
export interface Conversation {
  /** Concatenated text of all user messages. */
  userText(): string;
  /** Text of the most recent user message. */
  latestUserText(): string;
}

/** Fixed replies after the user clicks Reject on an approval button. */
export const DENIAL_MESSAGES: Record<string, string> = {
  submitRequest:
    "Submission cancelled. Nothing was saved. What would you like to change?",
  reuseRequestDetails:
    "OK, I won't reuse those details. Please give the App name, App ID, Business Unit, Requester and MD approver."
};

/** Clears state tied to a rejected approval. */
export function handleDenial(toolName: string, store: DraftStore) {
  if (toolName === "reuseRequestDetails") store.setReuse(null);
}

const REUSE_LABELS: [keyof ReusableDetails, string][] = [
  ["appName", "App name"],
  ["appId", "App ID"],
  ["businessUnit", "Business Unit"],
  ["requester", "Requester"],
  ["mdApprover", "MD approver"]
];

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
  if (!draft.details || !draft.location) {
    return {
      ok: false as const,
      error: "No summary yet. Call buildSummary first."
    };
  }
  return buildRequestRecord(draft.details, draft.location, {
    totalCores: draft.totalCores,
    totalMemoryGB: draft.totalMemoryGB,
    totalDiskTB: draft.totalDiskTB,
    giveBackCores: draft.giveBackCores,
    // Drafts saved before defaults existed have no `assumed` field.
    assumed: draft.assumed ?? { memory: null, disk: null }
  });
}

/**
 * A normal (non-error) tool result asking the user for missing input. The
 * server shows `display` in the chat and ends the turn.
 */
function needsInput(missing: string[], problem?: string, known: string[] = []) {
  const list = missing.map((f) => `- ${f}`).join("\n");
  const knownBlock = known.length
    ? `**So far**\n\n${known.map((k) => `- ${k}`).join("\n")}\n\n`
    : "";
  return {
    ok: false as const,
    status: "needs_input" as const,
    missing,
    ...(problem ? { problem } : {}),
    ...(known.length ? { known } : {}),
    display: problem
      ? `${problem}\n\nPlease provide:\n\n${list}`
      : `${knownBlock}To finish the request, please provide:\n\n${list}`,
    needsUserInput: true as const,
    note: "This has already been shown to the user. Wait for their answer."
  };
}

const allocationsSchema = z.preprocess(
  (v) => {
    const parsed = parseJsonString(v);
    if (parsed === null || parsed === undefined) return parsed;
    if (Array.isArray(parsed)) return parsed;
    // A single object instead of a list.
    return typeof parsed === "object" ? [parsed] : undefined;
  },
  z
    .array(
      z.object({
        dataCenter: optText(),
        hosts: optNum().describe("Whole hosts (host-based requests)"),
        percent: optNum().describe("Percent share (totals-based requests)")
      })
    )
    .nullish()
);

const toAllocationInputs = (split: DcAllocation[]): AllocationInput[] =>
  split.map((a) => ({
    dataCenter: a.dataCenter,
    hosts: a.hosts,
    percent: a.percent
  }));

export function createCapacityTools(
  store: DraftStore,
  conversation: Conversation
) {
  /** User text plus any details the user confirmed reusing. */
  const groundingText = () => {
    const reuse = store.getReuse();
    const extra = reuse?.confirmed
      ? Object.values(reuse.details).join("\n")
      : "";
    return extra
      ? `${conversation.userText()}\n${extra}`
      : conversation.userText();
  };

  const tools = {
    lookupRequest: tool({
      description:
        "Look up an earlier capacity request by its CAP ID (e.g. CAP-2, CAP-002, CAP-0002) so its App name, App ID, Business Unit, Requester and MD approver can be reused. A CAP ID is never an App ID.",
      inputSchema: z.object({
        requestId: optText().describe("The CAP ID the user mentioned")
      }),
      execute: async ({ requestId }) => {
        const seq =
          parseCapId(requestId ?? "") ??
          lastCapId(conversation.latestUserText());
        if (seq === null) {
          return needsInput(["The CAP request ID to reuse (e.g. CAP-0002)"]);
        }
        const id = formatRequestId(seq);
        const found = store.findRequest(seq);
        if (!found) {
          return {
            ok: false as const,
            status: "needs_input" as const,
            found: false,
            display: `I couldn't find **${id}**. Please check the request ID, or give the App name, App ID, Business Unit, Requester and MD approver.`,
            needsUserInput: true as const,
            note: "This has already been shown to the user. Wait for their answer."
          };
        }
        const details: ReusableDetails = {
          appName: found.appName,
          appId: found.appId,
          businessUnit: found.businessUnit,
          requester: found.requester,
          mdApprover: found.mdApprover
        };
        store.setReuse({ requestId: id, details, confirmed: false });
        const table = [
          "| Field | Value |",
          "| --- | --- |",
          ...REUSE_LABELS.map(
            ([k, label]) => `| ${label} | ${details[k].replace(/\|/g, "\\|")} |`
          )
        ].join("\n");
        return {
          ok: true as const,
          found: true,
          requestId: id,
          ...details,
          display: `Found **${id}**. Reuse these details for this request?\n\n${table}`,
          note: "The details have been shown to the user. Now call reuseRequestDetails; the user confirms with Approve / Reject buttons."
        };
      }
    }),

    reuseRequestDetails: tool({
      description:
        "Ask the user to confirm (Approve / Reject buttons) reusing the details found by lookupRequest. Takes no arguments.",
      inputSchema: z.object({}),
      needsApproval: async () => {
        const reuse = store.getReuse();
        return Boolean(reuse && !reuse.confirmed);
      },
      execute: async () => {
        const reuse = store.getReuse();
        if (!reuse) {
          return {
            ok: false as const,
            error: "Nothing to reuse. Call lookupRequest with the CAP ID first."
          };
        }
        store.setReuse({ ...reuse, confirmed: true });
        return {
          ok: true as const,
          requestId: reuse.requestId,
          ...reuse.details,
          display: `Reusing App name, App ID, Business Unit, Requester and MD approver from **${reuse.requestId}**.`,
          note: "Shown to the user. These details are confirmed; pass them to buildSummary and ask only for anything else still missing."
        };
      }
    }),

    listDataCenters: tool({
      description:
        "List on-prem regions and their data centers. Pass region (and optionally dataCenter) to check that a data center belongs to that region.",
      inputSchema: z.object({
        region: optText().describe("Optional region: Americas, EMEA or APAC"),
        dataCenter: optText().describe(
          "Optional data center code to validate, e.g. USDC1"
        )
      }),
      execute: async ({ region, dataCenter }) =>
        listDataCenters(region ?? undefined, dataCenter ?? undefined)
    }),

    calculateResources: tool({
      description:
        'Compute total cores, memory (GB) and disk (TB). Use mode "perHost" with hostCount, coresPerHost, memory (memoryGBPerHost OR memoryGBPerCore) and diskPerHost (+diskUnit); or mode "totals" with totalCores, totalMemory (+memoryUnit) and totalDisk (+diskUnit). Pass numbers and units exactly as the user stated them; never convert them yourself.',
      // Every field is optional and leniently parsed: missing or malformed
      // values produce a normal "please provide" result, never a schema error.
      inputSchema: z.object({
        mode: optText().describe('"perHost" or "totals"'),
        hostCount: optNum(),
        coresPerHost: optNum(),
        memoryGBPerHost: optNum().describe("Memory per host in GB"),
        memoryGBPerCore: optNum().describe(
          "Memory per core in GB (when the user gives memory per core)"
        ),
        diskPerHost: optNum().describe("Disk per host, in diskUnit"),
        totalCores: optNum(),
        totalMemory: optNum(),
        memoryUnit: optUnit().describe(
          "Unit of totalMemory as the user stated it (default GB)"
        ),
        totalDisk: optNum(),
        diskUnit: optUnit().describe(
          "Unit of diskPerHost / totalDisk as the user stated it (default TB)"
        ),
        memoryUnknown: optBool().describe(
          "true only if the user said they don't know the memory"
        ),
        diskUnknown: optBool().describe(
          "true only if the user said they don't know the disk"
        )
      }),
      execute: async (input) => {
        const result = calculateResources(
          {
            mode: inferMode(input),
            hostCount: input.hostCount ?? undefined,
            coresPerHost: input.coresPerHost ?? undefined,
            memoryGBPerHost: input.memoryGBPerHost ?? undefined,
            memoryGBPerCore: input.memoryGBPerCore ?? undefined,
            diskPerHost: input.diskPerHost ?? undefined,
            totalCores: input.totalCores ?? undefined,
            totalMemory: input.totalMemory ?? undefined,
            memoryUnit: input.memoryUnit ?? undefined,
            totalDisk: input.totalDisk ?? undefined,
            diskUnit: input.diskUnit ?? undefined,
            memoryUnknown: input.memoryUnknown ?? undefined,
            diskUnknown: input.diskUnknown ?? undefined
          },
          conversation.userText()
        );
        if (!result.ok && "status" in result) {
          // If the user named a region but no split ratio, ask for the split
          // in the same message.
          const userText = conversation.userText();
          const region = regionGiven(userText);
          const askSplit =
            region && !splitRatioGiven(userText) && !store.get()?.location;
          return needsInput(
            askSplit ? [...result.missing, splitLabel(region)] : result.missing,
            undefined,
            result.known
          );
        }
        if (result.ok) {
          // New totals invalidate any earlier give-back, split and summary.
          store.set({
            totalCores: result.totalCores,
            totalMemoryGB: result.totalMemoryGB,
            totalDiskTB: result.totalDiskTB,
            hostSpec: result.hostSpec,
            capexShown: false,
            assumed: result.assumed,
            giveBackCores: null,
            location: null,
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
        const result = calculateCapex(draft);
        if (result.ok) store.set({ ...draft, capexShown: true });
        return result;
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
                hostCount: optNum(),
                coresPerHost: optNum()
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
          // Missing numbers become 0 and are rejected by applyGiveBack with a
          // "how many cores per returned host" message.
          giveBackGroups:
            giveBackGroups?.map((g) => ({
              hostCount: g.hostCount ?? 0,
              coresPerHost: g.coresPerHost ?? 0
            })) ?? undefined
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

    validateSplit: tool({
      description:
        "Validate the region and how the request is split across that region's data centers, and show the per-data-center cores, memory and disk. allocations: one entry per data center with hosts (host-based request) or percent (totals-based request), exactly as the user stated.",
      inputSchema: z.object({
        region: optText().describe("Americas, EMEA or APAC"),
        allocations: allocationsSchema
      }),
      execute: async ({ region, allocations }) => {
        const draft = store.get();
        if (!draft) return NO_DRAFT;
        const result = validateSplit(
          { region, allocations },
          draft,
          conversation.userText()
        );
        if (!result.ok) return needsInput(result.missing, result.problem);
        store.set({
          ...draft,
          location: { region: result.region, split: result.allocations },
          details: null
        });
        return {
          ok: true as const,
          region: result.region,
          split: result.allocations,
          display: `**Data center split (${result.region})**\n\n${splitTable(result.allocations, draft)}`,
          note: "The split table has already been shown to the user. Continue collecting any missing requester details, then call buildSummary."
        };
      }
    }),

    buildSummary: tool({
      description:
        "Check the requester details, region and data center split, then show the final summary with Approve / Reject buttons. Pass only what the user has given; the server lists anything still missing.",
      // All fields are optional strings so missing or bad values get a
      // normal "please provide" result instead of a schema error badge.
      inputSchema: z.object({
        appName: optText(),
        appId: optText(),
        businessUnit: optText(),
        requester: optText().describe("Requester / owner name"),
        mdApprover: optText().describe("MD approver name"),
        environment: optText().describe('"prod" or "non-prod"'),
        region: optText().describe("Americas, EMEA or APAC"),
        allocations: allocationsSchema.describe(
          "Data center split, if the user gave it and validateSplit was not already called"
        )
      }),
      execute: async (input) => {
        const draft = store.get();
        if (!draft) return NO_DRAFT;
        if (draft.giveBackCores === null) return NO_GIVE_BACK;
        const userText = conversation.userText();

        // Details the user confirmed reusing from an earlier CAP request fill
        // any field the model left empty, and count as given by the user.
        const reuse = store.getReuse();
        const reused = reuse?.confirmed ? reuse.details : null;
        const fill = (v: string | null | undefined, r?: string) =>
          v && v.trim() ? v : (r ?? v);
        const detailInput = {
          ...input,
          appName: fill(input.appName, reused?.appName),
          appId: fill(input.appId, reused?.appId),
          businessUnit: fill(input.businessUnit, reused?.businessUnit),
          requester: fill(input.requester, reused?.requester),
          mdApprover: fill(input.mdApprover, reused?.mdApprover)
        };
        const detailCheck = checkDetails(detailInput, groundingText());

        // Use a split given now; otherwise the one validated earlier (if the
        // region still matches); otherwise report region/split as missing.
        const givenRegion = normalizeRegion(input.region ?? "");
        let split;
        if (input.allocations && input.allocations.length > 0) {
          split = validateSplit(input, draft, userText);
        } else if (
          draft.location &&
          (!givenRegion || givenRegion === draft.location.region)
        ) {
          split = validateSplit(
            {
              region: draft.location.region,
              allocations: toAllocationInputs(draft.location.split)
            },
            draft,
            userText
          );
        } else {
          split = validateSplit(
            { region: input.region, allocations: [] },
            draft,
            userText
          );
        }

        const missing = [
          ...detailCheck.missing,
          ...(split.ok ? [] : split.missing)
        ];
        if (missing.length || !split.ok || !("details" in detailCheck)) {
          return needsInput(missing, split.ok ? undefined : split.problem);
        }

        const location = { region: split.region, split: split.allocations };
        const updated: Draft = {
          ...draft,
          location,
          details: detailCheck.details
        };
        const built = recordFromDraft(updated);
        if (!built.ok) return built;
        store.set(updated);
        return {
          ok: true as const,
          display: `**Summary**\n\n${summaryTable(built.record)}\n\nReview the request, then click **Approve** to submit it or **Reject** to make changes.`,
          note: "The summary has already been shown to the user. Now call submitRequest; the user approves it with buttons."
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
        if (!built.ok || !draft) return built;
        const r = built.record;
        // Re-check grounding at save time in case the transcript changed.
        const userText = conversation.userText();
        const detailCheck = checkDetails(r, groundingText());
        const split = validateSplit(
          { region: r.region, allocations: toAllocationInputs(r.split) },
          draft,
          userText
        );
        if (detailCheck.missing.length || !split.ok) {
          return needsInput([
            ...detailCheck.missing,
            ...(split.ok ? [] : split.missing)
          ]);
        }
        const requestId = store.saveRequest(r);
        store.set(null);
        store.setReuse(null);
        return {
          ok: true as const,
          requestId,
          ...r,
          display: `Request **${requestId}** submitted: ${r.appName} (${r.appId}), ${r.region} (${usedDataCenters(r)}), capex ${formatMoney(r.capexAfter)} after give-back. MD approver ${r.mdApprover} is recorded on the request.`,
          note: "The confirmation with the request ID has already been shown to the user. Do not repeat it."
        };
      }
    })
  };
  return withToolGuards(tools);
}

export const TOOL_BUG_MESSAGE =
  "Sorry, something went wrong on our side with that step. Please try again, or rephrase your last message.";

/**
 * Catches unexpected errors (bugs) inside tool code and turns them into a
 * normal result with a friendly message that ends the turn, instead of a
 * silent failure the model keeps retrying.
 */
function withToolGuards<T extends Record<string, { execute?: unknown }>>(
  tools: T
): T {
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute as
      | ((input: unknown, options: unknown) => Promise<unknown>)
      | undefined;
    if (!execute) continue;
    (t as { execute: unknown }).execute = async (
      input: unknown,
      options: unknown
    ) => {
      try {
        return await execute(input, options);
      } catch (err) {
        console.error(`Tool ${name} failed:`, err);
        return {
          ok: false as const,
          status: "tool_error" as const,
          display: TOOL_BUG_MESSAGE,
          needsUserInput: true as const,
          note: "This has already been shown to the user. Wait for their reply."
        };
      }
    };
  }
  return tools;
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

/** Tools that need resource totals before they can run. */
const NEEDS_TOTALS = [
  "calculateCapex",
  "applyGiveBack",
  "validateSplit",
  "buildSummary",
  "submitRequest"
];

/**
 * After the user clicks Reject, AIChatAgent stores the tool part as
 * "output-denied" before calling onChatMessage, so the denial never shows up
 * as a stream event. Returns the denied tool's name when the latest
 * assistant message ends with a freshly denied approval, else null.
 */
export function freshDenial(messages: UIMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const part = last.parts[i];
    if (part.type === "step-start") continue;
    if (!isToolUIPart(part)) return null; // text after it: already answered
    return part.state === "output-denied" ? getToolName(part) : null;
  }
  return null;
}

/** A tool result that just asks the user for input (not a failure). */
function isNeedsInput(output: unknown) {
  const o = output as { needsUserInput?: boolean } | undefined;
  return o?.needsUserInput === true;
}

/**
 * Failures per tool in this turn: schema/execution errors, or results with
 * ok: false that aren't a normal "please provide" request.
 */
export function failureCounts(steps: AnyStep[]) {
  const counts = new Map<string, number>();
  for (const step of steps) {
    for (const p of step.content) {
      const failed =
        p.type === "tool-error" ||
        (p.type === "tool-result" &&
          (p.output as { ok?: boolean } | undefined)?.ok === false &&
          !isNeedsInput(p.output));
      if (failed) counts.set(p.toolName, (counts.get(p.toolName) ?? 0) + 1);
    }
  }
  return counts;
}

/** Same tool failed twice this turn: stop retrying and ask the user. */
export const MAX_FAILURES_PER_TOOL = 2;

/**
 * Turn control for the capacity flow:
 * - only resource tools are offered until totals exist;
 * - capex runs right after resources (after validating a split first, when
 *   the user already gave a region and ratio);
 * - the approval-gated submit runs right after the summary is shown;
 * - the turn ends after the capex block, a submit, a "please provide"
 *   request, or a tool failing twice.
 */
export function createTurnControl(
  store: Pick<DraftStore, "get">,
  conversation: Conversation,
  toolNames: string[]
): {
  prepareStep: PrepareStepFunction<ToolSet>;
  stopWhen: StopCondition<ToolSet>[];
} {
  const capexPending = () => store.get()?.capexShown === false;

  const prepareStep: PrepareStepFunction<ToolSet> = ({ steps, messages }) => {
    // After the user clicks Reject, make the model answer in text (ask what
    // to change) instead of immediately calling submitRequest again.
    if (steps.length === 0 && submitJustRejected(messages)) {
      // Workers AI rejects an empty tools array, so keep one harmless tool
      // active and disable tool calls for this step.
      return { activeTools: ["listDataCenters"], toolChoice: "none" };
    }
    const last = steps[steps.length - 1];
    // A CAP ID in the user's new message: look it up in code-driven order
    // (lookup, then the reuse confirmation buttons).
    if (
      steps.length === 0 &&
      messages[messages.length - 1]?.role === "user" &&
      lastCapId(conversation.latestUserText()) !== null
    ) {
      return { toolChoice: { type: "tool", toolName: "lookupRequest" } };
    }
    if (
      last?.toolResults.some(
        (r) =>
          r.toolName === "lookupRequest" &&
          (r.output as { found?: boolean } | undefined)?.found === true
      )
    ) {
      return { toolChoice: { type: "tool", toolName: "reuseRequestDetails" } };
    }
    const draft = store.get();
    if (draft && capexPending()) {
      if (
        okResult(last, "calculateResources") &&
        !draft.location &&
        splitRatioGiven(conversation.userText())
      ) {
        return { toolChoice: { type: "tool", toolName: "validateSplit" } };
      }
      if (
        okResult(last, "calculateResources") ||
        last?.toolResults.some((r) => r.toolName === "validateSplit")
      ) {
        return { toolChoice: { type: "tool", toolName: "calculateCapex" } };
      }
    }
    if (okResult(last, "buildSummary")) {
      return { toolChoice: { type: "tool", toolName: "submitRequest" } };
    }
    if (!draft) {
      // No totals yet: don't offer split, give-back, summary or submit.
      return {
        activeTools: toolNames.filter((n) => !NEEDS_TOTALS.includes(n))
      };
    }
    return undefined;
  };

  const stopWhen: StopCondition<ToolSet>[] = [
    stepCountIs(10),
    ({ steps }) => {
      for (const n of failureCounts(steps).values()) {
        if (n >= MAX_FAILURES_PER_TOOL) return true;
      }
      const last = steps[steps.length - 1];
      if (okResult(last, "calculateCapex") || okResult(last, "submitRequest"))
        return true;
      // A split question while capex is still pending doesn't end the turn:
      // capex runs next and both are shown together.
      return Boolean(
        last?.toolResults.some(
          (r) =>
            isNeedsInput(r.output) &&
            !(r.toolName === "validateSplit" && capexPending())
        )
      );
    }
  ];

  return { prepareStep, stopWhen };
}

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

export const AI_LIMIT_MESSAGE =
  "The AI service limit has been reached. Please try again later.";
export const AI_ERROR_MESSAGE =
  "Something went wrong reaching the AI service. Please try again.";

/** Collects message text from an error and its causes / retry attempts. */
function errorText(err: unknown, depth = 0): string {
  if (depth > 4 || err == null) return "";
  if (typeof err !== "object") return String(err);
  const e = err as {
    message?: unknown;
    statusCode?: unknown;
    responseBody?: unknown;
    cause?: unknown;
    lastError?: unknown;
    errors?: unknown;
  };
  return [
    e.message,
    e.statusCode,
    e.responseBody,
    errorText(e.cause, depth + 1),
    errorText(e.lastError, depth + 1),
    ...(Array.isArray(e.errors)
      ? e.errors.map((x) => errorText(x, depth + 1))
      : [])
  ]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .join(" ");
}

/**
 * Workers AI quota / rate-limit errors: 3036 (daily free allocation used
 * up), 3040 (capacity temporarily exceeded), or any HTTP 429.
 */
export function isAiLimitError(err: unknown) {
  return /\b(3036|3040|429)\b|rate.?limit|too many requests|capacity temporarily exceeded|daily free allocation|neurons/i.test(
    errorText(err)
  );
}

/** Plain questions used when a turn would otherwise end with no text. */
const FALLBACK_QUESTIONS: Record<string, string> = {
  calculateResources:
    "I couldn't work out the request size from that. How many hosts, and how many cores, how much memory and disk per host? Or give total cores, memory and disk. You can say \"don't know\" for memory or disk to use the defaults (8 GB per core, 100 GB disk per host).",
  calculateCapex:
    "I couldn't calculate capex yet. Could you confirm the request size (hosts and per-host spec, or total cores, memory and disk)?",
  applyGiveBack:
    "How many cores can you give back? If it's hosts, how many hosts and how many cores does each have?",
  validateSplit:
    "How should the request be split across the region's two data centers: all in one, 50/50, or a host count per data center?",
  buildSummary:
    "I couldn't build the summary yet. Could you confirm the app name, App ID, Business Unit, requester, MD approver, environment, region and split?",
  submitRequest:
    "I couldn't submit the request yet. Would you like me to show the summary again?"
};
export const FALLBACK_QUESTION =
  "Sorry, I couldn't complete that. Could you rephrase or give the missing details?";

/**
 * Stream transform that (1) writes each tool's ready-to-show `display` block
 * into the chat as assistant text right after the tool result,
 * (2) formats numbers in model-written text, (3) turns AI service errors
 * into a readable chat message, and (4) never lets a turn end without text:
 * if nothing was written, it adds a plain question.
 */
export const displayTransform: StreamTextTransform<ToolSet> = () => {
  let n = 0;
  // After Approve or Reject, the outcome is handled before the model's first
  // step, so stopWhen can't end the turn. The server shows a fixed message
  // and drops any model text that follows it.
  let silenced = false;
  let wroteText = false;
  let lastFailedTool: string | null = null;
  const writeText = (
    controller: TransformStreamDefaultController<TextStreamPart<ToolSet>>,
    text: string
  ) => {
    const id = `display-${n++}`;
    controller.enqueue({ type: "text-start", id });
    controller.enqueue({ type: "text-delta", id, text });
    controller.enqueue({ type: "text-end", id });
    wroteText = true;
  };
  return new TransformStream({
    transform(part, controller) {
      if (part.type === "text-delta" && !silenced && part.text.trim()) {
        wroteText = true;
      }
      if (part.type === "tool-error") lastFailedTool = part.toolName;
      if (
        part.type === "tool-result" &&
        (part.output as { ok?: boolean } | undefined)?.ok === false &&
        !isNeedsInput(part.output)
      ) {
        lastFailedTool = part.toolName;
      }
      // Never end a turn with no text reply.
      if (part.type === "finish" && !wroteText) {
        writeText(
          controller,
          (lastFailedTool && FALLBACK_QUESTIONS[lastFailedTool]) ||
            FALLBACK_QUESTION
        );
      }
      // Show model/API failures as a chat message instead of nothing.
      if (part.type === "error") {
        console.error("AI stream error:", part.error);
        writeText(
          controller,
          isAiLimitError(part.error) ? AI_LIMIT_MESSAGE : AI_ERROR_MESSAGE
        );
        return;
      }
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
        DENIAL_MESSAGES[part.toolName]
      ) {
        writeText(controller, DENIAL_MESSAGES[part.toolName]);
        silenced = true;
      }
      if (part.type === "tool-result") {
        const output = part.output as
          | { ok?: boolean; display?: unknown }
          | undefined;
        if (typeof output?.display === "string") {
          writeText(controller, output.display);
        }
        if (part.toolName === "submitRequest" && output?.ok === true) {
          silenced = true;
        }
      }
    }
  });
};
