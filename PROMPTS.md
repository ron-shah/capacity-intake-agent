# PROMPTS.md

This project was built with AI assistance. I planned the design in a chat with Claude, then used Claude Code in the project folder to write and test the code. This file lists the design decisions I made along the way and the prompts I gave Claude Code, in order.

The full, unedited Claude Code session is in [`prompts/claude-code-session-5.md`](prompts/claude-code-session-5.md). Sessions 1 to 4 are earlier exports of the same session.

## Design decisions

These came out of the planning chat, before and during the build.

| Decision | Why |
|---|---|
| Intake only. No supply check, risk flags or daily digest. | Keep the build to a few hours and focus on the part that matters most: getting a complete, costed request. |
| Capex based on cores only, at a sample rate of $500 per core. Memory and disk are recorded but not priced. | Simple and easy to explain. Cores are the main cost driver in most on-prem requests. |
| On-prem, not public cloud: three regions (Americas, EMEA, APAC) with two data centers each (USDC1/2, EUDC1/2, ASDC1/2). | Matches how enterprise infrastructure teams plan capacity in their own data centers. |
| Ask the requester for a core give-back and recalculate capex. | Giving back old capacity at intake brings the net capex down before the request reaches the approver. |
| Give-back can be given as a host count, but the agent must ask cores per returned host and not assume they match the new hosts. | Retired hosts are usually older and smaller. 40 old 12-core hosts are not 40 new 32-core hosts. |
| No CMDB lookup for give-back. The agent asks the requester. | Kept in scope. A CMDB lookup is listed as a next step. |
| Requester details: App name, App ID, Business Unit, requester, MD approver, environment. MD approver is recorded only. | These are needed for a real request. Routing to the MD for sign-off would add a second approval flow, so it is a next step. |
| Region and data center split must come from the user, never defaulted. | The agent defaulted to Americas / USDC1 in testing. Location drives where hardware lands, so it cannot be guessed. |
| Memory and disk must be asked for. Defaults (8 GB per core, 100 GB disk per host) apply only when the user says they do not know, and are marked "assumed default". | The agent invented memory and disk in testing. Defaults are fine when the requester truly does not know, but they must be visible. |
| Reject vague names such as "me" or "unknown". | A request needs real names for the requester and approver. |
| Let a requester reuse details from an earlier request by CAP ID. | Saves retyping App and approver details for repeat requests. |
| Llama 3.3 on Workers AI. | Recommended by the assignment. Testing used up the free daily Workers AI allocation, so I moved the account to the Workers Paid plan to keep testing. |

## Claude Code prompts

### 1. Build the agent

```text
This project is the Cloudflare agents-starter. Turn it into a "Capacity Intake Agent"
for ON-PREM infrastructure capacity requests (our own data centers, not public cloud).
Read src/server.ts, src/app.tsx and wrangler.jsonc first, then make these changes.

GOAL
A chat agent that takes an on-prem capacity request, converts it into total cores,
memory (GB) and disk (TB), calculates capex based on cores only, asks the requester
for a core give-back from retiring hosts/apps, and recalculates capex after the
give-back.

1. REMOVE the demo tools (weather, timezone, scheduling demos, etc.) and their UI bits.
   Keep the chat, streaming and the Workers AI setup. Use a Workers AI model that is
   available on the Workers Free plan and supports tool calling.

2. ADD src/config.json (sample data, clearly marked as sample):
   {
     "currency": "USD",
     "perCore": 500,
     "note": "Sample rate and data centers for demo only",
     "regions": {
       "Americas": ["USDC1", "USDC2"],
       "EMEA": ["EUDC1", "EUDC2"],
       "APAC": ["ASDC1", "ASDC2"]
     }
   }

3. ADD server-side tools. All math and validation must happen in code, never in the model:
   - listDataCenters: returns the regions and their data centers from config.json.
   - calculateResources: input is EITHER hostCount + coresPerHost + memoryGBPerHost +
     diskTBPerHost, OR direct totals. Returns totalCores, totalMemoryGB, totalDiskTB.
   - calculateCapex: capex = totalCores x perCore from config.json. Memory and disk are
     NOT priced. Returns cores, rate and capex.
   - applyGiveBack: input requestedCores plus EITHER giveBackCores OR a list of
     give-back host groups [{ hostCount, coresPerHost }]. For groups,
     giveBackCores = sum(hostCount x coresPerHost). Cap giveBackCores at requestedCores.
     netCores = requestedCores - giveBackCores. Returns giveBackCores, netCores,
     capex before, capex after (netCores x perCore) and savings.
     Memory and disk stay as requested.
   - submitRequest: validates that the data center belongs to the chosen region, then
     saves the final request (app name, owner, environment, region, data center, total
     cores/memory/disk, give-back cores, net cores, capex before/after, timestamp) in the
     agent's state or SQL storage, and returns a request ID like CAP-0001. Only call it
     after the user confirms the summary.

4. SYSTEM PROMPT: act like an on-prem capacity intake coordinator. Collect app name,
   owner, environment (prod/non-prod), region (Americas, EMEA, APAC), then data center
   within that region, and the need (hosts x per-host spec, or totals of cores,
   memory GB, disk TB). If the user gives a host count without a per-host spec, ask
   for cores, memory and disk per host. If the user names a data center that is not in
   the chosen region, say so and list the valid ones. Ask for missing details one or
   two at a time. Never guess numbers.
   After capex is calculated, ask: "Can you give back equivalent cores from hosts or
   apps you are retiring?" If the user gives the give-back as a host count, ask how many
   cores each returned host has. Do not assume returned hosts match the new hosts.
   Accept mixed groups (e.g. 20 x 12 cores and 20 x 24 cores). Then call applyGiveBack.
   Show a short summary table (region, data center, cores, memory, disk, give-back
   cores, net cores, capex before/after, savings) and ask for confirmation before
   submitting. Plain, short replies. Format money as $200K style.

5. UI: change the title to "Capacity Intake Agent", update the intro text to say it
   handles on-prem capacity requests, and change the suggested starter prompts to
   examples like:
   "I need 50 hosts with 32 cores, 256 GB and 2 TB each for a new risk app in USDC1"
   "Requesting 1,200 cores, 9 TB memory and 200 TB disk in EMEA for a pricing platform"

6. Run the typecheck/lint script from package.json and fix any errors.
   Do not deploy and do not commit. When done, summarize what you changed per file.
```

### 2. Use Llama 3.3

```text
Use Llama 3.3 on Workers AI as the model (@cf/meta/llama-3.3-70b-instruct-fp8-fast).
Confirm it supports tool calling in this setup. If it is not available on the Workers
Free plan or tool calling does not work, tell me instead of switching models silently.
```

Claude Code found that streamed tool calls arrived garbled with Llama 3.3, and that the submit step could save numbers passed by the model instead of the server's own results. It proposed three fixes: simulated streaming, accepting numbers sent as text, and taking saved numbers from the server.

### 3. Approve the fixes and test

```text
Yes, go ahead with 1-3 on Llama 3.3. After the fixes, rerun the three-turn test with:
"I need 50 hosts with 32 cores, 256 GB and 2 TB each for a new risk app in USDC1",
then give back 40 hosts x 12 cores, then confirm.
Expected: 1,600 cores, $800K before, 480 give-back cores, 1,120 net, $560K after,
$240K savings. Check that the saved CAP record matches the summary exactly.
Report the results and how many retries each tool needed.
```

### 4. Capex before give-back, Approve / Reject buttons, requester details

```text
Four more changes:
1. After calculateCapex, always show the requester a short block with total cores,
   memory, disk and capex BEFORE asking the give-back question. Do not rely on the
   prompt alone: have calculateCapex return a ready-to-show summary line and make the
   model display it.
2. Replace the confirmation word-list check with the starter's built-in human-in-the-loop
   approval: submitRequest should show Approve / Reject buttons in the chat, and only save
   when Approve is clicked. Keep the other submit checks (no placeholders, no guessed
   values).
3. Show numbers with thousands separators in all chat output (1,600 not 1600).
4. Add requester details. The agent must collect all of these before the summary:
   App name, App ID, Business Unit, Requester (owner), MD approver name, Environment
   (prod/non-prod). App ID, Business Unit and MD approver are required free text.
   Apply the same no-guessing and no-placeholder checks to all of them (each value must
   appear in something the user typed). Show them at the top of the summary table and
   save them in the CAP record. The MD approver is recorded only; no routing or
   notification.
Run npm run check, rerun the four-turn test (add App ID "APP-10234", Business Unit
"Risk Technology", MD approver "John Smith" to the details turn), and confirm the
results. Do not deploy or commit.
```

### 5. Region and data center split, validation, quota message, daily cap

```text
Fixes from my browser test (Llama 3.3, paid plan now):
1. LOCATION AND SPLIT. The agent filled in Region "Americas" and Data center "USDC1"
   even though I never gave a location. Change this:
   - Region must be stated by the user (Americas, EMEA, APAC). Never default it.
   - Then ask how to split the request across the two data centers in that region
     (e.g. all in one DC, 50/50, or a host count per DC). Never default the split.
   - If the request was given in hosts, the split is in whole hosts and must add up to
     the total host count. If it was given in totals, the split is in percent, must add
     up to 100, and cores are rounded to whole numbers (memory and disk split in the
     same proportion).
   - Add a validateSplit step in code: DCs must belong to the chosen region, values must
     add up, no negatives. If invalid, explain and ask again.
   - Capex and give-back stay at the total request level. The summary table shows one
     row per DC with its cores, memory and disk, plus the totals. Save the split in the
     CAP record.
   - Region and split go in the "please provide" list if missing, with the same
     no-guessing check as the other details.
2. When buildSummary is blocked for missing details, the chat shows a red "Error" badge
   ("An error occurred"). That is expected validation, not an error. Return a normal
   result listing the missing fields so the badge shows Done, not Error.
3. If Workers AI returns a quota or rate-limit error, show a clear chat message
   ("The AI service limit has been reached. Please try again later.") instead of
   showing nothing.
4. Add a simple daily cap of 200 chat messages across the app, stored in the agent's
   storage. Over the cap, reply with a short "Daily demo limit reached" message
   without calling the model.
Run npm run check. Test ONCE against Workers AI (to save quota) with:
"10 hosts each of 2 cores, 8gb mem/core, 100GB disk per host", region EMEA,
split 6 hosts EUDC1 and 4 hosts EUDC2. Expected: EUDC1 12 cores / 96 GB / 0.6 TB,
EUDC2 8 cores / 64 GB / 0.4 TB, total 20 cores, $10K capex.
Do not deploy or commit.
```

### 6. Do not invent memory and disk

```text
Browser test bug: I typed only "300 cores" and the agent reported memory 1,200 GB and
disk 60 TB that I never gave. Fix:
1. Memory and disk must come from the user. If missing, ask for them (totals or per
   host) before calculating. Never invent them or derive them silently.
2. Defaults apply ONLY after the user says they do not know (e.g. "don't know",
   "not sure", "use default"):
   - Memory: 8 GB per core.
   - Disk: 100 GB per host, only when a host count is known.
   - If disk is unknown and there is no host count, ask for a host count or a total
     disk size. Do not invent a disk default without hosts.
   Apply defaults in code, not in the model.
3. Mark any defaulted value as "assumed default" in the capacity estimate, the summary
   table and the saved CAP record.
4. Reject vague requester values like "me" or "myself" and ask for a name.
Run npm run check. Test ONCE with: "300 cores" -> reply "don't know" for memory and
disk -> it should apply 8 GB/core (2,400 GB) and then ask for host count or total disk.
Do not deploy or commit.
```

### 7. Missing inputs should be questions, not errors

```text
Browser test bug: I typed "20 hosts, americas split". validateSplit ran, then
calculateResources failed 5 times with "An error occurred" and the chat showed no reply.
Fix:
1. calculateResources must not throw for missing inputs. Return a normal result listing
   what is missing (cores per host, memory, disk), and have the server write the
   "please provide" question into the chat and end the turn, the same way buildSummary
   does now. Missing memory/disk should offer the "don't know" defaults
   (8 GB/core, 100 GB disk per host).
2. "split" with no ratio is incomplete. Ask how to split (all in one DC, 50/50, or hosts
   per DC). Do not run validateSplit until the ratio and the totals are known.
3. Guard rail for all tools: if the same tool fails twice in a turn, stop retrying and
   ask the user a plain question instead. Never end a turn with no text reply.
4. Real tool errors (bugs, not missing input) should show a short friendly message,
   not a silent failure.
Run npm run check. Test ONCE with "20 hosts, americas split": it should ask for cores,
memory and disk per host and how to split. Then answer "32 cores, don't know memory
and disk, 50/50" and check: 640 cores, 5,120 GB (assumed), 2 TB (assumed),
USDC1/USDC2 320 cores each, $320K capex. Do not deploy or commit.
```

### 8. Split ratios, reuse by CAP ID, Reject message

```text
Browser test bugs:
1. "split 50:50" was not accepted; only "split equally" worked. Accept ratios written as
   50:50, 50/50, 50-50, 60:40, "60/40", percentages, and "equal/equally/evenly".
   Parse this in code, not in the model.
2. I typed "use fro CAP-002" (meaning: reuse details from CAP-0002). The agent saved
   App name "fro" and App ID "CAP-002". Add a lookupRequest tool: if the user refers to
   a CAP ID (CAP-2, CAP-002, CAP-0002), load that saved request and offer to reuse its
   App name, App ID, Business Unit, Requester and MD approver, then ask to confirm.
   If the CAP ID does not exist, say so. Never accept a CAP ID as an App ID.
3. I clicked Reject. The badge showed "Rejected" but the chat said "The request has been
   submitted." After Reject the server must write "Submission cancelled. Nothing was
   saved. What would you like to change?" and drop any model text. Check that nothing
   was saved and the CAP counter did not move.
Run npm run check, test ONCE covering all three, do not deploy or commit.
```

## How I tested

After each Claude Code change I tested in the browser with `npm run dev`, then sent the bugs I found back as the next prompt. Prompts 5 to 8 all came from those browser tests. The final version was deployed with `npm run deploy` and tested end to end on the live URL.
