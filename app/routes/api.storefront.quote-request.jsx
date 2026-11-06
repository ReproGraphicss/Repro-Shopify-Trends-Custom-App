import crypto from "node:crypto";

import prisma from "../db.server";
import { sendQuoteRequestNotification } from "../email.server";
import { syncQuoteContactToGoHighLevel } from "../lib/gohighlevel.server";
import { authenticate } from "../shopify.server";

const MAX_PRODUCTS = 25;
const MAX_OPTIONS = 30;
const MAX_FILES = 20;

const response = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });

const fail = (message, status = 400, field = null) =>
  response({ ok: false, message, field }, status);

const text = (value, max = 500) =>
  String(value ?? "")
    .trim()
    .slice(0, max);

const optionalUrl = (value, field) => {
  const normalized = text(value, 2048);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch {
    throw new Error(`${field} must be a valid HTTP or HTTPS URL`);
  }
};

const normalizeProduct = (product, index) => {
  if (!product || typeof product !== "object" || Array.isArray(product))
    throw new Error(`products[${index}] must be an object`);

  const type = text(product.type, 100);
  const title = text(product.title, 500);
  if (!type) throw new Error(`products[${index}].type is required`);
  if (!title) throw new Error(`products[${index}].title is required`);

  const quantities = Array.isArray(product.quantities)
    ? [...new Set(product.quantities.map((value) => Math.trunc(Number(value))))]
    : [];
  if (
    !quantities.length ||
    quantities.some(
      (quantity) =>
        !Number.isFinite(quantity) || quantity < 1 || quantity > 100000,
    )
  )
    throw new Error(
      `products[${index}].quantities must contain values between 1 and 100000`,
    );

  const rawOptions =
    product.options &&
    typeof product.options === "object" &&
    !Array.isArray(product.options)
      ? Object.entries(product.options)
      : [];
  if (rawOptions.length > MAX_OPTIONS)
    throw new Error(`products[${index}].options has too many entries`);
  const options = Object.fromEntries(
    rawOptions
      .map(([key, value]) => [text(key, 200), text(value, 500)])
      .filter(([key]) => key),
  );

  const artwork =
    product.artwork &&
    typeof product.artwork === "object" &&
    !Array.isArray(product.artwork)
      ? product.artwork
      : {};
  const files = Array.isArray(artwork.uploadedFiles)
    ? artwork.uploadedFiles
        .slice(0, MAX_FILES)
        .map((url, fileIndex) =>
          optionalUrl(
            url,
            `products[${index}].artwork.uploadedFiles[${fileIndex}]`,
          ),
        )
    : [];

  return {
    type,
    title,
    handle: text(product.handle, 255),
    url: optionalUrl(product.url, `products[${index}].url`),
    image: optionalUrl(product.image, `products[${index}].image`),
    quantities,
    options,
    additionalDetails: text(product.additionalDetails, 5000),
    customSpecifications: text(product.customSpecifications, 5000),
    artwork: {
      helpRequired: text(artwork.helpRequired, 255),
      brief: text(artwork.brief, 5000),
      uploadedFiles: files,
      sharedFileLink: optionalUrl(
        artwork.sharedFileLink,
        `products[${index}].artwork.sharedFileLink`,
      ),
    },
    shipping: text(product.shipping, 100),
    requiredBy: text(product.requiredBy, 50),
  };
};

const handle = async (request) => {
  if (request.method === "OPTIONS") return response({ ok: true });
  if (request.method !== "POST") return fail("Use POST for this endpoint", 405);

  let session;
  try {
    ({ session } = await authenticate.public.appProxy(request));
  } catch {
    return fail("The quote request is not authorized", 401);
  }
  if (!session?.shop) return fail("Store is not connected", 401);

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json"))
      return fail("Use application/json for this endpoint", 415);

    const input = await request.json();
    const customerType = text(input.customerType, 100);
    const contact =
      input.contact && typeof input.contact === "object" ? input.contact : {};
    const contactName = text(contact.name, 255);
    const contactEmail = text(contact.email, 320).toLowerCase();
    if (!customerType)
      return fail("customerType is required", 422, "customerType");
    if (!contactName)
      return fail("contact.name is required", 422, "contact.name");
    if (!/^\S+@\S+\.\S+$/.test(contactEmail))
      return fail("contact.email must be valid", 422, "contact.email");
    if (!Array.isArray(input.products) || !input.products.length)
      return fail("At least one product is required", 422, "products");
    if (input.products.length > MAX_PRODUCTS)
      return fail(
        `A maximum of ${MAX_PRODUCTS} products is allowed`,
        422,
        "products",
      );

    const products = input.products.map(normalizeProduct);
    const requestId = crypto.randomUUID();
    const settings = await prisma.shopSettings.findUnique({
      where: { shop: session.shop },
      select: {
        quoteNotificationEmail: true,
        encryptedGoHighLevelApiKey: true,
        goHighLevelLocationId: true,
      },
    });
    const quote = await prisma.quoteRequest.create({
      data: {
        shop: session.shop,
        customerType,
        contactName,
        contactPhone: text(contact.phone, 100) || null,
        contactEmail,
        contactCompany: text(contact.company, 255) || null,
        productsJson: JSON.stringify(products),
        marketingConsent: Boolean(input.marketingConsent),
        source: text(input.source, 255) || "Shopify Get a Quote page",
        pageUrl: optionalUrl(input.pageUrl, "pageUrl") || null,
      },
    });
    let notification = { sent: false, reason: "delivery_failed" };
    try {
      notification = await sendQuoteRequestNotification({
        quote,
        products,
        requestId,
        notificationTo: settings?.quoteNotificationEmail,
      });
    } catch (error) {
      console.error("Quote notification email failed", {
        quoteRequestId: quote.id,
        message: error instanceof Error ? error.message : "Unknown SMTP error",
      });
    }

    if (
      settings?.encryptedGoHighLevelApiKey &&
      settings.goHighLevelLocationId
    ) {
      setImmediate(() => {
        syncQuoteContactToGoHighLevel({
          encryptedApiKey: settings.encryptedGoHighLevelApiKey,
          locationId: settings.goHighLevelLocationId,
          quote,
        }).catch((error) => {
          console.error("GoHighLevel quote contact sync failed", {
            quoteRequestId: quote.id,
            message:
              error instanceof Error
                ? error.message
                : "Unknown HighLevel error",
          });
        });
      });
    }

    return response(
      {
        ok: true,
        message: "Quote request submitted successfully",
        quoteRequestId: quote.id,
        requestId,
        createdAt: quote.createdAt.toISOString(),
        notificationSent: notification.sent,
      },
      201,
    );
  } catch (error) {
    return fail(
      error instanceof SyntaxError
        ? "Request body must contain valid JSON"
        : error instanceof Error
          ? error.message
          : "Quote request could not be submitted",
      error instanceof SyntaxError ? 400 : 422,
    );
  }
};

export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
