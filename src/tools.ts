/**
 * Model, system prompt and tool definitions for the capacity intake agent.
 * Kept separate from the Durable Object so they can be exercised directly.
 */
import { createWorkersAI } from "workers-ai-provider";
import { simulateStreamingMiddleware, tool, wrapLanguageModel } from "ai";
import { z } from "zod";
import {
  REGIONS,
  applyGiveBack,
  confirmedByUser,
  environmentStatedByUser,
  mentionedByUser,
  buildRequestRecord,
  calculateCapex,
  calculateResources,
  formatMoney,
  listDataCenters
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
1. App name
2. Owner
3. Environment: prod or non-prod
4. Region: Americas, EMEA or APAC
5. Data center within that region. Call listDataCenters with the region and data center to check it. If it is not valid, say so and list the valid ones from the tool result.
6. The need, either:
   - hosts x per-host spec (cores, memory GB, disk TB per host), or
   - totals of cores, memory and disk.
   If the user gives a host count without a per-host spec, ask for cores, memory and disk per host.

Rules:
- Never guess or invent numbers. Never do arithmetic yourself. Every total, capex, give-back, net core and savings figure must come from a tool result.
- Call calculateResources once you have the full need, then calculateCapex.
- Capex is based on cores only. Memory and disk are not priced.
- After calculateCapex, show total cores, memory, disk and capex, then ask exactly: "Can you give back equivalent cores from hosts or apps you are retiring?"
- If the give-back is a host count, ask how many cores each returned host has. Do not assume returned hosts match the new hosts. Accept mixed groups (e.g. 20 x 12 cores and 20 x 24 cores). Then call applyGiveBack. If the user has no give-back, call applyGiveBack with giveBackCores 0.
- Then show a short markdown summary table with: Region, Data center, Cores, Memory (GB), Disk (TB), Give-back cores, Net cores, Capex before, Capex after, Savings. Ask the user to confirm.
- Before showing the summary table, make sure the user has given app name, owner, environment (prod or non-prod), region and data center. If any are missing, ask for them first. Never fill them in with "unknown" or a guess.
- Only call submitRequest after the user explicitly confirms the summary. Then share the request ID.
- Use the *Formatted money values from tool results ($200K style).
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
// The numbers that get saved come from earlier tool results held on the
// server, never from what the model passes to submitRequest.

export interface Draft {
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  giveBackCores: number | null;
  /** User-turn count when the give-back was applied (null until then). */
  giveBackTurn: number | null;
}

/** Read-only view of the conversation, used to ground submitRequest. */
export interface Conversation {
  /** Number of user messages so far, including the current one. */
  userTurns(): number;
  /** Concatenated text of all user messages. */
  userText(): string;
  /** Text of the most recent user message. */
  latestUserText(): string;
}

export interface DraftStore {
  get(): Draft | null;
  set(draft: Draft | null): void;
  saveRequest(
    record: Extract<
      ReturnType<typeof buildRequestRecord>,
      { ok: true }
    >["record"]
  ): string;
}

const NO_DRAFT = {
  ok: false as const,
  error:
    "No resource totals yet. Collect the need and call calculateResources first."
};

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
          // New totals invalidate any earlier give-back.
          store.set({
            totalCores: result.totalCores,
            totalMemoryGB: result.totalMemoryGB,
            totalDiskTB: result.totalDiskTB,
            giveBackCores: null,
            giveBackTurn: null
          });
        }
        return result;
      }
    }),

    calculateCapex: tool({
      description:
        "Calculate capex for the current request from its total cores (cores x per-core rate). Memory and disk are not priced. Call after calculateResources.",
      inputSchema: z.object({}),
      execute: async () => {
        const draft = store.get();
        if (!draft) return NO_DRAFT;
        return calculateCapex(draft.totalCores);
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
            giveBackTurn: conversation.userTurns()
          });
        }
        return result;
      }
    }),

    submitRequest: tool({
      description:
        "Save the final capacity request and return a request ID. ONLY call after the user explicitly confirms the summary. Cores, memory, disk, give-back and capex are taken from the earlier calculations on the server.",
      inputSchema: z.object({
        appName: z.string(),
        owner: z.string(),
        environment: z.enum(["prod", "non-prod"]),
        region: z.enum(REGIONS),
        dataCenter: z.string()
      }),
      execute: async (input) => {
        const draft = store.get();
        if (!draft) return NO_DRAFT;
        if (draft.giveBackCores === null || draft.giveBackTurn === null) {
          return {
            ok: false as const,
            error:
              "Give-back not recorded yet. Call applyGiveBack first (giveBackCores 0 if none)."
          };
        }
        // The user must have replied after the give-back was calculated,
        // i.e. after seeing the summary. Blocks same-turn submits.
        if (
          conversation.userTurns() <= draft.giveBackTurn ||
          !confirmedByUser(conversation.latestUserText())
        ) {
          return {
            ok: false as const,
            error:
              "Not confirmed yet. Show the summary table and wait for the user to confirm."
          };
        }
        // Owner, app name and environment must come from the user, not a guess.
        const userText = conversation.userText();
        const ungrounded = [
          !mentionedByUser(input.appName, userText) && "app name",
          !mentionedByUser(input.owner, userText) && "owner",
          !environmentStatedByUser(input.environment, userText) &&
            "environment (prod or non-prod)"
        ].filter(Boolean);
        if (ungrounded.length) {
          return {
            ok: false as const,
            error: `The user has not provided: ${ungrounded.join(", ")}. Ask the user for it; do not guess.`
          };
        }
        const built = buildRequestRecord({
          ...input,
          totalCores: draft.totalCores,
          totalMemoryGB: draft.totalMemoryGB,
          totalDiskTB: draft.totalDiskTB,
          giveBackCores: draft.giveBackCores
        });
        if (!built.ok) return built;
        const requestId = store.saveRequest(built.record);
        store.set(null);
        return {
          ok: true as const,
          requestId,
          ...built.record,
          savings: built.record.capexBefore - built.record.capexAfter,
          capexBeforeFormatted: formatMoney(built.record.capexBefore),
          capexAfterFormatted: formatMoney(built.record.capexAfter),
          savingsFormatted: formatMoney(
            built.record.capexBefore - built.record.capexAfter
          )
        };
      }
    })
  };
}
