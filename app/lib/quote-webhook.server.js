import { createHmac } from "node:crypto";

import { decryptSecret } from "./crypto.server";

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

export function validateQuoteWebhookUrl(value) {
  const input = String(value || "").trim();
  if (!input) return { ok: true, value: "" };

  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    const blocked =
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      PRIVATE_IPV4.some((pattern) => pattern.test(hostname));

    if (url.protocol !== "https:")
      return { ok: false, message: "Webhook URL must use HTTPS" };
    if (blocked)
      return {
        ok: false,
        message: "Private or local webhook URLs are not allowed",
      };
    if (url.username || url.password)
      return { ok: false, message: "Webhook URL cannot contain credentials" };

    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false, message: "Enter a valid webhook URL" };
  }
}

export async function deliverQuoteCreatedWebhook({
  url,
  encryptedSecret,
  quote,
  products,
  requestId,
}) {
  if (!url || !encryptedSecret)
    return { sent: false, reason: "not_configured" };

  const timestamp = new Date().toISOString();
  const payload = {
    event: "quote.created",
    version: "1.0",
    requestId,
    createdAt: quote.createdAt.toISOString(),
    data: {
      quoteRequestId: quote.id,
      customerType: quote.customerType,
      contact: {
        name: quote.contactName,
        phone: quote.contactPhone || "",
        email: quote.contactEmail,
        company: quote.contactCompany || "",
      },
      products,
      marketingConsent: quote.marketingConsent,
      source: quote.source,
      pageUrl: quote.pageUrl || "",
    },
  };
  const body = JSON.stringify(payload);
  const secret = decryptSecret(encryptedSecret);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Repro-Quote-Webhook/1.0",
      "X-Webhook-Event": "quote.created",
      "X-Webhook-Id": requestId,
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok)
    throw new Error(`Webhook endpoint returned HTTP ${response.status}`);

  return { sent: true, status: response.status };
}
