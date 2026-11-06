# Shopify Content file upload API

This endpoint is independent of the product, variant, pricing and stock features.
It accepts one or more files, stores them in Shopify Admin **Content > Files**,
and returns the final Shopify CDN URLs.

## Direct endpoint (Postman and external systems)

```text
POST https://integrations.reprographics.co.nz/api/file-upload
Authorization: Bearer {FILE_UPLOAD_API_KEY}
Content-Type: multipart/form-data
```

Configure these production environment variables first:

```text
SHOPIFY_STORE_DOMAIN=chydbh-g0.myshopify.com
FILE_UPLOAD_API_KEY={a-long-random-secret}
```

Do not use a Shopify Admin token or an OpenAI key as `FILE_UPLOAD_API_KEY`.

## Shopify storefront app-proxy endpoint

```text
POST https://{shop-domain}/apps/trends/file-upload
Content-Type: multipart/form-data
```

Use `file` or `files` as the multipart field name. Repeat the field once per
file.

## Rules

- Accepted: PDF, SVG, AI, EPS, PSD, JPG, JPEG, PNG, DOCX, WEBP
- Maximum: 20 files per request
- Maximum combined file size: 20 MB per request
- The request must use the Shopify app-proxy URL so its signature can be checked

## Example

```bash
curl --request POST \
  --header "Authorization: Bearer {FILE_UPLOAD_API_KEY}" \
  --form "file=@artwork.psd" \
  --form "file=@proof.pdf" \
  --form "file=@preview.png" \
  "https://integrations.reprographics.co.nz/api/file-upload"
```

## Successful response

```json
{
  "success": true,
  "code": "FILE_UPLOADED",
  "message": "File uploaded to Shopify Content successfully",
  "data": {
    "file": {
      "id": "gid://shopify/GenericFile/123",
      "filename": "artwork.psd",
      "extension": "psd",
      "mimeType": "image/vnd.adobe.photoshop",
      "size": 1048576,
      "status": "READY",
      "cdnUrl": "https://cdn.shopify.com/.../artwork.psd",
      "uploadId": "..."
    }
  },
  "errors": null,
  "meta": {
    "requestId": "...",
    "timestamp": "2026-09-25T00:00:00.000Z"
  }
}
```

## Error response

```json
{
  "success": false,
  "code": "FILE_TOO_LARGE",
  "message": "File size must not exceed 20 MB",
  "data": null,
  "errors": {
    "maximumBytes": 20971520
  },
  "meta": {
    "requestId": "...",
    "timestamp": "2026-09-25T00:00:00.000Z"
  }
}
```

Other validation and Shopify processing errors use the same response shape and
an appropriate HTTP status code.

## Deployment requirement

The app configuration now requests `read_files` and `write_files`. Deploy the
Shopify app configuration and approve the updated permissions before using the
endpoint.
