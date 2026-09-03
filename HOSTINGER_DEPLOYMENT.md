# Hostinger production deployment

## Web App settings

- Runtime: Node.js 22
- Production URL: `https://integrations.reprographics.co.nz`
- Build command: `npm run build:hostinger`
- Start command: `npm run start:hostinger`
- Health check: `/health`

Create a new, empty MySQL database in hPanel. Add every variable from
`hostinger.env.example` to the Web App environment settings using production
values. Never commit the real values.

`start:hostinger` applies the Prisma schema idempotently before starting the
server. Existing local development continues to use `prisma/schema.prisma` and
SQLite; Hostinger uses `prisma/schema.production.prisma` and MySQL.

## Shopify production configuration

After the production URL responds successfully, deploy the production Shopify
configuration from an authenticated developer machine:

```sh
npm exec shopify app deploy --config production
```

The production config uses the stable `2026-07` webhook API version and the
production callback URL.

## Scheduled synchronization

Configure hPanel custom cron jobs only after the app is live. Replace
`YOUR_CRON_SECRET` with the same strong secret stored in the Web App environment.

Every ten minutes (price and inventory):

```sh
curl -fsS --max-time 540 -H "Authorization: Bearer YOUR_CRON_SECRET" "https://integrations.reprographics.co.nz/cron/trends-sync"
```

Daily full product refresh:

```sh
curl -fsS --max-time 900 -H "Authorization: Bearer YOUR_CRON_SECRET" "https://integrations.reprographics.co.nz/cron/trends-sync?mode=full"
```

Do not run the two jobs at the same time. Verify their output in hPanel after
the first scheduled execution.

## Release checks

1. Confirm `/health` returns `ok: true`.
2. Open the embedded app from Shopify Admin and complete authentication.
3. Test TRENDZ connectivity from Settings.
4. Fetch and sync one product, then verify product, variants, metafields,
   publication, price and inventory in Shopify.
5. Run each protected cron once and confirm `failed` is zero.
6. Enable database and application backups before the bulk import.
