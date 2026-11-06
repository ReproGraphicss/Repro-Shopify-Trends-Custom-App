export { normalizeTrendsUrl } from "./trends-url";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryAfterMilliseconds = (response) => {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
};

export class TrendsClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = String(token || "")
      .trim()
      .replace(/^Bearer\s+/i, "");
    this.catalog = null;
    this.nextRequestAt = 0;
    this.cooldownUntil = 0;
    this.requestQueue = Promise.resolve();
  }
  async waitForRequestSlot() {
    let release;
    const previous = this.requestQueue;
    this.requestQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const now = Date.now();
      const waitUntil = Math.max(this.nextRequestAt, this.cooldownUntil);
      if (waitUntil > now) await sleep(waitUntil - now);
      // Stay below typical supplier limits even when multiple cron workers are
      // ready at once. The slot is shared by every request made by this client.
      this.nextRequestAt = Date.now() + 1100;
    } finally {
      release();
    }
  }
  async request(url, { timeoutMs = 30000, ...options } = {}) {
    const maximumAttempts = 6;
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      await this.waitForRequestSlot();
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const retryable =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      if (!retryable || attempt === maximumAttempts - 1) return response;

      const supplierDelay = retryAfterMilliseconds(response);
      const exponentialDelay = Math.min(30000, 1500 * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 500);
      const retryDelay = Math.min(
        45000,
        Math.max(supplierDelay, exponentialDelay) + jitter,
      );
      // Pause every worker using this client. Without a shared cooldown, one
      // worker can keep sending requests while another is backing off.
      this.cooldownUntil = Math.max(
        this.cooldownUntil,
        Date.now() + retryDelay,
      );
      await response.body?.cancel().catch(() => {});
      await sleep(retryDelay);
    }
    throw new Error("TRENDS request retry limit reached");
  }
  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
  }
  async error(response, context) {
    const contentType = response.headers.get("content-type") || "";
    let detail = "";
    try {
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        detail = String(
          payload?.message || payload?.error || payload?.detail || "",
        );
      } else {
        detail = (await response.text()).replace(/<[^>]*>/g, " ");
      }
    } catch {
      // Keep the status-only error when the supplier response is unreadable.
    }
    detail = detail.replace(/\s+/g, " ").trim().slice(0, 240);
    return new Error(
      `TRENDS ${context} returned ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  async getProductsPage({ page = 1, pageSize = 250, category = "" } = {}) {
    const params = new URLSearchParams({
      page_no: String(page),
      page_size: String(pageSize),
      inc_inactive: "true",
      inc_discontinued: "true",
    });
    if (category) params.set("category_no", category);
    const response = await this.request(
      `${this.baseUrl}/api/v1/products.json?${params}`,
      { headers: this.headers(), timeoutMs: 45000 },
    );
    if (!response.ok) throw await this.error(response, "catalog");
    return response.json();
  }
  async direct(code) {
    const response = await this.request(
      `${this.baseUrl}/api/v1/products/${code}.json`,
      { headers: this.headers(), timeoutMs: 30000 },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await this.error(response, `product ${code}`);
    return (await response.json()).data?.[0] || null;
  }
  async catalogIndex() {
    if (this.catalog) return this.catalog;
    const index = new Map();
    let page = 1;
    let pages = 1;
    do {
      const payload = await this.getProductsPage({ page, pageSize: 250 });
      pages = Math.min(Math.max(payload.page_count || 1, 1), 50);
      for (const product of payload.data || []) {
        index.set(String(product.code), product);
        for (const stock of product.stock || [])
          index.set(String(stock.stock_code), product);
      }
      page++;
    } while (page <= pages);
    this.catalog = index;
    return index;
  }
  async getProduct(code) {
    if (!/^\d{1,32}$/.test(code))
      throw new Error("TRENDS product code or SKU must contain only digits");
    const direct = await this.direct(code);
    if (direct) return direct;
    const product = (await this.catalogIndex()).get(code);
    if (!product)
      throw new Error(`Product code or SKU ${code} was not found in TRENDS`);
    return product;
  }
}
