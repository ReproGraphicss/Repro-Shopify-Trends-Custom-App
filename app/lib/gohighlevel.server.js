import { decryptSecret } from "./crypto.server";

const splitName = (value) => {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    firstName: parts.shift() || "",
    lastName: parts.join(" "),
  };
};

const responseMessage = async (response) => {
  try {
    const data = await response.json();
    if (Array.isArray(data?.message)) return data.message.join(", ");
    return data?.message || data?.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

export async function syncQuoteContactToGoHighLevel({
  encryptedApiKey,
  locationId,
  quote,
}) {
  if (!encryptedApiKey || !locationId)
    return { sent: false, reason: "not_configured" };

  const apiKey = decryptSecret(encryptedApiKey);
  const { firstName, lastName } = splitName(quote.contactName);
  const payload = {
    firstName,
    lastName,
    name: quote.contactName,
    email: quote.contactEmail,
    locationId,
    source: "Shopify Get a Quote",
    companyName: quote.contactCompany || undefined,
    phone: quote.contactPhone || undefined,
    tags: ["shopify-get-a-quote"],
    createNewIfDuplicateAllowed: false,
  };

  const response = await fetch(
    "https://services.leadconnectorhq.com/contacts/upsert",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: "v3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!response.ok)
    throw new Error(
      `GoHighLevel contact sync failed: ${await responseMessage(response)}`,
    );

  const data = await response.json();
  return {
    sent: true,
    contactId: data?.contact?.id || data?.id || null,
  };
}
