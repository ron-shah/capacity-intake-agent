/**
 * Pure capacity math and validation. The model never does arithmetic —
 * every number shown to the user comes from these functions.
 *
 * NOTE: config.json holds SAMPLE data (rate and data centers) for demo only.
 */
import config from "./config.json";

export const REGIONS = ["Americas", "EMEA", "APAC"] as const;
export type Region = (typeof REGIONS)[number];

/** Binary conversion used for memory and disk (1 TB = 1024 GB). */
export const GB_PER_TB = 1024;

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

// ── Data centers ─────────────────────────────────────────────────────

export function normalizeRegion(region: string): Region | undefined {
  return REGIONS.find((r) => r.toLowerCase() === region.trim().toLowerCase());
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
  hostCount?: number;
  coresPerHost?: number;
  memoryGBPerHost?: number;
  diskTBPerHost?: number;
  totalCores?: number;
  totalMemory?: number;
  memoryUnit?: "GB" | "TB";
  totalDisk?: number;
  diskUnit?: "TB" | "GB";
}

export function calculateResources(input: ResourceInput) {
  if (input.mode === "perHost") {
    const { hostCount, coresPerHost, memoryGBPerHost, diskTBPerHost } = input;
    const missing = [
      hostCount === undefined && "hostCount",
      coresPerHost === undefined && "coresPerHost",
      memoryGBPerHost === undefined && "memoryGBPerHost",
      diskTBPerHost === undefined && "diskTBPerHost"
    ].filter(Boolean);
    if (missing.length) {
      return fail(
        `Missing per-host values: ${missing.join(", ")}. Ask the user for them.`
      );
    }
    if (!isPositiveInt(hostCount))
      return fail("hostCount must be a whole number > 0.");
    if (!isPositiveInt(coresPerHost))
      return fail("coresPerHost must be a whole number > 0.");
    if (!isPositive(memoryGBPerHost))
      return fail("memoryGBPerHost must be > 0.");
    if (!isPositive(diskTBPerHost)) return fail("diskTBPerHost must be > 0.");
    return {
      ok: true as const,
      basis: `${hostCount} hosts x (${coresPerHost} cores, ${memoryGBPerHost} GB, ${diskTBPerHost} TB)`,
      totalCores: hostCount * coresPerHost,
      totalMemoryGB: round(hostCount * memoryGBPerHost),
      totalDiskTB: round(hostCount * diskTBPerHost)
    };
  }

  if (input.mode === "totals") {
    const { totalCores, totalMemory, totalDisk } = input;
    const missing = [
      totalCores === undefined && "totalCores",
      totalMemory === undefined && "totalMemory",
      totalDisk === undefined && "totalDisk"
    ].filter(Boolean);
    if (missing.length) {
      return fail(
        `Missing totals: ${missing.join(", ")}. Ask the user for them.`
      );
    }
    if (!isPositiveInt(totalCores))
      return fail("totalCores must be a whole number > 0.");
    if (!isPositive(totalMemory)) return fail("totalMemory must be > 0.");
    if (!isPositive(totalDisk)) return fail("totalDisk must be > 0.");
    const memoryUnit = input.memoryUnit ?? "GB";
    const diskUnit = input.diskUnit ?? "TB";
    return {
      ok: true as const,
      basis: "direct totals",
      totalCores,
      totalMemoryGB: round(
        memoryUnit === "TB" ? totalMemory * GB_PER_TB : totalMemory
      ),
      totalDiskTB: round(
        diskUnit === "GB" ? totalDisk / GB_PER_TB : totalDisk,
        3
      )
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
}) {
  const { totalCores, totalMemoryGB, totalDiskTB } = totals;
  if (!isPositiveInt(totalCores))
    return fail("totalCores must be a whole number > 0.");
  const capex = capexFor(totalCores);
  // Ready-to-show block; the server writes it into the chat verbatim.
  const display = [
    "**Capacity estimate**",
    "",
    `- Total cores: ${formatNumber(totalCores)}`,
    `- Memory: ${formatNumber(totalMemoryGB)} GB`,
    `- Disk: ${formatNumber(totalDiskTB)} TB`,
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

// ── Requester details & summary ──────────────────────────────────────

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
  "-"
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

export interface RequestDetails {
  appName: string;
  appId: string;
  businessUnit: string;
  requester: string;
  mdApprover: string;
  environment: "prod" | "non-prod";
  region: string;
  dataCenter: string;
}

const DETAIL_LABELS: Record<
  Exclude<keyof RequestDetails, "environment" | "region" | "dataCenter">,
  string
> = {
  appName: "App name",
  appId: "App ID",
  businessUnit: "Business Unit",
  requester: "Requester (owner)",
  mdApprover: "MD approver name"
};

/**
 * Checks requester details: no placeholders, every free-text value must
 * appear in something the user typed, environment must be stated by the
 * user, and the data center must belong to the region.
 */
/** Maps common spellings to "prod" / "non-prod"; anything else is invalid. */
export function normalizeEnvironment(
  value: string
): "prod" | "non-prod" | undefined {
  const v = value.trim().toLowerCase();
  if (v === "prod" || v === "production") return "prod";
  if (/^non[\s-]?prod(uction)?$/.test(v)) return "non-prod";
  return undefined;
}

export function validateDetails(
  input: Omit<RequestDetails, "environment"> & { environment: string },
  userText: string
) {
  const missing: string[] = [];
  const notFromUser: string[] = [];
  for (const [key, label] of Object.entries(DETAIL_LABELS) as [
    keyof typeof DETAIL_LABELS,
    string
  ][]) {
    const value = (input[key] ?? "").trim();
    if (isPlaceholder(value)) missing.push(label);
    else if (!mentionedByUser(value, userText)) notFromUser.push(label);
  }
  const environment = normalizeEnvironment(input.environment ?? "");
  if (!environment) {
    missing.push("Environment (prod or non-prod)");
  } else if (!environmentStatedByUser(environment, userText)) {
    notFromUser.push("Environment (prod or non-prod)");
  }
  if (missing.length || notFromUser.length) {
    const parts = [
      missing.length && `missing: ${missing.join(", ")}`,
      notFromUser.length &&
        `not stated by the user (do not guess): ${notFromUser.join(", ")}`
    ].filter(Boolean);
    const needed = [...missing, ...notFromUser];
    return {
      ok: false as const,
      error: `Ask the user for these details — ${parts.join("; ")}.`,
      // Ready-to-show question; the server writes it into the chat.
      display: `To finish the request, please provide:\n\n${needed.map((f) => `- ${f}`).join("\n")}`,
      needsUserInput: true as const
    };
  }

  const region = normalizeRegion(input.region);
  if (!region) {
    const msg = `Unknown region "${input.region}". Valid regions: ${REGIONS.join(", ")}.`;
    return {
      ok: false as const,
      error: msg,
      display: msg,
      needsUserInput: true as const
    };
  }
  const dataCenter = input.dataCenter.trim().toUpperCase();
  if (!regionMap[region].includes(dataCenter)) {
    const msg = `${dataCenter} is not in ${region}. Valid data centers in ${region}: ${regionMap[region].join(", ")}. Which one should I use?`;
    return {
      ok: false as const,
      error: msg,
      display: msg,
      needsUserInput: true as const
    };
  }

  return {
    ok: true as const,
    details: {
      appName: input.appName.trim(),
      appId: input.appId.trim(),
      businessUnit: input.businessUnit.trim(),
      requester: input.requester.trim(),
      mdApprover: input.mdApprover.trim(),
      environment: environment as "prod" | "non-prod",
      region,
      dataCenter
    } satisfies RequestDetails
  };
}

export interface RequestNumbers {
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  giveBackCores: number;
}

/**
 * Builds the full request record. Net cores and capex are recomputed here
 * from the server-held numbers; nothing the model passes is trusted.
 */
export function buildRequestRecord(
  details: RequestDetails,
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
      totalCores: numbers.totalCores,
      totalMemoryGB: numbers.totalMemoryGB,
      totalDiskTB: numbers.totalDiskTB,
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

/** Markdown summary table, requester details first. */
export function summaryTable(r: RequestRecord) {
  const rows: [string, string][] = [
    ["App name", r.appName],
    ["App ID", r.appId],
    ["Business Unit", r.businessUnit],
    ["Requester", r.requester],
    ["MD approver", r.mdApprover],
    ["Environment", r.environment],
    ["Region", r.region],
    ["Data center", r.dataCenter],
    ["Cores", formatNumber(r.totalCores)],
    ["Memory", `${formatNumber(r.totalMemoryGB)} GB`],
    ["Disk", `${formatNumber(r.totalDiskTB)} TB`],
    ["Give-back cores", formatNumber(r.giveBackCores)],
    ["Net cores", formatNumber(r.netCores)],
    ["Capex before", formatMoney(r.capexBefore)],
    ["Capex after", formatMoney(r.capexAfter)],
    ["Savings", formatMoney(r.savings)]
  ];
  const esc = (v: string) => v.replace(/\|/g, "\\|");
  return [
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${esc(v)} |`)
  ].join("\n");
}

export function formatRequestId(seq: number) {
  return `CAP-${String(seq).padStart(4, "0")}`;
}
