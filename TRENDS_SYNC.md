# TRENDS product sync

The embedded app accepts pasted or uploaded CSV/TXT lists containing six-digit TRENDS parent product codes or colour variant SKUs.

- Repeated syncs upsert by the deterministic `trends-{parent-code}` Shopify handle.
- Title, description, images, colour variants, SKUs and inventory are synchronized.
- Shopify selling price uses the first supplier quantity-break price with global or individual markup.
- Quantity pricing, branding options, additional costs and specifications are stored in `trends.*` product metafields.
- Sync runs process up to 20 items per request and keep success/error history.

Run `npm run setup`, link/install the app, approve the updated scopes, then configure the TRENDS token from **Settings**.

# Automatic price and inventory sync

The app exposes a protected endpoint for scheduled supplier updates:

```text
GET /cron/trends-sync
Authorization: Bearer <CRON_SECRET>
```

Set a strong `CRON_SECRET` environment variable on the application server, then configure the hosting provider's scheduler to request this endpoint every 10 minutes (`*/10 * * * *`). The endpoint updates only prices and available inventory for products that have already been synced to Shopify. Additional-product variant prices and setup prices are refreshed as well.

The worker processes 12 supplier products concurrently by default so a catalog of roughly 418 sheet rows can be handled inside a ten-minute scheduling window without sending all requests at once. `CRON_SYNC_CONCURRENCY` can override this value from 1 to 20; keep the default unless production timing shows that the TRENDS account supports a higher request rate. Shopify variants belonging to one product are updated together with `productVariantsBulkUpdate`, and that product's inventory quantities are sent together with `inventorySetQuantities`.

The scheduler must allow enough time for the whole sheet to finish. A second request receives HTTP 409 while another run is active.

Run a second schedule once per day for complete product information:

```text
GET /cron/trends-sync?mode=full
Authorization: Bearer <CRON_SECRET>
```

The daily mode refreshes only products whose local status is `SYNCED`. It updates the Shopify title, description, images, variants, tags, status, complete quantity-break configuration, branding options, setup charges, prices and inventory. The normal endpoint remains the lightweight ten-minute price/inventory/tier-metafield refresh.

# Storefront quantity pricing

Product sync writes the complete calculator configuration to the
`trends.product_configuration` JSON metafield. The storefront uses that
metafield for instant quantity, branding, packaging, shipping, markup and GST
calculation without a request on every selection change. Only **Add to cart**
calls the configuration endpoint, where the server recalculates the price and
creates or reuses the configured Shopify variant.

The read-only pricing verification route is implemented at
`/api/storefront/pricing` and exposed through the Shopify app proxy at
`/apps/trends/pricing`.

```text
POST /apps/trends-pricing
Content-Type: application/json

{
  "variantSku": "105650",
  "quantity": 100,
  "brandingSku": "127290"
}
```

`brandingSku` is optional. Only SKUs belonging to products already synced to Shopify are accepted. The response includes the applied tier, marked-up base and branding unit prices, setup fee, discount per unit, total discount, subtotal excluding GST and total including GST. Shopify signs the app-proxy request and the app validates that signature before reading store data.
