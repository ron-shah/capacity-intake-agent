import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { formatRequestId } from "./capacity";
import {
  SYSTEM_PROMPT,
  createCapacityTools,
  createModel,
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
    this.sql`CREATE TABLE IF NOT EXISTS capacity_requests (
      seq INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      app_name TEXT NOT NULL,
      owner TEXT NOT NULL,
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
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    // In-progress calculation results (single row). submitRequest saves
    // these numbers rather than anything the model passes in.
    this.sql`CREATE TABLE IF NOT EXISTS intake_draft (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_cores INTEGER NOT NULL,
      total_memory_gb REAL NOT NULL,
      total_disk_tb REAL NOT NULL,
      give_back_cores INTEGER,
      give_back_turn INTEGER
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
        const [row] = this.sql<{
          total_cores: number;
          total_memory_gb: number;
          total_disk_tb: number;
          give_back_cores: number | null;
          give_back_turn: number | null;
        }>`SELECT total_cores, total_memory_gb, total_disk_tb, give_back_cores,
                  give_back_turn
           FROM intake_draft WHERE id = 1`;
        if (!row) return null;
        return {
          totalCores: row.total_cores,
          totalMemoryGB: row.total_memory_gb,
          totalDiskTB: row.total_disk_tb,
          giveBackCores: row.give_back_cores,
          giveBackTurn: row.give_back_turn
        } satisfies Draft;
      },
      set: (draft) => {
        if (!draft) {
          this.sql`DELETE FROM intake_draft`;
          return;
        }
        this.sql`INSERT OR REPLACE INTO intake_draft
          (id, total_cores, total_memory_gb, total_disk_tb, give_back_cores,
           give_back_turn)
          VALUES (1, ${draft.totalCores}, ${draft.totalMemoryGB},
                  ${draft.totalDiskTB}, ${draft.giveBackCores},
                  ${draft.giveBackTurn})`;
      },
      saveRequest: (record) => {
        // Durable Objects are single-threaded, so MAX+1 is safe here.
        const [{ next }] = this.sql<{ next: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM capacity_requests`;
        const requestId = formatRequestId(next);
        this.sql`INSERT INTO capacity_requests (
          seq, request_id, app_name, owner, environment, region, data_center,
          total_cores, total_memory_gb, total_disk_tb, give_back_cores,
          net_cores, capex_before, capex_after, currency, created_at
        ) VALUES (
          ${next}, ${requestId}, ${record.appName}, ${record.owner},
          ${record.environment}, ${record.region}, ${record.dataCenter},
          ${record.totalCores}, ${record.totalMemoryGB}, ${record.totalDiskTB},
          ${record.giveBackCores}, ${record.netCores}, ${record.capexBefore},
          ${record.capexAfter}, ${record.currency}, ${record.createdAt}
        )`;
        return requestId;
      }
    };
  }

  private conversation(): Conversation {
    const userMessages = () => this.messages.filter((m) => m.role === "user");
    const textOf = (m: (typeof this.messages)[number]) =>
      m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return {
      userTurns: () => userMessages().length,
      userText: () => userMessages().map(textOf).join("\n"),
      latestUserText: () => {
        const all = userMessages();
        return all.length ? textOf(all[all.length - 1]) : "";
      }
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
      stopWhen: stepCountIs(10),
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
