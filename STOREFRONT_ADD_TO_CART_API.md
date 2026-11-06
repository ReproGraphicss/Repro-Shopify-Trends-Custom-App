# Storefront dynamic pricing and add-to-cart API

Use the Shopify App Proxy URLs from the storefront. Do not call the app server
domain directly.

## 1. Optional pricing verification

The storefront calculator reads the complete pricing configuration from
`trends.product_configuration` and calculates selection changes locally. It
does not call this endpoint when the customer changes a variant, quantity,
branding method, or packaging option.

This read-only endpoint remains available for diagnostics and independent
pricing verification.

```http
POST /apps/trends/pricing
Content-Type: application/json
Accept: application/json
```

```json
{
  "variantSku": "126858",
  "quantity": 25,
  "brandingSku": "ROTARY-DIGITAL-PRINT-CODE",
  "brandingQuantity": 25,
  "packagingSku": "OPTIONAL-PACKAGING-CODE",
  "packagingQuantity": 25,
  "shippingService": null
}
```

| Field | Required | Value |
| --- | --- | --- |
| `variantSku` | Yes | Selected source Shopify/TRENDS variant SKU. |
| `quantity` | Yes | Product quantity, integer from `1` to `100000`. |
| `brandingSku` | No | Selected `brandingMethods[].unitChargeCode`; `null` for unbranded. |
| `brandingQuantity` | No | Units receiving branding; defaults to `quantity`. |
| `packagingSku` | No | Selected premium `packagingMethods[].unitChargeCode`; `null` for standard packaging. |
| `packagingQuantity` | No | Units receiving paid packaging; defaults to `quantity`. |
| `shippingService` | No | Send `null` while fixed shipping is active. |

Do not send supplier prices, setup fees, markup, or shipping amounts from the
browser. The backend resolves those values for the matched product.

Important response fields:

```json
{
  "ok": true,
  "currency": "NZD",
  "productCode": "126879",
  "variantSku": "126858",
  "quantity": 25,
  "appliedTierQuantity": 25,
  "baseUnitPrice": 13.21,
  "brandingUnitPrice": 3,
  "packagingUnitPrice": 0,
  "setupPrice": 40,
  "shippingCharge": 15,
  "rawSubtotal": 460.25,
  "markupPercent": 40,
  "markupAmount": 184.1,
  "subtotal": 644.35,
  "unitPrice": 25.77,
  "gstRate": 0.15,
  "gstAmount": 96.65,
  "totalIncludingGst": 741,
  "unitPriceIncludingGst": 29.64
}
```

These numbers are examples only. Every amount is calculated dynamically from
the selected product, tier, options, store settings, and quantity.

## 2. Prepare the configured Shopify variant

Call this only when the customer clicks **Add to cart**. The backend ignores
the locally displayed amount, recalculates the final price from its stored
supplier data, and creates or reuses the quantity-specific Shopify variant.

```http
POST /apps/trends/configuration-variant
Content-Type: application/json
Accept: application/json
```

Unbranded request:

```json
{
  "variantId": 123456789,
  "variantSku": "126858",
  "quantity": 25,
  "service": "unbranded",
  "brandingId": null,
  "brandingQuantity": null,
  "packagingId": null,
  "packagingQuantity": null,
  "shippingService": null
}
```

Branded with optional paid packaging:

```json
{
  "variantId": 123456789,
  "variantSku": "126858",
  "quantity": 25,
  "service": "branding",
  "brandingId": "SELECTED_BRANDING_COST_ID",
  "brandingQuantity": 25,
  "packagingId": "SELECTED_PACKAGING_COST_ID",
  "packagingQuantity": 25,
  "shippingService": null
}
```

| Field | Required | Value |
| --- | --- | --- |
| `variantId` | Yes | Selected Shopify source variant numeric ID or GID. |
| `variantSku` | Yes | Selected source variant SKU; it must match `variantId`. |
| `quantity` | Yes | Product quantity, integer from `1` to `100000`. |
| `service` | Yes | `unbranded` or `branding`; packaging is independent. |
| `brandingId` | Conditional | Selected `brandingMethods[].id`; required for branding. |
| `brandingQuantity` | No | Defaults to the product quantity. |
| `packagingId` | No | Selected premium `packagingMethods[].methodId`. |
| `packagingQuantity` | No | Defaults to the product quantity. |
| `shippingService` | No | Send `null` while fixed shipping is active. |

The configured variant identity includes the requested quantity, so different
quantities cannot overwrite each other's Shopify variant price.

Important response fields:

```json
{
  "ok": true,
  "variantId": "gid://shopify/ProductVariant/987654321",
  "numericVariantId": "987654321",
  "productId": "gid://shopify/Product/123456789",
  "cartQuantity": 25,
  "requestedQuantity": 25,
  "price": 29.64,
  "lineSubtotal": 741,
  "currency": "NZD",
  "properties": {
    "Source SKU": "126858",
    "Service": "branding+gift_box",
    "Requested quantity": "25",
    "Branding option": "Rotary Digital Print",
    "Packaging option": "Gift Box"
  }
}
```

`price` is the configured Shopify variant's GST-inclusive unit price and
`cartQuantity` is the requested product quantity.

## 3. Add the returned variant to Shopify cart

```http
POST /cart/add.js
Content-Type: application/json
Accept: application/json
```

```json
{
  "items": [
    {
      "id": 987654321,
      "quantity": 25,
      "properties": {
        "Source SKU": "126858",
        "Service": "branding+gift_box",
        "Requested quantity": "25"
      }
    }
  ]
}
```

Always use the returned `numericVariantId`, `cartQuantity`, and `properties`.

The live pricing endpoint does not write to Shopify. The configuration endpoint
uses Shopify Admin GraphQL to find the source variant, create or update the
quantity-specific configured variant, publish it when required, and assign its
shipping profile. The final `/cart/add.js` request is Shopify's storefront cart
request.

All application endpoint errors use:

```json
{
  "ok": false,
  "message": "Error description"
}
```
