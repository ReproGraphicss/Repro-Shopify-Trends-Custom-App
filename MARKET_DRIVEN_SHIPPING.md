# Market-driven shipping compatibility

The app detects `shop.features.marketDrivenShipping` before loading merchant
delivery profiles or assigning synced variants to a saved merchant profile.
On market-driven stores, Shopify Markets controls shipping; the app does not
read or mutate merchant delivery profiles. The saved legacy profile remains
available for stores that have not migrated. This does not automatically
translate a saved profile into product/location conditions in Markets.

If Shopify does not return a boolean shipping mode, the operation fails rather
than assuming a legacy store. Settings preserves the saved profile and shows
an unavailable message until the configuration can be verified. Legacy profile
loading follows all pages instead of silently omitting profiles after the
first 50.

## Release verification

1. Deploy the application server code using the existing Hostinger deployment
   process. Shopify app configuration deployment alone does not upload this
   server code.
2. On a development store created with the market-driven shipping preview,
   verify Settings identifies Markets as the shipping manager. Sync a main
   product and a configured master product. Verify no merchant delivery profile
   read/update is made.
3. Configure the applicable product/location conditions in Shopify Markets.
   Test checkout shipping rates for each supported destination, including carts
   containing both existing and newly synced products. Skipping legacy profile
   assignment alone does not prove rate coverage.
4. On a legacy test store, verify profile selection and variant assignment still
   work. Verify a configuration API failure preserves the saved selection.
5. After verification, the app owner must submit Shopify's compatibility
   self-attestation linked in the official upgrade guide. A local code change
   does not clear Shopify Admin's compatibility warning.

Official guide:
https://shopify.dev/docs/apps/build/orders-fulfillment/market-driven-shipping/upgrade-your-app

Local checks:

```sh
node --test tests/market-driven-shipping.test.js
npx react-router build
```

Use the direct React Router build for a code-only check. The repository's
`npm run build` also pushes the production database schema with
`--accept-data-loss` and is not necessary for this shipping fix.
