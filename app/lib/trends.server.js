export { normalizeTrendsUrl } from "./trends-url";

export class TrendsClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.catalog = null;
  }
  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
  }
  async getProductsPage({ page = 1, pageSize = 250, category = "" } = {}) {
    const params = new URLSearchParams({
      page_no: String(page),
      page_size: String(pageSize),
      inc_inactive: "true",
      inc_discontinued: "true",
    });
    if (category) params.set("category_no", category);
    const response = await fetch(
      `${this.baseUrl}/api/v1/products.json?${params}`,
      { headers: this.headers(), signal: AbortSignal.timeout(45000) },
    );
    if (!response.ok)
      throw new Error(`TRENDS catalog returned ${response.status}`);
    return response.json();
  }
  async direct(code) {
    const response = await fetch(
      `${this.baseUrl}/api/v1/products/${code}.json`,
      { headers: this.headers(), signal: AbortSignal.timeout(30000) },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`TRENDS returned ${response.status} for ${code}`);
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
    if (!/^\d{6}$/.test(code))
      throw new Error("TRENDS product code or SKU must contain six digits");
    const direct = await this.direct(code);
    if (direct) return direct;
    const product = (await this.catalogIndex()).get(code);
    if (!product)
      throw new Error(`Product code or SKU ${code} was not found in TRENDS`);
    return product;
  }
}
