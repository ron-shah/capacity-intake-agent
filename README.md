# Capacity Intake Agent

A chat agent for on-prem infrastructure capacity requests, built on Cloudflare Workers, Durable Objects and Workers AI (Llama 3.3).

**Live demo:** https://capacity-intake-agent.ron-shah.workers.dev

A requester describes what they need in plain language. The agent collects the missing details, converts the request into cores, memory and disk, works out the capex, asks for a core give-back from hosts being retired, recalculates the capex, and saves the request with an ID (CAP-0001, CAP-0002, ...) after the requester approves it.

## Why this problem

Capacity requests usually arrive incomplete: a host count with no spec, no data center, no owner, no approver. Someone then spends days going back and forth to get a request that can be costed and approved. Asking for a give-back of old capacity at intake time also brings the net capex down before the request ever reaches the approver. This agent does that first round of intake in one conversation.

## What it does

1. **Intake.** Accepts a request as hosts x spec (for example "50 hosts, 32 cores, 256 GB, 2 TB each") or as totals ("1,200 cores, 9 TB memory, 200 TB disk"). Memory can also be given per core.
2. **Asks for what is missing.** Cores, memory, disk, region, data center split, App name, App ID, Business Unit, requester, MD approver and environment. It never fills these in on its own.
3. **Defaults only when the user says "don't know".** Memory defaults to 8 GB per core and disk to 100 GB per host. Any default is marked "assumed default" in the summary and in the saved record.
4. **Region and data center split.** Three regions with two data centers each (Americas: USDC1, USDC2; EMEA: EUDC1, EUDC2; APAC: ASDC1, ASDC2). The user picks a region and how to split across its two data centers (for example 50:50, 60/40, or a host count per data center).
5. **Capex.** Capex = total cores x $500 per core. Memory and disk are recorded but not priced.
6. **Give-back.** The agent asks: "Can you give back equivalent cores from hosts or apps you are retiring?" The give-back can be given in cores, or as host groups (for example "40 hosts x 12 cores"). It does not assume returned hosts match the new ones, since retired hosts are usually older and smaller. Net cores and capex after give-back are recalculated.
7. **Approve or Reject.** The agent shows a summary table with Approve / Reject buttons. Approve saves the request and returns a CAP ID. Reject saves nothing.
8. **Reuse.** A user can say "use the details from CAP-0002" and the agent loads that saved request and offers to reuse its App and approver details.

### Example

| Step | Result |
|---|---|
| "I need 50 hosts with 32 cores, 256 GB and 2 TB each for a new risk app" | 1,600 cores, 12,800 GB, 100 TB, capex $800K |
| Give back 40 hosts x 12 cores | 480 cores back, 1,120 net, capex $560K, savings $240K |
| Region Americas, split 50:50 | USDC1 and USDC2, 800 cores each |
| App details, then Approve | Saved as CAP-0001 |

All rates and data centers are sample data in `src/config.json`.

## How it meets the assignment

| Requirement | How it is done |
|---|---|
| LLM | Llama 3.3 on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) through the `AI` binding |
| Workflow / coordination | The agent runs as a Durable Object on a Worker (Cloudflare Agents SDK). Tools run each step: calculateResources, calculateCapex, applyGiveBack, validateSplit, buildSummary, submitRequest, lookupRequest, listDataCenters |
| User input via chat | React chat UI served by the same Worker, over WebSockets |
| Memory or state | Chat history and saved CAP requests are stored in the Durable Object's built-in SQL storage, so they persist across page reloads and sessions |

## Design choices

- **All math happens in code, not in the model.** The model decides which tool to call. The tools calculate cores, memory, disk, capex, give-back and splits. The saved record uses the numbers the server calculated, not numbers the model repeats back.
- **No guessing.** Every detail must appear in something the user typed. Placeholders such as "unknown", "tbd", "me" or "myself" are rejected, and a CAP ID is never accepted as an App ID.
- **Server-written blocks.** The capacity estimate, give-back result, "please provide" lists and summary table are written by the server, so they always appear in the right order and cannot be reworded by the model.
- **Human approval.** Submit uses the Agents SDK human-in-the-loop flow. Nothing is saved until the requester clicks Approve.
- **Guard rails for Llama 3.3.** In testing, Llama 3.3 sometimes garbled streamed tool arguments, sent numbers as strings, invented details, or wrote a tool call as plain text. The app runs model steps non-streamed and replays them as a stream (`simulateStreamingMiddleware`), accepts numbers sent as text, stops retrying a tool after two failures and asks the user instead, and never shows raw tool-call text.
- **Cost limits.** A daily cap of 200 user messages protects the public demo. If Workers AI returns a quota or rate-limit error, the chat shows a clear message instead of nothing.

## Run it locally

Prerequisites: Node.js (LTS), a Cloudflare account.

```bash
git clone https://github.com/ron-shah/capacity-intake-agent.git
cd capacity-intake-agent
npm install
npx wrangler login
npm run dev
```

Open the local URL it prints (usually http://localhost:5173).

Workers AI calls go to Cloudflare even when running locally, so they count against your account's Workers AI usage. The free plan includes 10,000 Neurons per day.

## Deploy

```bash
npm run deploy
```

This builds the app and deploys it to your `workers.dev` subdomain. Run the build before deploying; `npx wrangler deploy` on its own uploads whatever is in `dist/`, which may be an old build.

## Project structure

| Path | What it holds |
|---|---|
| `src/server.ts` | The agent (Durable Object): chat handling, storage, approval flow, daily cap |
| `src/tools.ts` | Model setup, system prompt and tool definitions |
| `src/capacity.ts` | Calculation and validation logic (resources, capex, give-back, split parsing, CAP records) |
| `src/config.json` | Sample rate ($500 per core) and the regions and data centers |
| `src/app.tsx` | Chat UI |
| `prompts/` | Exported Claude Code sessions used to build the project (see PROMPTS.md) |

## Limits and next steps

- Rates and data centers are sample data.
- The MD approver is recorded only. A next step would route the request to the MD for sign-off.
- Give-back cores come from the requester. A next step would look up the requester's existing hosts in a CMDB or asset inventory, so requesters do not need to know host specs and cannot overstate the give-back.
- Capex is cores only. Server models, data center rates, network, power and depreciation are out of scope.
- Llama 3.3 needed several guard rails to call tools reliably (see Design choices).

## Credits

Built on Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter) template (MIT license). Built with AI assistance (Claude Code); the design decisions and prompts are in [PROMPTS.md](PROMPTS.md).
