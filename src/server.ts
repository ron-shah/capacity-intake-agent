import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  streamText,
  type ToolSet
} from "ai";
import { formatRequestId, usedDataCenters } from "./capacity";
import {
  DENIAL_MESSAGES,
  SYSTEM_PROMPT,
  createCapacityTools,
  createTurnControl,
  createModel,
  displayTransform,
  freshDenial,
  handleDenial,
  type Conversation,
  type Draft,
  type DraftStore,
  type Reuse
} from "./tools";

/** Simple app-wide demo cap on user chat messages per UTC day. */
const DAILY_MESSAGE_CAP = 200;
const DAILY_LIMIT_MESSAGE =
  "Daily demo limit reached. Please try again tomorrow.";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Submitted requests. (Table names differ from earlier drafts of this
    // agent so a stale local dev database can't clash with the new columns.)
    this.sql`CREATE TABLE IF NOT EXISTS cap_requests (
      seq INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      app_name TEXT NOT NULL,
      app_id TEXT NOT NULL,
      business_unit TEXT NOT NULL,
      requester TEXT NOT NULL,
      md_approver TEXT NOT NULL,
      environment TEXT NOT NULL,
      region TEXT NOT NULL,
      data_center TEXT NOT NULL,
      total_cores INTEGER NOT NULL,
      total_memory_gb REAL NOT NULL,
      total_disk_tb REAL NOT NULL,
      give_back_cores INTEGER NOT NULL,
      net_cores INTEGER NOT NULL,
      capex_before REAL NOT NULL,
      capex_after REAL NOT NULL,
      savings REAL NOT NULL,
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL,
      split_json TEXT,
      assumed_json TEXT
    )`;
    // Migrate tables created before the data center split was added.
    const columns = this.sql<{ name: string }>`PRAGMA table_info(cap_requests)`;
    if (!columns.some((c) => c.name === "split_json")) {
      this.sql`ALTER TABLE cap_requests ADD COLUMN split_json TEXT`;
    }
    // Which memory/disk values were "assumed default" (JSON).
    if (!columns.some((c) => c.name === "assumed_json")) {
      this.sql`ALTER TABLE cap_requests ADD COLUMN assumed_json TEXT`;
    }
    // Daily message counter for the demo cap (one row per UTC day).
    this.sql`CREATE TABLE IF NOT EXISTS daily_usage (
      day TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    )`;
    // In-progress draft (calculated numbers + validated details) as JSON.
    // submitRequest saves these values rather than anything the model passes.
    this.sql`CREATE TABLE IF NOT EXISTS intake_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;

    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  private draftStore(): DraftStore {
    return {
      get: () => {
        const [row] = this.sql<{ value: string }>`
          SELECT value FROM intake_state WHERE key = 'draft'`;
        return row ? (JSON.parse(row.value) as Draft) : null;
      },
      set: (draft) => {
        if (!draft) {
          this.sql`DELETE FROM intake_state WHERE key = 'draft'`;
          return;
        }
        this.sql`INSERT OR REPLACE INTO intake_state (key, value)
          VALUES ('draft', ${JSON.stringify(draft)})`;
      },
      saveRequest: (r) => {
        // Durable Objects are single-threaded, so MAX+1 is safe here.
        const [{ next }] = this.sql<{ next: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM cap_requests`;
        const requestId = formatRequestId(next);
        this.sql`INSERT INTO cap_requests (
          seq, request_id, app_name, app_id, business_unit, requester,
          md_approver, environment, region, data_center, total_cores,
          total_memory_gb, total_disk_tb, give_back_cores, net_cores,
          capex_before, capex_after, savings, currency, created_at, split_json,
          assumed_json
        ) VALUES (
          ${next}, ${requestId}, ${r.appName}, ${r.appId}, ${r.businessUnit},
          ${r.requester}, ${r.mdApprover}, ${r.environment}, ${r.region},
          ${usedDataCenters(r)}, ${r.totalCores}, ${r.totalMemoryGB},
          ${r.totalDiskTB}, ${r.giveBackCores}, ${r.netCores},
          ${r.capexBefore}, ${r.capexAfter}, ${r.savings}, ${r.currency},
          ${new Date().toISOString()}, ${JSON.stringify(r.split)},
          ${JSON.stringify(r.assumedDefaults)}
        )`;
        return requestId;
      },
      findRequest: (seq) => {
        const [row] = this.sql<{
          request_id: string;
          app_name: string;
          app_id: string;
          business_unit: string;
          requester: string;
          md_approver: string;
        }>`SELECT request_id, app_name, app_id, business_unit, requester,
                  md_approver
           FROM cap_requests WHERE seq = ${seq}`;
        return row
          ? {
              requestId: row.request_id,
              appName: row.app_name,
              appId: row.app_id,
              businessUnit: row.business_unit,
              requester: row.requester,
              mdApprover: row.md_approver
            }
          : null;
      },
      getReuse: () => {
        const [row] = this.sql<{ value: string }>`
          SELECT value FROM intake_state WHERE key = 'reuse'`;
        return row ? (JSON.parse(row.value) as Reuse) : null;
      },
      setReuse: (reuse) => {
        if (!reuse) {
          this.sql`DELETE FROM intake_state WHERE key = 'reuse'`;
          return;
        }
        this.sql`INSERT OR REPLACE INTO intake_state (key, value)
          VALUES ('reuse', ${JSON.stringify(reuse)})`;
      }
    };
  }

  private conversation(): Conversation {
    const userMessages = () => this.messages.filter((m) => m.role === "user");
    const textOf = (m: (typeof this.messages)[number]) =>
      m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return {
      userText: () => userMessages().map(textOf).join("\n"),
      latestUserText: () => {
        const all = userMessages();
        return all.length ? textOf(all[all.length - 1]) : "";
      }
    };
  }

  /**
   * Counts a new user message against today's cap. Returns false when the
   * cap is already reached. Approval continuations (Approve / Reject) are
   * not new user messages, so an in-progress submission can still finish.
   */
  private withinDailyCap() {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== "user") return true;
    const day = new Date().toISOString().slice(0, 10);
    this.sql`DELETE FROM daily_usage WHERE day < ${day}`;
    const [row] = this.sql<{ count: number }>`
      SELECT count FROM daily_usage WHERE day = ${day}`;
    if ((row?.count ?? 0) >= DAILY_MESSAGE_CAP) return false;
    this.sql`INSERT INTO daily_usage (day, count) VALUES (${day}, 1)
      ON CONFLICT(day) DO UPDATE SET count = count + 1`;
    return true;
  }

  /** A fixed assistant reply, streamed without calling the model. */
  private textReply(text: string) {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = crypto.randomUUID();
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      }
    });
    return createUIMessageStreamResponse({ stream });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    if (!this.withinDailyCap()) return this.textReply(DAILY_LIMIT_MESSAGE);

    // The user just clicked Reject: reply with a fixed message and don't
    // call the model (it could claim the request was submitted).
    const denied = freshDenial(this.messages);
    if (denied && DENIAL_MESSAGES[denied]) {
      handleDenial(denied, this.draftStore());
      return this.textReply(DENIAL_MESSAGES[denied]);
    }

    const mcpTools = this.mcp.getAITools();

    const store = this.draftStore();
    const conversation = this.conversation();
    const tools: ToolSet = {
      // MCP tools from connected servers
      ...mcpTools,
      ...createCapacityTools(store, conversation)
    };
    const { prepareStep, stopWhen } = createTurnControl(
      store,
      conversation,
      Object.keys(tools)
    );

    const result = streamText({
      model: createModel(this.env.AI, this.sessionAffinity),
      system: SYSTEM_PROMPT,
      // Tool results are kept (not pruned) so the final summary can quote
      // the exact numbers the tools computed earlier in the conversation.
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: "before-last-message"
      }),
      tools,
      prepareStep,
      stopWhen,
      experimental_transform: displayTransform,
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
