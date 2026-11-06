# Repro Vendor Management

A Shopify embedded app for managing the Repro Graphics TRENDS product catalogue, synchronising products and inventory, calculating configured prices, and receiving customer quote requests.

## Basic functionality

- Import TRENDS products, variants, prices and stock.
- Create and update Shopify products, variants, images, inventory and product configuration data.
- Sync raw supplier prices without markup.
- Apply global or product-specific markup once to the complete configured total.
- Add branding, packaging, setup and fixed shipping charges.
- Store pricing/configuration data in Shopify product metafields for fast storefront calculations.
- Support manual sync, bulk sync, scheduled sync, full refresh and price/stock refresh.
- Show sync history, failed items, health checks and repair options.
- Display product colours, quantity options, branding, packaging and final unit price on the storefront.
- Receive Get a Quote requests and show them in the admin quote list.
- Send quote notification emails to configured recipients.
- Allow GST to be calculated by Shopify checkout instead of adding GST to the stored product price.

## Environment variables

Add these values to the production server's Environment Variables section. Never commit real secrets to GitHub.

| Variable | Required | Purpose |
|---|---:|---|
| `NODE_ENV` | Yes | Set to `production`. |
| `PORT` | Yes | Port provided by the hosting platform. |
| `HOST` | No | Optional server bind host. |
| `SHOPIFY_APP_URL` | Yes | Public app URL, for example `https://integrations.reprographics.co.nz`. |
| `SHOPIFY_API_KEY` | Yes | Shopify app client ID. |
| `SHOPIFY_API_SECRET` | Yes | Shopify app client secret. |
| `SCOPES` | Yes | Shopify Admin API permissions. Keep aligned with the Shopify TOML configuration. |
| `DATABASE_URL` | Yes | Production MySQL connection URL. |
| `TOKEN_ENCRYPTION_KEY` | Yes | Stable secret used to encrypt saved supplier and integration tokens. |
| `CRON_SECRET` | Yes | Bearer secret required by scheduled sync endpoints. |
| `SHOPIFY_STORE_DOMAIN` | Yes | Shopify store domain, for example `store.myshopify.com`. |
| `SHOP_CUSTOM_DOMAIN` | No | Optional custom storefront domain. |
| `STOREFRONT_SHOP` | No | Optional storefront shop override used by stock helpers. |
| `FILE_UPLOAD_API_KEY` | No | Required only when the configured file upload service is used. |
| `CRON_SYNC_CONCURRENCY` | No | Concurrency for full/catalog sync. |
| `CRON_PRICE_SYNC_CONCURRENCY` | No | Concurrency for price and inventory sync. |
| `CRON_CATALOG_CONCURRENCY` | No | Concurrency for catalog fetching. |
| `SMTP_HOST` | Yes for email | SMTP server hostname. |
| `SMTP_PORT` | Yes for email | Usually `465` for secure SMTP or `587` for STARTTLS. |
| `SMTP_SECURE` | Yes for email | `true` for port 465; normally `false` for port 587. |
| `SMTP_USER` | Yes for email | SMTP mailbox username. |
| `SMTP_PASSWORD` | Yes for email | SMTP password or provider app password. |
| `MAIL_FROM` | No | Sender email address; defaults to the SMTP user. |
| `MAIL_FROM_NAME` | No | Sender display name; defaults to Repro Graphics. |
| `QUOTE_NOTIFICATION_TO` | No | Default quote recipients. Separate multiple email addresses with commas. |

For Gmail SMTP, use a Google App Password rather than the normal mailbox password. Remove spaces from the app password before saving it.

## Cron jobs and intervals

All endpoints require this header:

```http
Authorization: Bearer YOUR_CRON_SECRET
```

Replace `YOUR_CRON_SECRET` with the same value configured in the server's `CRON_SECRET` variable.

### 1. Catalog sync — every 30 minutes

Creates or processes the next 25 catalog products.

**Cron expression:** `*/30 * * * *`

```
/usr/bin/curl -fsS --max-time 30 -H "Authorization: Bearer YOUR_CRON_SECRET" "https://integrations.reprographics.co.nz/cron/trends-sync?mode=catalog&limit=25"
```

### 2. Price and inventory sync — every 15 minutes

Refreshes supplier prices, inventory, pricing configuration and configured master prices.

**Cron expression:** `5,20,35,50 * * * *`

The five-minute offset prevents this job from starting at the same time as the catalog job.

```
/usr/bin/curl -fsS --max-time 60 -H "Authorization: Bearer YOUR_CRON_SECRET" "https://integrations.reprographics.co.nz/cron/trends-sync?mode=prices"
```

### 3. Full product refresh — daily at 02:02

Refreshes the complete product catalogue.

**Cron expression:** `2 2 * * *`

```
/usr/bin/curl -fsS --max-time 60 -H "Authorization: Bearer YOUR_CRON_SECRET" "https://integrations.reprographics.co.nz/cron/trends-sync?mode=full"
```

### 4. Temporary variant cleanup — daily at 04:43

Removes expired temporary storefront variants.

**Cron expression:** `43 4 * * *`

```
/usr/bin/curl -fsS --max-time 540 -H "Authorization: Bearer YOUR_CRON_SECRET" "https://integrations.reprographics.co.nz/cron/temporary-variants-cleanup"
```

Create these as **Custom** cron commands in Hostinger. Do not prepend `/usr/bin/php` to a curl command.

## Deployment on Hostinger

1. Create an empty MySQL database in Hostinger hPanel.
2. Create a Node.js Web App using Node.js 22.
3. Upload or connect the repository.
4. Add all required environment variables listed above.
5. Set the build command to:

   ```
   npm run build:hostinger
   ```

6. Set the start command to:

   ```
   npm run start:hostinger
   ```

7. Deploy and wait for the build to finish.
8. Check the health URL:

   ```
   https://integrations.reprographics.co.nz/health
   ```

   The response should show `ok: true`.
9. Deploy the Shopify production configuration if Shopify settings or scopes changed:

   ```
   npm exec shopify app deploy --config production
   ```

10. Open the app from Shopify Admin, configure the TRENDS connection, sync one product, verify it, and then start the bulk sync.
11. Add the four cron jobs only after the app and one-product sync are working.

The production build uses the MySQL Prisma schema and the production Express server.

## Local run

```
npm install
npx prisma generate
npx prisma db push
npm run dev
```

## Important files

- `hostinger.env.example` — environment variable template.
- `HOSTINGER_DEPLOYMENT.md` — production deployment notes.
- `GET_A_QUOTE_API.md` — Get a Quote request format.
- `postman/` — API testing collections.

