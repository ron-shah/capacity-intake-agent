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

export function calculateCapex(totalCores: number) {
  if (!isPositiveInt(totalCores))
    return fail("totalCores must be a whole number > 0.");
  const capex = capexFor(totalCores);
  return {
    ok: true as const,
    cores: totalCores,
    perCoreRate: perCore,
    currency,
    capex,
    capexFormatted: formatMoney(capex),
    note: "Capex is based on cores only; memory and disk are not priced."
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
          `${g.hostCount} x ${g.coresPerHost} cores = ${g.hostCount * g.coresPerHost}`
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
    note: capped
      ? `Give-back of ${rawGiveBack} cores exceeds the request; capped at ${requestedCores}. Memory and disk stay as requested.`
      : "Memory and disk stay as requested."
  };
}

// ── Final request ────────────────────────────────────────────────────

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

const CONFIRM =
  /\b(yes|yep|yeah|confirm|confirmed|approve|approved|submit|go ahead|looks good|lgtm|correct|proceed|sounds good|ok|okay)\b/i;
const NEGATE = /\b(no|not|don'?t|do not|wait|hold|change|cancel|wrong)\b/i;

/** True when the user's latest message reads as a confirmation. */
export function confirmedByUser(latestUserText: string) {
  return CONFIRM.test(latestUserText) && !NEGATE.test(latestUserText);
}

export interface SubmitInput {
  appName: string;
  owner: string;
  environment: "prod" | "non-prod";
  region: string;
  dataCenter: string;
  totalCores: number;
  totalMemoryGB: number;
  totalDiskTB: number;
  giveBackCores: number;
}

/**
 * Validates a final request and recomputes all derived values in code
 * (net cores, capex before/after) so nothing the model passes is trusted.
 */
export function buildRequestRecord(input: SubmitInput) {
  const appName = input.appName.trim();
  const owner = input.owner.trim();
  if (isPlaceholder(appName)) {
    return fail("App name is missing. Ask the user for the app name.");
  }
  if (isPlaceholder(owner)) {
    return fail("Owner is missing. Ask the user who owns this request.");
  }
  if (input.environment !== "prod" && input.environment !== "non-prod") {
    return fail('environment must be "prod" or "non-prod".');
  }
  const region = normalizeRegion(input.region);
  if (!region)
    return fail(
      `Unknown region "${input.region}". Valid: ${REGIONS.join(", ")}.`
    );
  const dataCenter = input.dataCenter.trim().toUpperCase();
  if (!regionMap[region].includes(dataCenter)) {
    return fail(
      `${dataCenter} is not in ${region}. Valid data centers in ${region}: ${regionMap[region].join(", ")}.`
    );
  }
  if (!isPositiveInt(input.totalCores))
    return fail("totalCores must be a whole number > 0.");
  if (!isPositive(input.totalMemoryGB))
    return fail("totalMemoryGB must be > 0.");
  if (!isPositive(input.totalDiskTB)) return fail("totalDiskTB must be > 0.");

  const gb = applyGiveBack({
    requestedCores: input.totalCores,
    giveBackCores: input.giveBackCores
  });
  if (!gb.ok) return gb;

  return {
    ok: true as const,
    record: {
      appName,
      owner,
      environment: input.environment,
      region,
      dataCenter,
      totalCores: input.totalCores,
      totalMemoryGB: input.totalMemoryGB,
      totalDiskTB: input.totalDiskTB,
      giveBackCores: gb.giveBackCores,
      netCores: gb.netCores,
      capexBefore: gb.capexBefore,
      capexAfter: gb.capexAfter,
      currency,
      createdAt: new Date().toISOString()
    }
  };
}

export function formatRequestId(seq: number) {
  return `CAP-${String(seq).padStart(4, "0")}`;
}
