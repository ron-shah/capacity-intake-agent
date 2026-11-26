import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, pruneMessages, streamText } from "ai";
import { formatRequestId } from "./capacity";
import {
  SYSTEM_PROMPT,
  capacityPrepareStep,
  capacityStopWhen,
  createCapacityTools,
  createModel,
  displayTransform,
  type Conversation,
  type Draft,
  type DraftStore
} from "./tools";

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
      created_at TEXT NOT NULL
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
          capex_before, capex_after, savings, currency, created_at
        ) VALUES (
          ${next}, ${requestId}, ${r.appName}, ${r.appId}, ${r.businessUnit},
          ${r.requester}, ${r.mdApprover}, ${r.environment}, ${r.region},
          ${r.dataCenter}, ${r.totalCores}, ${r.totalMemoryGB},
          ${r.totalDiskTB}, ${r.giveBackCores}, ${r.netCores},
          ${r.capexBefore}, ${r.capexAfter}, ${r.savings}, ${r.currency},
          ${new Date().toISOString()}
        )`;
        return requestId;
      }
    };
  }

  private conversation(): Conversation {
    return {
      userText: () =>
        this.messages
          .filter((m) => m.role === "user")
          .flatMap((m) => m.parts)
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n")
    };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();

    const result = streamText({
      model: createModel(this.env.AI, this.sessionAffinity),
      system: SYSTEM_PROMPT,
      // Tool results are kept (not pruned) so the final summary can quote
      // the exact numbers the tools computed earlier in the conversation.
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,
        ...createCapacityTools(this.draftStore(), this.conversation())
      },
      prepareStep: capacityPrepareStep,
      stopWhen: capacityStopWhen,
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
