export const DEFAULT_API_BASE_URL =
  process.env.KOGAN_API_BASE_URL?.replace(/products\/?$/, "") ||
  "https://nimda-marketplace.aws.kgn.io/api/marketplace/v2/";

const MAX_BATCH_SIZE = 500;
const MAX_RETRIES = 4;
const CATEGORY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const categoryCache = new Map();

export class KoganApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "KoganApiError";
    this.status = status;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url) {
  const value = (url || DEFAULT_API_BASE_URL).trim();
  return value.endsWith("/") ? value : `${value}/`;
}

/**
 * Builds a Kogan API client from per-shop settings, falling back to the
 * credentials in the environment for local development.
 */
export function createKoganClient(settings = {}) {
  const sellerId = settings.sellerId || process.env.KOGAN_SELLER_ID;
  const sellerToken = settings.sellerToken || process.env.KOGAN_SELLER_TOKEN;
  const baseUrl = normalizeBaseUrl(settings.apiBaseUrl);

  if (!sellerId || !sellerToken) {
    throw new KoganApiError(
      "Kogan credentials are missing. Add your Seller ID and Seller Token in Settings.",
    );
  }

  async function request(pathOrUrl, { method = "GET", query, body } = {}) {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl, baseUrl);

    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    for (let attempt = 0; ; attempt++) {
      let response;

      try {
        response = await fetch(url, {
          method,
          headers: {
            SellerID: sellerId,
            SellerToken: sellerToken,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new KoganApiError(`Unable to reach Kogan: ${error.message}`);
      }

      const retryable = response.status === 429 || response.status >= 502;

      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1000 * 2 ** attempt,
        );
        continue;
      }

      const text = await response.text();
      let json = null;

      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      // Kogan returns 400 with an async body for validation failures, which
      // still carries useful per-SKU errors, so it is returned rather than thrown.
      if (!response.ok && !(response.status === 400 && json?.status)) {
        const detail =
          json?.detail || json?.error || text.slice(0, 300) || response.statusText;
        throw new KoganApiError(
          `Kogan API ${method} ${url.pathname} failed (${response.status}): ${detail}`,
          { status: response.status, body: json ?? text },
        );
      }

      return json;
    }
  }

  /**
   * Polls an asynchronous Kogan task until it finishes.
   */
  async function waitForTask(result, { timeoutMs = 120000 } = {}) {
    let current = result;
    const startedAt = Date.now();
    let delay = 1500;

    while (
      current?.status === "AsyncResponsePending" &&
      current.pending_url &&
      Date.now() - startedAt < timeoutMs
    ) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10000);
      current = await request(current.pending_url);
    }

    return current;
  }

  /**
   * Sends a write request in batches, waits for each task, and returns the
   * per-SKU errors and warnings merged across all batches.
   */
  async function writeInBatches(path, method, items) {
    const outcome = { status: "Complete", errors: [], warnings: [], error: null, pendingUrls: [] };

    for (let index = 0; index < items.length; index += MAX_BATCH_SIZE) {
      const batch = items.slice(index, index + MAX_BATCH_SIZE);
      const initial = await request(path, { method, body: batch });
      const finished = await waitForTask(initial);

      if (finished?.status === "AsyncResponsePending") {
        // Kogan is still working on it. The caller keeps the task URL and
        // checks the real result later instead of assuming success.
        outcome.status = "Pending";
        if (finished.pending_url) outcome.pendingUrls.push(finished.pending_url);
        continue;
      }

      if (finished?.status && finished.status !== "Complete") {
        outcome.status = finished.status;
      }

      if (finished?.error) {
        outcome.error = finished.error;
      }

      outcome.errors.push(...(finished?.body?.errors || []));
      outcome.warnings.push(...(finished?.body?.warnings || []));
    }

    return outcome;
  }

  return {
    baseUrl,
    sellerId,

    async ping() {
      await request("products/", { query: { size: 1 } });
      return true;
    },

    /**
     * Iterates every product in the seller account, following cursor pagination.
     */
    async *listProducts({ pageSize = 100 } = {}) {
      let next = null;
      let first = true;

      while (first || next) {
        const response = first
          ? await request("products/", { query: { detail: true, size: pageSize } })
          : await request(next);
        first = false;

        const page = (await waitForTask(response))?.body;
        yield page?.results || [];
        next = page?.next || null;
      }
    },

    /**
     * Fetches a single page of products. Kogan uses cursor pagination, so the
     * cursor for the next page is read from the `next` URL.
     */
    async getProductPage({ cursor, size = 10, search, sku } = {}) {
      const response = await request("products/", {
        query: { detail: true, size, cursor, search, sku },
      });
      const page = (await waitForTask(response))?.body || {};
      const nextCursor = page.next ? new URL(page.next).searchParams.get("cursor") : null;

      return { results: page.results || [], nextCursor };
    },

    /**
     * Reads the current state of an asynchronous task without waiting.
     */
    async getTask(pendingUrl) {
      const response = await request(pendingUrl);
      return {
        status: response?.status === "AsyncResponsePending" ? "Pending" : response?.status || "Complete",
        error: response?.error || null,
        errors: response?.body?.errors || [],
        warnings: response?.body?.warnings || [],
      };
    },

    async getProductBySku(sku) {
      const response = await request("products/", {
        query: { detail: true, sku },
      });
      return response?.body?.results?.[0] || null;
    },

    createProducts(products) {
      return writeInBatches("products/", "POST", products);
    },

    updateProducts(products) {
      return writeInBatches("products/", "PATCH", products);
    },

    updateStockAndPrice(items) {
      return writeInBatches("products/stockprice/", "POST", items);
    },

    updateEnabledStatus(items) {
      return writeInBatches("products/status/", "POST", items);
    },

    /**
     * Lists Kogan orders with a given status. Kogan reports account level
     * problems (for example a missing warehouse) as a "Failed" status.
     */
    async getOrders(status, { startDateUTC, endDateUTC } = {}) {
      const response = await request("orders/", {
        query: { status, startDateUTC, endDateUTC },
      });

      if (response?.status === "Failed") {
        throw new KoganApiError(`Kogan could not return orders: ${response.error || "unknown error"}`, {
          body: response,
        });
      }

      return Array.isArray(response?.body) ? response.body : [];
    },

    /**
     * Tells Kogan that order items were dispatched. Returns per-item failures.
     */
    async fulfillOrders(fulfillments) {
      const response = await request("orders/fulfill/", { method: "POST", body: fulfillments });
      const results = Array.isArray(response) ? response : [response];
      const problems = [];

      for (const result of results) {
        if (result?.error) problems.push(result.error);
        for (const item of result?.body || []) {
          if (item.Result === "Fail") {
            const reasons = (item.Errors || [])
              .map((error) => error.Message || error.ErrorCode || error.ID)
              .join(", ");
            problems.push(`Item ${item.ID}: ${reasons || "failed"}`);
          }
        }
        if (result?.status === "Failed" && problems.length === 0) {
          problems.push("Kogan rejected the dispatch.");
        }
      }

      return problems;
    },

    async cancelOrder(orderId, items) {
      const response = await request(`orders/${encodeURIComponent(orderId)}/cancel/`, {
        method: "POST",
        body: { OrderID: orderId, Items: items },
      });

      if (response?.status === "Failed") {
        throw new KoganApiError(`Kogan could not cancel the order: ${response.error || "unknown error"}`);
      }

      return response;
    },

    /**
     * Returns every Kogan category for a store. The full list is large and
     * slow to fetch, so it is cached in memory.
     */
    async getAllCategories(storeCode = "au") {
      const cacheKey = `${baseUrl}|${storeCode}`;
      const cached = categoryCache.get(cacheKey);

      if (cached && Date.now() - cached.loadedAt < CATEGORY_CACHE_TTL_MS) {
        return cached.promise;
      }

      const promise = request("category/", {
        query: { store_code: storeCode, display_all: true },
      }).then((response) =>
        (response?.body?.results || []).map((category) => ({
          id: category.id,
          title: category.title,
          display: category.display,
        })),
      );

      categoryCache.set(cacheKey, { loadedAt: Date.now(), promise });
      promise.catch(() => categoryCache.delete(cacheKey));

      return promise;
    },
  };
}

export function storeCodeForCurrency(currency) {
  return currency === "NZD" ? "nz" : "au";
}
