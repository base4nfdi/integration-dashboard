/**
 * Shared helpers for parsing incubator source pages into a NocoDB-aligned shape.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "../..");

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Canonical consortia spellings used in NocoDB. */
const PARTNER_ALIASES = {
  nfdi4ing: "NFDI4Ing",
  "nfdi4ing.": "NFDI4Ing",
  nfdi4cat: "NFDI4Cat",
  nfdi4chem: "NFDI4Chem",
  nfdi4culture: "NFDI4Culture",
  nfdi4earth: "NFDI4Earth",
  nfdi4energy: "NFDI4Energy",
  nfdi4health: "NFDI4Health",
  nfdi4memory: "NFDI4Memory",
  nfdi4objects: "NFDI4Objects",
  nfdi4biodiversity: "NFDI4Biodiversity",
  nfdi4bioimage: "NFDI4BIOIMAGE",
  nfdi4microbiota: "NFDI4Microbiota",
  nfdi4datascience: "NFDI4DataScience",
  fairmat: "FAIRmat",
  fairagro: "FAIRagro",
  dataplant: "DataPLANT",
  matwerk: "MatWerk",
  "nfdi-matwerk": "MatWerk",
  mardi: "MaRDI",
  "text+": "Text+",
  konsortswd: "KonsortSWD",
  nfdixcs: "NFDIxCS",
  nfdixcsk: "NFDIxCS",
  "berd@nfdi": "BERD@NFDI",
  daphne4nfdi: "DAPHNE4NFDI",
  base4nfdi: "Base4NFDI",
};

/**
 * Slugify an incubator name for key_article suffixes.
 * Example: "Template Development — NFDI4Chem" → "template-development-nfdi4chem"
 */
export function slugifyForKeyArticle(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build key_article as "{service}-{inc_name}" in lowercase slug form.
 * Example: ("TS", "RADAR") → "ts-radar"
 */
export function buildKeyArticle(basicService, incName) {
  const prefix = String(basicService ?? "")
    .trim()
    .toLowerCase();
  const slug = slugifyForKeyArticle(incName);
  if (!prefix || !slug) return "";
  return `${prefix}-${slug}`;
}

/**
 * Ensure a key_article is unique within usedKeys (mutates the set when claimed).
 * On collision appends -2, -3, …
 */
export function claimUniqueKeyArticle(baseKey, usedKeys) {
  if (!baseKey) return "";
  let key = baseKey;
  let n = 2;
  while (usedKeys.has(key)) {
    key = `${baseKey}-${n}`;
    n += 1;
  }
  usedKeys.add(key);
  return key;
}

/** Empty record matching normalizeRecord() in fetch-nocodb-data.mjs. */
export function emptyRecord(overrides = {}) {
  const record = {
    id: null,
    inc_name: "",
    basic_service: "",
    related_institutions: "",
    logo_project: "",
    logo_project_dark: "",
    logo_consortia: "",
    key_article: "",
    inc_start: "",
    inc_end: "",
    inc_cycle: null,
    inc_cycle_label: "",
    inc_status: "",
    inc_descr: "",
    inc_goals: "",
    inc_results: "",
    inc_partner_publications: 0,
    inc_activity_type: "",
    inc_caai: "",
    inc_ownership: "",
    inc_service_type: "",
    inc_activity_page: "",
    linked_partners: null,
    linked_entities: null,
    partners: [],
    entities: [],
    ...overrides,
  };
  if (!String(record.key_article ?? "").trim()) {
    record.key_article = buildKeyArticle(
      record.basic_service,
      record.inc_name
    );
  }
  return record;
}

export function stripHtml(html) {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // PID4NFDI (and some other pages) emit `&nbsp` without a trailing `;`.
    .replace(/&nbsp;?/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function goalsToMarkdown(goals) {
  if (!Array.isArray(goals) || goals.length === 0) return "";
  return goals
    .map((g) => String(g).trim())
    .filter(Boolean)
    .map((g) => `- ${g.replace(/\.$/, "")}`)
    .join("\n");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toIso(year, month, day) {
  if (!year || !month) return "";
  const y = Number(year);
  const m = Number(month);
  const d = day != null && day !== "" ? Number(day) : 1;
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Parse common date snippets used across sources into YYYY-MM-DD (best effort). */
export function parseDate(value, { endOfMonth = false } = {}) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw || raw === "~" || raw === "-" || /^n\/?a$/i.test(raw)) return "";

  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return toIso(m[3], m[2], m[1]);

  m = raw.match(/^(\d{1,2})\.(\d{4})$/);
  if (m) {
    const day = endOfMonth ? daysInMonth(Number(m[2]), Number(m[1])) : 1;
    return toIso(m[2], m[1], day);
  }

  m = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    return month ? toIso(m[3], month, m[1]) : "";
  }

  m = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return "";
    const day = endOfMonth ? daysInMonth(Number(m[2]), month) : 1;
    return toIso(m[2], month, day);
  }

  return "";
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** Parse "start - end" duration strings. */
export function parseDuration(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { start: "", end: "" };
  const parts = raw.split(/\s*[-–—]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    return { start: parseDate(parts[0]), end: "" };
  }
  return {
    start: parseDate(parts[0]),
    end: parseDate(parts[1], { endOfMonth: true }),
  };
}

/**
 * Normalize incubator cycle labels to a number (0, 1, 2, …).
 * TS4NFDI uses numeric 0 for first-wave incubators; DMP labels the same era
 * "Initialisation phase" — treat that as cycle 0 for NocoDB alignment.
 */
export function parseCycle(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (/^initial/i.test(raw)) return 0;
  const m = raw.match(/cycle\s*(\d+)/i) || raw.match(/^(\d+)$/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Human-readable cycle label for detail pages (from source text or numeric cycle).
 * DMP uses "Initialisation phase" for the pre–Cycle 0 era; IAM/TS use "Cycle N".
 */
export function formatCycleLabel(sourceCycleLabel, incCycle) {
  const raw = String(sourceCycleLabel ?? "").trim();
  if (raw) return raw;
  if (incCycle == null || incCycle === "") return "";
  const n = Number(incCycle);
  if (!Number.isFinite(n)) return "";
  return `Cycle ${n}`;
}

/** Map source-specific status labels onto NocoDB vocabulary where possible. */
export function normalizeStatus(status) {
  const raw = String(status ?? "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase();
  const map = {
    finished: "Finished",
    completed: "Finished",
    running: "Running",
    ongoing: "Running",
    "in preparation": "In preparation",
    preparation: "In preparation",
    submitted: "In preparation",
    upcoming: "In preparation",
    pending: "In preparation",
    review: "In preparation",
    nocapacity: "In preparation",
    denied: "Finished",
  };
  return map[key] ?? raw;
}

/** UTC calendar day as YYYY-MM-DD. */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * If inc_end is a real date before today, the incubator is finished even
 * when the source badge still says Running. No end date leaves status as-is.
 */
export function applyElapsedStatus(record, today = todayIso()) {
  const end = String(record?.inc_end ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end < today) {
    record.inc_status = "Finished";
  }
  return record;
}

/** Keep http(s) activity-page URLs. Ignore labels such as "provider". */
export function httpActivityUrl(base, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../")
  ) {
    const abs = absoluteUrl(base, raw);
    return /^https?:\/\//i.test(abs) ? abs : "";
  }
  return "";
}

export function normalizePartnerName(value) {
  const raw = String(value ?? "")
    .replace(/\r/g, "")
    .trim();
  if (!raw) return "";
  const alias = PARTNER_ALIASES[raw.toLowerCase()];
  return alias ?? raw;
}

export function splitPartners(value) {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v).trim()).filter(Boolean)
    : String(value ?? "")
        .split(/\s*,\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
  return parts.map(normalizePartnerName);
}

export function absoluteUrl(base, path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  try {
    return new URL(path, base).href;
  } catch {
    return path;
  }
}

/**
 * Read a UTF-8 text file with a clear error when missing.
 * @param {string} path
 * @param {{ hint?: string }} [options]
 */
export function readTextFile(path, { hint } = {}) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      const suffix = hint ? `\n${hint}` : "";
      throw new Error(`Missing input file: ${path}${suffix}`);
    }
    throw error;
  }
}

export function readJson(path, options = {}) {
  try {
    return JSON.parse(readTextFile(path, options));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Fail the build when a parser produced no incubators (likely a broken source). */
export function assertNonEmptyRecords(records, label) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(
      `${label}: parsed 0 records — source format may have changed or input is empty`
    );
  }
}

export function loadNocoDbRecords(path = join(repoRoot, "static/data.json")) {
  try {
    const payload = readJson(path);
    return Array.isArray(payload.records) ? payload.records : [];
  } catch {
    return [];
  }
}

function normName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(normName(value).split(/\s+/).filter(Boolean));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Match parsed source records against NocoDB rows for one basic_service.
 * Matching is best-effort by name similarity, goals overlap, partners, and cycle.
 * Returns full records (not summaries).
 */
export function matchAgainstNocoDb(parsedRecords, nocoRecords, basicService) {
  const nocos = nocoRecords.filter(
    (r) => String(r.basic_service).toUpperCase() === basicService.toUpperCase()
  );
  const usedNoco = new Set();
  const usedSource = new Set();
  const matches = [];

  for (let s = 0; s < parsedRecords.length; s++) {
    const src = parsedRecords[s];
    let best = null;
    let bestScore = 0;
    const srcTokens = tokenSet(src.inc_name);
    const srcPartners = new Set(
      (src.partners ?? []).map((p) => String(p).toLowerCase())
    );
    const srcGoals = tokenSet(`${src.inc_goals ?? ""} ${src.inc_descr ?? ""}`);

    for (let i = 0; i < nocos.length; i++) {
      if (usedNoco.has(i)) continue;
      const noco = nocos[i];
      const nocoPartners = new Set(
        (noco.partners ?? []).map((p) => String(p).toLowerCase())
      );
      const partnerOverlap = [...srcPartners].filter((p) =>
        nocoPartners.has(p)
      ).length;
      const exactName = normName(src.inc_name) === normName(noco.inc_name);
      const partnerOk = partnerOverlap > 0 || exactName;

      let score = jaccard(srcTokens, tokenSet(noco.inc_name));
      if (exactName) score = 1;
      else if (
        partnerOk &&
        (normName(src.inc_name).includes(normName(noco.inc_name)) ||
          normName(noco.inc_name).includes(normName(src.inc_name)))
      ) {
        score = Math.max(score, 0.75);
      }

      if (partnerOverlap > 0) score += 0.12 * partnerOverlap;
      else if (!exactName) score = Math.min(score, 0.35);

      if (partnerOk) {
        if (
          src.inc_cycle != null &&
          noco.inc_cycle != null &&
          Number(src.inc_cycle) === Number(noco.inc_cycle)
        ) {
          score += 0.2;
        }

        if (
          src.inc_start &&
          noco.inc_start &&
          String(src.inc_start).trim() === String(noco.inc_start).trim()
        ) {
          score += 0.35;
        }

        const srcService = String(src.inc_service_type ?? "")
          .trim()
          .toLowerCase();
        const nocoService = String(noco.inc_service_type ?? "")
          .trim()
          .toLowerCase();
        if (srcService && nocoService && srcService === nocoService) {
          score += 0.25;
        }

        const nocoGoals = tokenSet(
          `${noco.inc_goals ?? ""} ${noco.inc_descr ?? ""}`
        );
        const goalScore = jaccard(srcGoals, nocoGoals);
        if (goalScore >= 0.25) score += goalScore * 0.8;
      }

      // Partner + cycle alone can identify hand-named NocoDB rows.
      if (
        partnerOverlap > 0 &&
        src.inc_cycle != null &&
        noco.inc_cycle != null &&
        Number(src.inc_cycle) === Number(noco.inc_cycle)
      ) {
        score = Math.max(score, 0.55 + 0.1 * partnerOverlap);
      }

      if (score > bestScore) {
        bestScore = score;
        best = { index: i, noco };
      }
    }

    if (best && bestScore >= 0.45) {
      usedNoco.add(best.index);
      usedSource.add(s);
      matches.push({
        score: Number(bestScore.toFixed(3)),
        source: src,
        nocodb: best.noco,
      });
    }
  }

  return {
    basic_service: basicService,
    matches,
    only_in_source: parsedRecords.filter((_, i) => !usedSource.has(i)),
    only_in_nocodb: nocos.filter((_, i) => !usedNoco.has(i)),
  };
}

/**
 * Compare parsed source records against NocoDB rows for one basic_service.
 * Returns summarized report fields suitable for JSON dumps.
 */
export function compareWithNocoDb(parsedRecords, nocoRecords, basicService) {
  const matched = matchAgainstNocoDb(parsedRecords, nocoRecords, basicService);
  const matches = matched.matches.map((m) => ({
    score: m.score,
    source: summarize(m.source),
    nocodb: summarize(m.nocodb),
    field_diffs: diffFields(m.source, m.nocodb),
  }));
  const onlyInSource = matched.only_in_source.map(summarize);
  const onlyInNoco = matched.only_in_nocodb.map(summarize);

  return {
    basic_service: basicService,
    counts: {
      source: parsedRecords.length,
      nocodb:
        nocoRecords.filter(
          (r) =>
            String(r.basic_service).toUpperCase() === basicService.toUpperCase()
        ).length,
      matched: matches.length,
      only_in_source: onlyInSource.length,
      only_in_nocodb: onlyInNoco.length,
    },
    matches,
    only_in_source: onlyInSource,
    only_in_nocodb: onlyInNoco,
  };
}

const COMPARE_FIELDS = [
  "inc_name",
  "inc_status",
  "inc_cycle",
  "inc_cycle_label",
  "inc_start",
  "inc_end",
  "inc_descr",
  "inc_goals",
  "inc_results",
  "inc_activity_type",
  "inc_caai",
  "inc_ownership",
  "inc_service_type",
  "inc_activity_page",
  "partners",
  "logo_project",
  "logo_project_dark",
  "logo_consortia",
];

function summarize(record) {
  return {
    inc_name: record.inc_name,
    inc_cycle: record.inc_cycle,
    inc_status: record.inc_status,
    partners: record.partners ?? [],
  };
}

function normalizeForDiff(key, value) {
  if (Array.isArray(value)) return value.map(String).join(" | ");
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function diffFields(source, noco) {
  const diffs = {};
  for (const key of COMPARE_FIELDS) {
    const a = normalizeForDiff(key, source[key]);
    const b = normalizeForDiff(key, noco[key]);
    if (a !== b) {
      diffs[key] = { source: source[key] ?? "", nocodb: noco[key] ?? "" };
    }
  }
  return diffs;
}

export function buildParsedPayload({
  sourceId,
  basicService,
  inputFile,
  records,
  extra = {},
}) {
  return {
    source: sourceId,
    basic_service: basicService,
    parsed_at: new Date().toISOString(),
    input: inputFile,
    record_count: records.length,
    records,
    ...extra,
  };
}
