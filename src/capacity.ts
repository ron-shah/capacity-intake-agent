/**
 * Pure capacity math and validation. The model never does arithmetic —
 * every number shown to the user comes from these functions.
 *
 * NOTE: config.json holds SAMPLE data (rate and data centers) for demo only.
 */
import config from "./config.json";

export const REGIONS = ["Americas", "EMEA", "APAC"] as const;
export type Region = (typeof REGIONS)[number];

/** Memory uses binary units (1 TB = 1024 GB), as RAM is sized. */
export const MEMORY_GB_PER_TB = 1024;
/** Disk uses decimal units (1 TB = 1000 GB), as storage is sold. */
export const DISK_GB_PER_TB = 1000;

export const perCore: number = config.perCore;
export const currency: string = config.currency;
const regionMap: Record<Region, string[]> = config.regions;

export type Fail = { ok: false; error: string };

const fail = (error: string): Fail => ({ ok: false, error });

const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Formats money as $200K / $1.25M style. */
export function formatMoney(amount: number): string {
  const prefix = currency === "USD" ? "$" : `${currency} `;
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));
  if (abs >= 1_000_000_000)
    return `${sign}${prefix}${trim(abs / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${sign}${prefix}${trim(abs / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${sign}${prefix}${trim(abs / 1_000, 1)}K`;
  return `${sign}${prefix}${trim(abs, 2)}`;
}

/** Formats numbers with thousands separators: 1600 -> "1,600". */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export const GIVE_BACK_QUESTION =
  "Can you give back equivalent cores from hosts or apps you are retiring?";

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

const esc = (v: string) => v.replace(/\|/g, "\\|");

function mdTable(header: string[], rows: string[][]) {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)
  ].join("\n");
}

// ── Data centers ─────────────────────────────────────────────────────

export function normalizeRegion(region: string): Region | undefined {
  return REGIONS.find((r) => r.toLowerCase() === region.trim().toLowerCase());
}

export function dataCentersIn(region: Region): string[] {
  return regionMap[region];
}

export function listDataCenters(region?: string, dataCenter?: string) {
  const all = { regions: regionMap, note: config.note };
  if (!region) {
    if (dataCenter) {
      return fail("Provide a region together with the data center to check.");
    }
    return { ok: true as const, ...all };
  }
  const r = normalizeRegion(region);
  if (!r) {
    return fail(
      `Unknown region "${region}". Valid regions: ${REGIONS.join(", ")}.`
    );
  }
  const dataCenters = regionMap[r];
  if (!dataCenter) return { ok: true as const, region: r, dataCenters };
  const dc = dataCenter.trim().toUpperCase();
  const valid = dataCenters.includes(dc);
  return {
    ok: true as const,
    region: r,
    dataCenter: dc,
    valid,
    dataCenters,
    message: valid
      ? `${dc} is in ${r}.`
      : `${dc} is not in ${r}. Valid data centers in ${r}: ${dataCenters.join(", ")}.`
  };
}

// ── Resources ────────────────────────────────────────────────────────

export interface ResourceInput {
  mode: "perHost" | "totals";
  /** Required for perHost; optional for totals (enables the disk default). */
  hostCount?: number;
  coresPerHost?: number;
  /** Memory per host in GB. Give this OR memoryGBPerCore. */
  memoryGBPerHost?: number;
  /** Memory per core in GB (multiplied by coresPerHost in code). */
  memoryGBPerCore?: number;
  /** Disk per host, in diskUnit. */
  diskPerHost?: number;
  totalCores?: number;
  totalMemory?: number;
  memoryUnit?: "GB" | "TB";
  totalDisk?: number;
  /** Unit of diskPerHost / totalDisk (default TB). */
  diskUnit?: "TB" | "GB";
  /** The user said they don't know the memory. */
  memoryUnknown?: boolean;
  /** The user said they don't know the disk. */
  diskUnknown?: boolean;
}

/** Per-host spec kept for splitting a host-based request across DCs. */
export interface HostSpec {
  hostCount: number;
  coresPerHost: number;
  memoryGBPerHost: number;
  diskTBPerHost: number;
}

/** Which values were filled in from defaults (null = given by the user). */
export interface AssumedDefaults {
  memory: string | null;
  disk: string | null;
}

export const DEFAULT_MEMORY_GB_PER_CORE = 8;
export const DEFAULT_DISK_GB_PER_HOST = 100;
export const MEMORY_DEFAULT_TEXT = `${DEFAULT_MEMORY_GB_PER_CORE} GB per core`;
export const DISK_DEFAULT_TEXT = `${DEFAULT_DISK_GB_PER_HOST} GB per host`;

export const MEMORY_LABEL = `Memory (total, or per host / per core), or say "don't know" to use ${MEMORY_DEFAULT_TEXT}`;
export const DISK_LABEL = `Disk (total, or per host), or say "don't know" to use ${DISK_DEFAULT_TEXT} (needs a host count)`;
export const DISK_NEEDS_HOSTS_LABEL = `Host count or total disk size (the ${DISK_DEFAULT_TEXT} disk default needs a host count)`;

/** The user said they don't know a value / asked for defaults. */
const DONT_KNOW =
  /\b(don'?t know|do not know|dont know|not sure|unsure|no idea|use (the )?defaults?|defaults? (is|are) fine|go with (the )?defaults?)\b/i;

export function saidDontKnow(userText: string) {
  return DONT_KNOW.test(userText);
}

/** Marks a value as defaulted, e.g. "2,400 GB (assumed default: 8 GB per core)". */
export function withAssumed(value: string, assumed: string | null) {
  return assumed ? `${value} (assumed default: ${assumed})` : value;
}

const toDiskTB = (value: number, unit: "TB" | "GB") =>
  unit === "GB" ? value / DISK_GB_PER_TB : value;

export type ResourcesNeedInput = {
  ok: false;
  status: "needs_input";
  missing: string[];
  /** Values already worked out (shown above the "please provide" list). */
  known: string[];
};

/**
 * Computes total cores, memory and disk. Every number must appear in what
 * the user typed (the model may not invent or derive one). Memory and disk
 * defaults apply only when the user said they don't know:
 *   - memory: 8 GB per core
 *   - disk: 100 GB per host, and only when a host count is known
 */
export function calculateResources(input: ResourceInput, userText: string) {
  const nums = numbersInText(userText);
  const stated = (v: number | undefined): v is number =>
    v !== undefined && nums.has(v);
  const dontKnow = saidDontKnow(userText);
  const memoryDefaultOk = input.memoryUnknown === true && dontKnow;
  const diskDefaultOk = input.diskUnknown === true && dontKnow;
  const missing: string[] = [];
  const known: string[] = [];
  const assumed: AssumedDefaults = { memory: null, disk: null };
  const needInput = (): ResourcesNeedInput => ({
    ok: false,
    status: "needs_input",
    missing,
    known
  });

  if (input.mode === "perHost") {
    const { hostCount, coresPerHost } = input;
    if (!stated(hostCount)) missing.push("Host count");
    if (!stated(coresPerHost)) missing.push("Cores per host");
    if (
      !stated(input.memoryGBPerHost) &&
      !stated(input.memoryGBPerCore) &&
      !memoryDefaultOk
    )
      missing.push(MEMORY_LABEL);
    if (!stated(input.diskPerHost) && !diskDefaultOk) missing.push(DISK_LABEL);
    if (missing.length) return needInput();

    if (!isPositiveInt(hostCount))
      return fail("hostCount must be a whole number > 0.");
    if (!isPositiveInt(coresPerHost))
      return fail("coresPerHost must be a whole number > 0.");

    let memPerHost: number;
    if (stated(input.memoryGBPerHost)) memPerHost = input.memoryGBPerHost;
    else if (stated(input.memoryGBPerCore))
      memPerHost = input.memoryGBPerCore * coresPerHost;
    else {
      memPerHost = DEFAULT_MEMORY_GB_PER_CORE * coresPerHost;
      assumed.memory = MEMORY_DEFAULT_TEXT;
    }
    let diskTBPerHost: number;
    if (stated(input.diskPerHost)) {
      diskTBPerHost = round(
        toDiskTB(input.diskPerHost, input.diskUnit ?? "TB"),
        6
      );
    } else {
      diskTBPerHost = DEFAULT_DISK_GB_PER_HOST / DISK_GB_PER_TB;
      assumed.disk = DISK_DEFAULT_TEXT;
    }
    if (!isPositive(memPerHost)) return fail("Memory per host must be > 0.");
    if (!isPositive(diskTBPerHost)) return fail("Disk per host must be > 0.");

    const hostSpec: HostSpec = {
      hostCount,
      coresPerHost,
      memoryGBPerHost: round(memPerHost, 3),
      diskTBPerHost
    };
    return {
      ok: true as const,
      basis: `${formatNumber(hostCount)} hosts x (${formatNumber(coresPerHost)} cores, ${formatNumber(hostSpec.memoryGBPerHost)} GB memory, ${formatNumber(diskTBPerHost)} TB disk)`,
      totalCores: hostCount * coresPerHost,
      totalMemoryGB: round(hostCount * memPerHost),
      totalDiskTB: round(hostCount * diskTBPerHost, 3),
      hostSpec,
      assumed
    };
  }

  if (input.mode === "totals") {
    const { totalCores, hostCount } = input;
    // Collect everything that's missing (not just the first item).
    const coresKnown = stated(totalCores);
    if (!coresKnown) missing.push("Total cores");
    else if (!isPositiveInt(totalCores))
      return fail("totalCores must be a whole number > 0.");
    const hosts = stated(hostCount) ? hostCount : undefined;
    if (hosts !== undefined && !isPositiveInt(hosts))
      return fail("hostCount must be a whole number > 0.");

    let totalMemoryGB: number | undefined;
    if (stated(input.totalMemory)) {
      totalMemoryGB = round(
        (input.memoryUnit ?? "GB") === "TB"
          ? input.totalMemory * MEMORY_GB_PER_TB
          : input.totalMemory
      );
    } else if (memoryDefaultOk) {
      // The 8 GB/core default needs the core count (asked for above if missing).
      if (coresKnown) {
        totalMemoryGB = DEFAULT_MEMORY_GB_PER_CORE * totalCores;
        assumed.memory = MEMORY_DEFAULT_TEXT;
        known.push(
          `Memory: ${withAssumed(`${formatNumber(totalMemoryGB)} GB`, assumed.memory)}`
        );
      }
    } else {
      missing.push(MEMORY_LABEL);
    }

    let totalDiskTB: number | undefined;
    if (stated(input.totalDisk)) {
      totalDiskTB = round(toDiskTB(input.totalDisk, input.diskUnit ?? "TB"), 3);
    } else if (diskDefaultOk && hosts !== undefined) {
      totalDiskTB = round(
        (hosts * DEFAULT_DISK_GB_PER_HOST) / DISK_GB_PER_TB,
        3
      );
      assumed.disk = DISK_DEFAULT_TEXT;
    } else if (diskDefaultOk) {
      // No host count: never invent a disk default.
      missing.push(DISK_NEEDS_HOSTS_LABEL);
    } else {
      missing.push(DISK_LABEL);
    }

    if (
      missing.length ||
      !coresKnown ||
      totalMemoryGB === undefined ||
      totalDiskTB === undefined
    )
      return needInput();
    if (!isPositive(totalMemoryGB)) return fail("Memory must be > 0.");
    if (!isPositive(totalDiskTB)) return fail("Disk must be > 0.");
    return {
      ok: true as const,
      basis: "direct totals",
      totalCores,
      totalMemoryGB,
      totalDiskTB,
      hostSpec: null,
      assumed
    };
  }

  return fail('mode must be "perHost" or "totals".');
}

// ── Capex ────────────────────────────────────────────────────────────

/** Capex is priced on cores only. Memory and disk are not priced. */
export function capexFor(cores: number) {
  return cores * perCore;
}

export function calculateCapex(totals: {
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  assumed?: AssumedDefaults;
}) {
  const { totalCores, totalMemoryGB, totalDiskTB } = totals;
  const assumed = totals.assumed ?? { memory: null, disk: null };
  if (!isPositiveInt(totalCores))
    return fail("totalCores must be a whole number > 0.");
  const capex = capexFor(totalCores);
  // Ready-to-show block; the server writes it into the chat verbatim.
  const display = [
    "**Capacity estimate**",
    "",
    `- Total cores: ${formatNumber(totalCores)}`,
    `- Memory: ${withAssumed(`${formatNumber(totalMemoryGB)} GB`, assumed.memory)}`,
    `- Disk: ${withAssumed(`${formatNumber(totalDiskTB)} TB`, assumed.disk)}`,
    `- Capex: ${formatMoney(capex)} (${formatNumber(totalCores)} cores x ${formatMoney(perCore)} per core; memory and disk are not priced)`,
    "",
    GIVE_BACK_QUESTION
  ].join("\n");
  return {
    ok: true as const,
    cores: totalCores,
    perCoreRate: perCore,
    currency,
    capex,
    capexFormatted: formatMoney(capex),
    display,
    note: "The display block (with the give-back question) has already been shown to the user. Do not repeat it; wait for the user's answer."
  };
}

// ── Give-back ────────────────────────────────────────────────────────

export interface GiveBackGroup {
  hostCount: number;
  coresPerHost: number;
}

export function applyGiveBack(input: {
  requestedCores: number;
  giveBackCores?: number;
  giveBackGroups?: GiveBackGroup[];
}) {
  const { requestedCores, giveBackCores, giveBackGroups } = input;
  if (!isPositiveInt(requestedCores))
    return fail("requestedCores must be a whole number > 0.");

  const hasCores = giveBackCores !== undefined;
  const hasGroups = giveBackGroups !== undefined && giveBackGroups.length > 0;
  if (hasCores === hasGroups) {
    return fail(
      "Provide EITHER giveBackCores OR giveBackGroups, not both or neither."
    );
  }

  let rawGiveBack: number;
  let breakdown: string | undefined;
  if (hasGroups) {
    for (const g of giveBackGroups) {
      if (!isPositiveInt(g.hostCount) || !isPositiveInt(g.coresPerHost)) {
        return fail(
          "Each give-back group needs whole-number hostCount and coresPerHost > 0. Ask the user how many cores each returned host has."
        );
      }
    }
    rawGiveBack = giveBackGroups.reduce(
      (s, g) => s + g.hostCount * g.coresPerHost,
      0
    );
    breakdown = giveBackGroups
      .map(
        (g) =>
          `${formatNumber(g.hostCount)} x ${formatNumber(g.coresPerHost)} cores = ${formatNumber(g.hostCount * g.coresPerHost)}`
      )
      .join("; ");
  } else {
    if (!isNonNegativeInt(giveBackCores))
      return fail("giveBackCores must be a whole number >= 0.");
    rawGiveBack = giveBackCores;
  }

  const capped = rawGiveBack > requestedCores;
  const effectiveGiveBack = Math.min(rawGiveBack, requestedCores);
  const netCores = requestedCores - effectiveGiveBack;
  const capexBefore = capexFor(requestedCores);
  const capexAfter = capexFor(netCores);
  const savings = capexBefore - capexAfter;

  return {
    ok: true as const,
    requestedCores,
    offeredGiveBackCores: rawGiveBack,
    giveBackCores: effectiveGiveBack,
    capped,
    ...(breakdown ? { breakdown } : {}),
    netCores,
    perCoreRate: perCore,
    capexBefore,
    capexAfter,
    savings,
    capexBeforeFormatted: formatMoney(capexBefore),
    capexAfterFormatted: formatMoney(capexAfter),
    savingsFormatted: formatMoney(savings),
    display: [
      "**Give-back applied**",
      "",
      `- Give-back cores: ${formatNumber(effectiveGiveBack)}${breakdown ? ` (${breakdown})` : ""}`,
      ...(capped
        ? [
            `- Offered ${formatNumber(rawGiveBack)} cores; capped at the requested ${formatNumber(requestedCores)}`
          ]
        : []),
      `- Net cores: ${formatNumber(netCores)}`,
      `- Capex: ${formatMoney(capexBefore)} before, ${formatMoney(capexAfter)} after, ${formatMoney(savings)} savings`,
      "- Memory and disk stay as requested"
    ].join("\n"),
    note: capped
      ? `Give-back of ${rawGiveBack} cores exceeds the request; capped at ${requestedCores}. Memory and disk stay as requested.`
      : "Memory and disk stay as requested."
  };
}

// ── Grounding helpers ────────────────────────────────────────────────

/** Values a model may fill in instead of asking the user. */
const PLACEHOLDERS = new Set([
  "",
  "unknown",
  "n/a",
  "na",
  "none",
  "tbd",
  "tba",
  "null",
  "undefined",
  "not provided",
  "not specified",
  "-",
  // Vague stand-ins for a person's name.
  "me",
  "myself",
  "i",
  "mine",
  "self",
  "yours truly",
  "us",
  "we",
  "user",
  "the user",
  "requester",
  "owner",
  "my manager",
  "my boss",
  "manager",
  "boss"
]);

function isPlaceholder(value: string) {
  return PLACEHOLDERS.has(value.trim().toLowerCase());
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** True when the value appears in what the user typed. */
export function mentionedByUser(value: string, userText: string) {
  const v = normalize(value);
  return v.length > 0 && !isPlaceholder(v) && normalize(userText).includes(v);
}

const NON_PROD =
  /\bnon[\s-]?prod(uction)?\b|\b(dev|development|test|testing|qa|uat|staging|stage)\b/i;

/** True when the user stated this environment (not inferred by the model). */
export function environmentStatedByUser(
  environment: "prod" | "non-prod",
  userText: string
) {
  if (environment === "non-prod") return NON_PROD.test(userText);
  const withoutNonProd = userText.replace(
    new RegExp(NON_PROD.source, "gi"),
    " "
  );
  return /\bprod(uction)?\b/i.test(withoutNonProd);
}

/** True when the user typed the region name (never inferred from a DC). */
export function regionStatedByUser(region: Region, userText: string) {
  return new RegExp(`\\b${region}\\b`, "i").test(userText);
}

/** "CAP-2", "CAP-002", "cap 0002", "CAP0002" -> 2. */
const CAP_ID = /\bCAP[\s-]?0*(\d{1,6})\b/i;

export function parseCapId(text: string): number | null {
  const m = text.match(CAP_ID);
  return m ? Number(m[1]) : null;
}

/** The last CAP ID mentioned in a message, if any. */
export function lastCapId(text: string): number | null {
  const all = [...text.matchAll(new RegExp(CAP_ID.source, "gi"))];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

/** Maps common spellings to "prod" / "non-prod"; anything else is invalid. */
export function normalizeEnvironment(
  value: string
): "prod" | "non-prod" | undefined {
  const v = value.trim().toLowerCase();
  if (v === "prod" || v === "production") return "prod";
  if (/^non[\s-]?prod(uction)?$/.test(v)) return "non-prod";
  return undefined;
}

// ── Requester details ────────────────────────────────────────────────

export interface RequestDetails {
  appName: string;
  appId: string;
  businessUnit: string;
  requester: string;
  mdApprover: string;
  environment: "prod" | "non-prod";
}

export type DetailsInput = {
  [K in keyof RequestDetails]?: string | null;
};

const DETAIL_LABELS: Record<
  Exclude<keyof RequestDetails, "environment">,
  string
> = {
  appName: "App name",
  appId: "App ID",
  businessUnit: "Business Unit",
  requester: "Requester (owner)",
  mdApprover: "MD approver name"
};

export const ENVIRONMENT_LABEL = "Environment (prod or non-prod)";

/**
 * Checks requester details: no placeholders, every free-text value must
 * appear in something the user typed, and the environment must be stated by
 * the user. Returns the clean details or the labels still needed.
 */
export function checkDetails(
  input: DetailsInput,
  userText: string
): { details: RequestDetails; missing: [] } | { missing: string[] } {
  const missing: string[] = [];
  const clean: Partial<RequestDetails> = {};
  for (const [key, label] of Object.entries(DETAIL_LABELS) as [
    keyof typeof DETAIL_LABELS,
    string
  ][]) {
    const value = (input[key] ?? "").trim();
    if ((key === "appId" || key === "appName") && parseCapId(value) !== null) {
      // A capacity request ID (CAP-0002) is never an App ID or App name.
      missing.push(
        `${label}: "${value}" is a capacity request ID, not an ${label}`
      );
    } else if (
      value &&
      isPlaceholder(value) &&
      (key === "requester" || key === "mdApprover")
    ) {
      // e.g. "me" / "myself" / "my manager": ask for an actual name.
      missing.push(`${label}: a person's name, not "${value}"`);
    } else if (!mentionedByUser(value, userText)) missing.push(label);
    else clean[key] = value;
  }
  const environment = normalizeEnvironment(input.environment ?? "");
  if (!environment || !environmentStatedByUser(environment, userText)) {
    missing.push(ENVIRONMENT_LABEL);
  } else {
    clean.environment = environment;
  }
  if (missing.length) return { missing };
  return { details: clean as RequestDetails, missing: [] };
}

// ── Data center split ────────────────────────────────────────────────

export interface AllocationInput {
  dataCenter?: string | null;
  hosts?: number | null;
  percent?: number | null;
}

export interface DcAllocation {
  dataCenter: string;
  /** Whole hosts (host-based requests only). */
  hosts: number | null;
  /** Share of the request in percent (totals-based requests only). */
  percent: number | null;
  cores: number;
  memoryGB: number;
  diskTB: number;
}

export interface SplitBasis {
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  /** Present when the request was given in hosts. */
  hostSpec: HostSpec | null;
}

export const REGION_LABEL = "Region (Americas, EMEA or APAC)";

export function splitLabel(region?: Region) {
  const where = region
    ? `${dataCentersIn(region).join(" and ")}`
    : "the two data centers in the region";
  return `How to split the request across ${where} (e.g. all in one data center, 50/50, or a host count per data center)`;
}

/** Numbers that appear in the user's text, e.g. "6 hosts ... 4" -> {6, 4}. */
function numbersInText(text: string) {
  return new Set(
    (text.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(\.\d+)?/g) ?? []).map(
      Number
    )
  );
}

const EVEN_SPLIT =
  /\b(even|evenly|equal|equally|half|halves|fifty[\s-]fifty)\b/i;

/** "60:40", "60/40", "60-40", "60 to 40" (two numbers adding up to 100). */
const RATIO_PAIR =
  /(?<![\w.:/-])(\d{1,3}(?:\.\d+)?)\s*%?\s*(?:[:/-]|\bto\b)\s*(\d{1,3}(?:\.\d+)?)\s*%?(?![\w.%]|\s*[:/-]\s*\d)/gi;
/** "60%" style percentages. */
const PERCENT = /(?<![\w.])(\d{1,3}(?:\.\d+)?)\s*%/g;

/**
 * Parses how the user wants the request split across a region's two data
 * centers, in code (never by the model). Accepts "50:50", "50/50", "50-50",
 * "60:40", "60 to 40", "60% / 40%", "100% in EUDC1", and "equal", "equally",
 * "evenly", "half". The most recent mention wins. Values are mapped to data
 * centers in the order the user named them near the ratio, otherwise in the
 * region's listed order. Returns percent per data center, or null.
 */
export function parseSplitRatio(
  userText: string,
  region: Region
): Record<string, number> | null {
  const dcs = dataCentersIn(region);
  type Candidate = { index: number; end: number; values: number[] };
  const candidates: Candidate[] = [];

  for (const m of userText.matchAll(RATIO_PAIR)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Math.abs(a + b - 100) < 1e-9) {
      candidates.push({
        index: m.index,
        end: m.index + m[0].length,
        values: [a, b]
      });
    }
  }
  // Percentages within one message, e.g. "60% EUDC1 and 40% EUDC2".
  let offset = 0;
  for (const line of userText.split("\n")) {
    const pcts = [...line.matchAll(PERCENT)];
    const vals = pcts.map((m) => Number(m[1]));
    const sum = vals.reduce((x, y) => x + y, 0);
    if (pcts.length === dcs.length && Math.abs(sum - 100) < 1e-9) {
      candidates.push({
        index: offset + pcts[0].index,
        end: offset + line.length,
        values: vals
      });
    } else if (pcts.length === 1 && vals[0] === 100) {
      candidates.push({
        index: offset + pcts[0].index,
        end: offset + line.length,
        values: [100]
      });
    }
    offset += line.length + 1;
  }
  for (const m of userText.matchAll(new RegExp(EVEN_SPLIT.source, "gi"))) {
    candidates.push({
      index: m.index,
      end: m.index + m[0].length,
      values: dcs.map(() => 100 / dcs.length)
    });
  }
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) => (b.index > a.index ? b : a));

  // Data centers named in the same message as the ratio, in order.
  const lineStart = userText.lastIndexOf("\n", latest.index) + 1;
  const lineEndRaw = userText.indexOf("\n", latest.index);
  const line = userText
    .slice(lineStart, lineEndRaw < 0 ? undefined : lineEndRaw)
    .toUpperCase();
  const named = dcs
    .map((dc) => ({ dc, at: line.indexOf(dc) }))
    .filter((x) => x.at >= 0)
    .sort((x, y) => x.at - y.at)
    .map((x) => x.dc);

  if (latest.values.length === 1) {
    // "100% in EUDC1": needs the data center named.
    if (named.length !== 1) return null;
    return Object.fromEntries(dcs.map((dc) => [dc, dc === named[0] ? 100 : 0]));
  }
  const order = [...named, ...dcs.filter((dc) => !named.includes(dc))];
  return Object.fromEntries(order.map((dc, i) => [dc, latest.values[i] ?? 0]));
}

/**
 * The region the user named, if they also said how to split it (an even
 * split, a data center name, or "all in ..."). "americas split" alone is
 * not a split ratio.
 */
export function splitRatioGiven(userText: string): Region | null {
  const region = REGIONS.find((r) => regionStatedByUser(r, userText));
  if (!region) return null;
  const dcNamed = dataCentersIn(region).some((dc) =>
    mentionedByUser(dc, userText)
  );
  return parseSplitRatio(userText, region) || dcNamed ? region : null;
}

/** The region the user named, if any. */
export function regionGiven(userText: string): Region | null {
  return REGIONS.find((r) => regionStatedByUser(r, userText)) ?? null;
}

export type SplitResult =
  | {
      ok: true;
      region: Region;
      allocations: DcAllocation[];
    }
  | {
      ok: false;
      /** Label(s) for the "please provide" list (missing / not from user). */
      missing: string[];
      /** Specific problem to explain, when the split was given but invalid. */
      problem?: string;
    };

/**
 * Validates a region and its data center split, then computes each DC's
 * cores, memory and disk.
 * - Region must be stated by the user.
 * - DCs must belong to the region; no duplicates or negatives.
 * - Host-based requests split in whole hosts that add up to the host count
 *   (a percent split is converted to hosts only if it gives whole hosts).
 * - Totals-based requests split in percent adding up to 100; cores are
 *   rounded to whole numbers (largest remainder) and memory/disk follow the
 *   same proportion.
 * - Split values must come from the user, not a default.
 */
export function validateSplit(
  input: { region?: string | null; allocations?: AllocationInput[] | null },
  basis: SplitBasis,
  userText: string
): SplitResult {
  const region = normalizeRegion(input.region ?? "") ?? regionGiven(userText);
  if (!region || !regionStatedByUser(region, userText)) {
    return { ok: false, missing: [REGION_LABEL, splitLabel()] };
  }
  const dcs = dataCentersIn(region);
  const ask = (problem?: string): SplitResult => ({
    ok: false,
    missing: [splitLabel(region)],
    problem
  });

  // A ratio the user typed ("50:50", "60/40", "evenly", ...) is parsed in
  // code and replaces whatever the model passed. Explicit host counts per
  // data center ("6 hosts EUDC1, 4 hosts EUDC2") still come from the model
  // and are checked against the user's text below.
  const ratio = parseSplitRatio(userText, region);
  const raw: AllocationInput[] = ratio
    ? dcs.map((dc) => ({ dataCenter: dc, percent: ratio[dc] }))
    : (input.allocations ?? []).filter(
        (a) => a && (a.dataCenter ?? "").trim() !== ""
      );
  if (raw.length === 0) return ask();

  const seen = new Set<string>();
  for (const a of raw) {
    const dc = (a.dataCenter ?? "").trim().toUpperCase();
    if (!dcs.includes(dc)) {
      return ask(
        `${dc} is not in ${region}. Valid data centers in ${region}: ${dcs.join(", ")}.`
      );
    }
    if (seen.has(dc)) return ask(`${dc} is listed more than once.`);
    seen.add(dc);
    for (const v of [a.hosts, a.percent]) {
      if (v !== null && v !== undefined && (!Number.isFinite(v) || v < 0)) {
        return ask("Split values can't be negative.");
      }
    }
  }
  const byDc = new Map(
    raw.map((a) => [(a.dataCenter ?? "").trim().toUpperCase(), a])
  );

  let allocations: DcAllocation[];
  const spec = basis.hostSpec;
  if (spec) {
    // Host-based: whole hosts adding up to the host count.
    const hosts: number[] = [];
    for (const dc of dcs) {
      const a = byDc.get(dc);
      let h = a?.hosts ?? null;
      if ((h === null || h === undefined) && a?.percent != null) {
        h = (spec.hostCount * a.percent) / 100;
        if (!Number.isInteger(round(h, 9))) {
          return ask(
            `${formatNumber(a.percent)}% of ${formatNumber(spec.hostCount)} hosts is not a whole number of hosts. Give a host count for each data center.`
          );
        }
        h = round(h, 9);
      }
      h = h ?? 0;
      if (!Number.isInteger(h)) {
        return ask("The split must be in whole hosts.");
      }
      hosts.push(h);
    }
    const sum = hosts.reduce((s, h) => s + h, 0);
    if (sum !== spec.hostCount) {
      return ask(
        `The split adds up to ${formatNumber(sum)} hosts, but the request is ${formatNumber(spec.hostCount)} hosts.`
      );
    }
    allocations = dcs.map((dc, i) => ({
      dataCenter: dc,
      hosts: hosts[i],
      percent: null,
      cores: hosts[i] * spec.coresPerHost,
      memoryGB: round(hosts[i] * spec.memoryGBPerHost),
      diskTB: round(hosts[i] * spec.diskTBPerHost, 3)
    }));
  } else {
    // Totals-based: percent adding up to 100.
    if (raw.some((a) => a.hosts != null && a.percent == null)) {
      return ask(
        "This request was given as totals, so the split must be in percent (adding up to 100)."
      );
    }
    const pct = dcs.map((dc) => byDc.get(dc)?.percent ?? 0);
    const sum = pct.reduce((s, p) => s + p, 0);
    if (Math.abs(sum - 100) > 1e-9) {
      return ask(
        `The split adds up to ${formatNumber(sum)}%, but it must add up to 100%.`
      );
    }
    // Largest-remainder rounding keeps whole cores that sum to the total.
    const exact = pct.map((p) => (basis.totalCores * p) / 100);
    const cores = exact.map(Math.floor);
    let left = basis.totalCores - cores.reduce((s, c) => s + c, 0);
    const order = exact
      .map((e, i) => ({ i, r: e - Math.floor(e) }))
      .sort((a, b) => b.r - a.r);
    for (const { i } of order) {
      if (left <= 0) break;
      cores[i] += 1;
      left -= 1;
    }
    // Memory/disk in the same proportion; the last non-zero DC absorbs
    // rounding so the parts add up to the total exactly.
    const lastIdx = pct.reduce((li, p, i) => (p > 0 ? i : li), 0);
    const share = (total: number, digits: number) => {
      const parts = pct.map((p) => round((total * p) / 100, digits));
      const others = parts.reduce((s, v, i) => (i === lastIdx ? s : s + v), 0);
      parts[lastIdx] = round(total - others, digits);
      return parts;
    };
    const mem = share(basis.totalMemoryGB, 2);
    const disk = share(basis.totalDiskTB, 3);
    allocations = dcs.map((dc, i) => ({
      dataCenter: dc,
      hosts: null,
      percent: pct[i],
      cores: cores[i],
      memoryGB: mem[i],
      diskTB: disk[i]
    }));
  }

  // Grounding: the split must come from the user, not a default.
  const used = allocations.filter((a) => (a.hosts ?? a.percent ?? 0) > 0);
  const nums = numbersInText(userText);
  const values = used.map((a) => (spec ? a.hosts : a.percent) as number);
  const evenSplit =
    used.length === dcs.length &&
    values.every((v) => v === values[0]) &&
    EVEN_SPLIT.test(userText);
  const singleDc = used.length === 1;
  const grounded =
    ratio !== null ||
    used.every((a, i) => {
      const named = mentionedByUser(a.dataCenter, userText);
      if (singleDc) return named;
      if (evenSplit) return true;
      return named && nums.has(values[i]);
    });
  if (!grounded) return ask();

  return { ok: true, region, allocations };
}

export function splitTable(
  allocations: DcAllocation[],
  totals: { totalCores: number; totalMemoryGB: number; totalDiskTB: number }
) {
  const byHosts = allocations.some((a) => a.hosts !== null);
  const share = (a: DcAllocation) =>
    byHosts ? formatNumber(a.hosts ?? 0) : `${formatNumber(a.percent ?? 0)}%`;
  const totalShare = byHosts
    ? formatNumber(allocations.reduce((s, a) => s + (a.hosts ?? 0), 0))
    : "100%";
  return mdTable(
    [
      "Data center",
      byHosts ? "Hosts" : "Share",
      "Cores",
      "Memory (GB)",
      "Disk (TB)"
    ],
    [
      ...allocations.map((a) => [
        a.dataCenter,
        share(a),
        formatNumber(a.cores),
        formatNumber(a.memoryGB),
        formatNumber(a.diskTB)
      ]),
      [
        "**Total**",
        `**${totalShare}**`,
        `**${formatNumber(totals.totalCores)}**`,
        `**${formatNumber(totals.totalMemoryGB)}**`,
        `**${formatNumber(totals.totalDiskTB)}**`
      ]
    ]
  );
}

// ── Final record & summary ───────────────────────────────────────────

export interface RequestNumbers {
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  giveBackCores: number;
  assumed: AssumedDefaults;
}

/**
 * Builds the full request record. Net cores and capex are recomputed here
 * from the server-held numbers; nothing the model passes is trusted.
 */
export function buildRequestRecord(
  details: RequestDetails,
  location: { region: Region; split: DcAllocation[] },
  numbers: RequestNumbers
) {
  if (!isPositiveInt(numbers.totalCores))
    return fail("totalCores must be a whole number > 0.");
  if (!isPositive(numbers.totalMemoryGB))
    return fail("totalMemoryGB must be > 0.");
  if (!isPositive(numbers.totalDiskTB)) return fail("totalDiskTB must be > 0.");
  const gb = applyGiveBack({
    requestedCores: numbers.totalCores,
    giveBackCores: numbers.giveBackCores
  });
  if (!gb.ok) return gb;
  return {
    ok: true as const,
    record: {
      ...details,
      region: location.region,
      split: location.split,
      totalCores: numbers.totalCores,
      totalMemoryGB: numbers.totalMemoryGB,
      totalDiskTB: numbers.totalDiskTB,
      assumedDefaults: numbers.assumed,
      giveBackCores: gb.giveBackCores,
      netCores: gb.netCores,
      capexBefore: gb.capexBefore,
      capexAfter: gb.capexAfter,
      savings: gb.savings,
      currency
    }
  };
}

export type RequestRecord = Extract<
  ReturnType<typeof buildRequestRecord>,
  { ok: true }
>["record"];

/** Data centers that received part of the request, e.g. "EUDC1, EUDC2". */
export function usedDataCenters(r: RequestRecord) {
  return r.split
    .filter((a) => a.cores > 0 || (a.hosts ?? a.percent ?? 0) > 0)
    .map((a) => a.dataCenter)
    .join(", ");
}

/** Markdown summary: requester details first, then per-DC split, then capex. */
export function summaryTable(r: RequestRecord) {
  const details = mdTable(
    ["Field", "Value"],
    [
      ["App name", r.appName],
      ["App ID", r.appId],
      ["Business Unit", r.businessUnit],
      ["Requester", r.requester],
      ["MD approver", r.mdApprover],
      ["Environment", r.environment],
      ["Region", r.region]
    ]
  );
  const capex = mdTable(
    ["Total request", "Value"],
    [
      ["Cores", formatNumber(r.totalCores)],
      [
        "Memory",
        withAssumed(
          `${formatNumber(r.totalMemoryGB)} GB`,
          r.assumedDefaults.memory
        )
      ],
      [
        "Disk",
        withAssumed(`${formatNumber(r.totalDiskTB)} TB`, r.assumedDefaults.disk)
      ],
      ["Give-back cores", formatNumber(r.giveBackCores)],
      ["Net cores", formatNumber(r.netCores)],
      ["Capex before", formatMoney(r.capexBefore)],
      ["Capex after", formatMoney(r.capexAfter)],
      ["Savings", formatMoney(r.savings)]
    ]
  );
  return [details, splitTable(r.split, r), capex].join("\n\n");
}

export function formatRequestId(seq: number) {
  return `CAP-${String(seq).padStart(4, "0")}`;
}
