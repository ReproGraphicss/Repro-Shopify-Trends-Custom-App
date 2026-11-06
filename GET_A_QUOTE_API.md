# Get a Quote API

This feature is independent of the TRENDS catalog and pricing workflows. Quote
requests are stored in the app database and displayed in **Get a Quote List** in
the embedded Shopify app.

## Storefront endpoint

```text
POST https://reprographics.co.nz/apps/trends/quote-request
```

The request must be sent through this Shopify app-proxy URL. Shopify signs the
request before forwarding it to the app, allowing the app to associate the quote
with the correct store. Do not submit directly to the integrations domain.

## Headers

```http
Content-Type: application/json
```

## Example

```javascript
const payload = {
  customerType: "New customer",
  contact: {
    name: "Alex Smith",
    phone: "09 123 4567",
    email: "alex@example.com",
    company: "Example Company",
  },
  products: [
    {
      type: "Existing product",
      title: "Nomad Bottle - Translucent",
      handle: "nomad-bottle-translucent",
      url: `${window.location.origin}/products/nomad-bottle-translucent`,
      image: "https://cdn.shopify.com/example.jpg",
      quantities: [48, 96],
      options: {
        Colour: "Black",
        "How would you like your product?": "Add Branding",
        "How would you like your logo applied": "Pad Print",
        "Gift Packaging (optional)": "Gift Box",
      },
      additionalDetails: "Additional product requirements",
      customSpecifications: "",
      artwork: {
        helpRequired: "Yes — I need design help",
        brief: "Please place the logo in the centre.",
        uploadedFiles: [
          "https://integrations.reprographics.co.nz/uploads/artwork.pdf",
        ],
        sharedFileLink: "https://drive.google.com/example",
      },
      shipping: "Delivery",
      requiredBy: "2026-11-30",
    },
  ],
  marketingConsent: true,
  source: "Shopify Get a Quote page",
  pageUrl: window.location.href,
};

const response = await fetch("/apps/trends/quote-request", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const result = await response.json();
if (!response.ok) throw new Error(result.message || "Quote submission failed");
console.log(result.quoteRequestId);
```

## Required values

- `customerType`
- `contact.name`
- `contact.email`
- At least one `products` entry
- Every product needs `type`, `title`, and at least one valid `quantities` value

Up to 25 products, 30 options per product, and 20 uploaded-file URLs per product
are accepted. Quantities must be whole numbers between 1 and 100,000.

## Success response

```json
{
  "ok": true,
  "message": "Quote request submitted successfully",
  "quoteRequestId": "cm...",
  "requestId": "...",
  "createdAt": "2026-10-27T10:00:00.000Z"
}
```
