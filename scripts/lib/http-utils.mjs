/**
 * Shared HTTP helpers for source / NocoDB fetch scripts.
 */

/**
 * Parse a positive integer from env-like input.
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} label
 */
export function parsePositiveInt(value, fallback, label = "value") {
  const raw = value == null || value === "" ? fallback : value;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer, got: ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * fetch() with timeout and non-OK status handling.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {{ timeoutMs?: number, label?: string }} [opts]
 */
export async function fetchOk(url, options = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const label = opts.label ?? url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Request failed for ${label} (${response.status}): ${body.slice(0, 200)}`
      );
    }

    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${label}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Paginate NocoDB table records with loop guards.
 *
 * @param {{
 *   baseUrl: string,
 *   tableId: string,
 *   viewId?: string,
 *   token: string,
 *   pageSize: number,
 *   timeoutMs?: number,
 * }} options
 */
export async function fetchNocoDbRecords({
  baseUrl,
  tableId,
  viewId = "",
  token,
  pageSize,
  timeoutMs = 60_000,
}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`pageSize must be a positive integer, got: ${pageSize}`);
  }

  const records = [];
  let offset = 0;
  let pages = 0;
  const maxPages = 10_000;

  while (pages < maxPages) {
    pages += 1;
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(pageSize),
      where: "",
    });
    if (viewId) params.set("viewId", viewId);

    const url = `${baseUrl}/api/v2/tables/${tableId}/records?${params}`;
    const response = await fetchOk(
      url,
      { headers: { "xc-token": token } },
      { timeoutMs, label: `NocoDB ${tableId} offset=${offset}` }
    );

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(
        `NocoDB returned non-JSON for ${tableId} at offset ${offset}: ${error.message}`
      );
    }

    const batch = Array.isArray(payload?.list) ? payload.list : [];
    records.push(...batch);

    const pageInfo = payload?.pageInfo;
    if (pageInfo?.isLastPage === true || batch.length === 0 || batch.length < pageSize) {
      break;
    }

    const nextOffset = offset + batch.length;
    if (nextOffset <= offset) {
      throw new Error(
        `NocoDB pagination stuck for ${tableId} at offset ${offset} (batch=${batch.length})`
      );
    }
    offset = nextOffset;
  }

  if (pages >= maxPages) {
    throw new Error(
      `NocoDB pagination exceeded ${maxPages} pages for table ${tableId}`
    );
  }

  return records;
}
