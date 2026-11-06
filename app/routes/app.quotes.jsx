/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Form, useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { normalizeEmailRecipients } from "../lib/email-recipients";
import { encryptSecret } from "../lib/crypto.server";

const STATUSES = ["NEW", "REVIEWING", "QUOTED", "CLOSED"];
const PAGE_SIZE = 25;

const safeProducts = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const serializeQuote = (quote) => ({
  ...quote,
  products: safeProducts(quote.productsJson),
  productsJson: undefined,
  createdAt: quote.createdAt.toISOString(),
  updatedAt: quote.updatedAt.toISOString(),
});

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = String(url.searchParams.get("q") || "").trim();
  const requestedStatus = String(url.searchParams.get("status") || "ALL");
  const status = STATUSES.includes(requestedStatus) ? requestedStatus : "ALL";
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const where = {
    shop: session.shop,
    ...(status !== "ALL" ? { status } : {}),
    ...(search
      ? {
          OR: [
            { contactName: { contains: search } },
            { contactEmail: { contains: search } },
            { contactCompany: { contains: search } },
            { productsJson: { contains: search } },
          ],
        }
      : {}),
  };
  const [total, counts, settings] = await Promise.all([
    prisma.quoteRequest.count({ where }),
    prisma.quoteRequest.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: { _all: true },
    }),
    prisma.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop },
      update: {},
      select: {
        quoteNotificationEmail: true,
        encryptedGoHighLevelApiKey: true,
        goHighLevelLocationId: true,
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const quotes = await prisma.quoteRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  const statusCounts = Object.fromEntries(
    counts.map((item) => [item.status, item._count._all]),
  );
  return {
    quotes: quotes.map(serializeQuote),
    filters: { search, status },
    pagination: { page, total, totalPages },
    summary: {
      total: Object.values(statusCounts).reduce((sum, value) => sum + value, 0),
      new: statusCounts.NEW || 0,
      reviewing: statusCounts.REVIEWING || 0,
      quoted: statusCounts.QUOTED || 0,
    },
    quoteNotificationEmail: settings.quoteNotificationEmail || "",
    goHighLevelLocationId: settings.goHighLevelLocationId || "",
    goHighLevelApiKeyConfigured: Boolean(settings.encryptedGoHighLevelApiKey),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "update-notification-email") {
    const normalized = normalizeEmailRecipients(
      form.get("quoteNotificationEmail"),
    );
    if (normalized.invalid.length)
      return Response.json(
        {
          ok: false,
          intent,
          message: `Invalid email: ${normalized.invalid.join(", ")}`,
        },
        { status: 422 },
      );
    if (normalized.tooMany)
      return Response.json(
        { ok: false, intent, message: "Add no more than 20 recipients" },
        { status: 422 },
      );
    const quoteNotificationEmail = normalized.value;
    await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        quoteNotificationEmail: quoteNotificationEmail || null,
      },
      update: { quoteNotificationEmail: quoteNotificationEmail || null },
    });
    return Response.json({
      ok: true,
      intent,
      message: "Quote notification email saved",
      quoteNotificationEmail,
    });
  }

  if (intent === "update-gohighlevel-settings") {
    const locationId = String(form.get("goHighLevelLocationId") || "").trim();
    const apiKey = String(form.get("goHighLevelApiKey") || "").trim();
    if (!locationId || locationId.length > 255)
      return Response.json(
        { ok: false, intent, message: "Enter a valid Location ID" },
        { status: 422 },
      );

    const existing = await prisma.shopSettings.findUnique({
      where: { shop: session.shop },
      select: { encryptedGoHighLevelApiKey: true },
    });
    const encryptedGoHighLevelApiKey = apiKey
      ? encryptSecret(apiKey)
      : existing?.encryptedGoHighLevelApiKey || null;
    if (!encryptedGoHighLevelApiKey)
      return Response.json(
        { ok: false, intent, message: "Enter the GoHighLevel API key" },
        { status: 422 },
      );

    await prisma.shopSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        encryptedGoHighLevelApiKey,
        goHighLevelLocationId: locationId,
      },
      update: {
        encryptedGoHighLevelApiKey,
        goHighLevelLocationId: locationId,
      },
    });
    return Response.json({
      ok: true,
      intent,
      message: "GoHighLevel integration settings saved",
      goHighLevelLocationId: locationId,
      goHighLevelApiKeyConfigured: true,
    });
  }

  if (intent === "update-statuses") {
    let updates;
    try {
      updates = JSON.parse(String(form.get("updates") || "[]"));
    } catch {
      updates = null;
    }
    if (!Array.isArray(updates) || !updates.length)
      return Response.json(
        { ok: false, message: "No status changes were supplied" },
        { status: 422 },
      );
    if (
      updates.length > PAGE_SIZE ||
      updates.some(
        (item) =>
          !item ||
          typeof item.id !== "string" ||
          !STATUSES.includes(item.status),
      )
    )
      return Response.json(
        { ok: false, message: "One or more status changes are invalid" },
        { status: 422 },
      );
    const results = await prisma.$transaction(
      updates.map((item) =>
        prisma.quoteRequest.updateMany({
          where: { id: item.id, shop: session.shop },
          data: { status: item.status },
        }),
      ),
    );
    return Response.json({
      ok: true,
      intent,
      updated: results.reduce((total, result) => total + result.count, 0),
    });
  }

  if (intent === "delete") {
    const id = String(form.get("id") || "");
    if (!id)
      return Response.json(
        { ok: false, message: "Quote request is required" },
        { status: 422 },
      );
    const result = await prisma.quoteRequest.deleteMany({
      where: { id, shop: session.shop },
    });
    if (!result.count)
      return Response.json(
        { ok: false, message: "Quote request was not found" },
        { status: 404 },
      );
    return Response.json({ ok: true, intent, deleted: id });
  }

  return Response.json(
    { ok: false, message: "Unknown action" },
    { status: 400 },
  );
};

const formatDate = (value) =>
  new Intl.DateTimeFormat("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Pacific/Auckland",
  }).format(new Date(value));

const titleCase = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());

function ProductImage({ src, title }) {
  const [available, setAvailable] = useState(Boolean(src));
  useEffect(() => setAvailable(Boolean(src)), [src]);
  return (
    <div className="quote-product-image-frame">
      {available ? (
        <img
          className="quote-product-image"
          src={src}
          alt={title}
          onError={() => setAvailable(false)}
        />
      ) : (
        <div className="quote-image-placeholder" aria-label="No product image">
          <span className="quote-placeholder-icon">◇</span>
          <span>No image</span>
        </div>
      )}
    </div>
  );
}

function QuoteDetails({ quote }) {
  if (!quote)
    return <s-paragraph>Select a quote request to view it.</s-paragraph>;
  return (
    <div className="quote-detail-content">
      <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="base">
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-heading>Customer details</s-heading>
            <s-text type="strong">{quote.contactName}</s-text>
            <s-link href={`mailto:${quote.contactEmail}`}>
              {quote.contactEmail}
            </s-link>
            {quote.contactPhone ? <s-text>{quote.contactPhone}</s-text> : null}
            {quote.contactCompany ? (
              <s-text>{quote.contactCompany}</s-text>
            ) : null}
            <s-badge tone="success">{quote.customerType}</s-badge>
          </s-stack>
        </s-box>
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-heading>Request details</s-heading>
            <s-text>Received: {formatDate(quote.createdAt)}</s-text>
            <s-text>Source: {quote.source || "Not supplied"}</s-text>
            <s-text>
              Marketing consent: {quote.marketingConsent ? "Yes" : "No"}
            </s-text>
            {quote.pageUrl ? (
              <s-link href={quote.pageUrl} target="_blank">
                Open source page
              </s-link>
            ) : null}
          </s-stack>
        </s-box>
      </s-grid>

      <div className="quote-products-heading">
        <s-heading>Requested products ({quote.products.length})</s-heading>
      </div>
      <div className="quote-product-list">
        {quote.products.map((product, index) => (
          <div className="quote-product-card" key={`${product.title}-${index}`}>
            <div className="quote-product-topline">
              <span className="quote-detail-number">{index + 1}</span>
              <ProductImage src={product.image} title={product.title} />
              <div className="quote-product-summary">
                <s-stack direction="block" gap="small-200">
                  <s-heading>{product.title}</s-heading>
                  <s-badge tone="success">{product.type}</s-badge>
                  <s-text>
                    Quantities: {(product.quantities || []).join(", ")}
                  </s-text>
                  {product.shipping ? (
                    <s-text>Shipping: {product.shipping}</s-text>
                  ) : null}
                  {product.requiredBy ? (
                    <s-text>Required by: {product.requiredBy}</s-text>
                  ) : null}
                  {product.url ? (
                    <s-link href={product.url} target="_blank">
                      Open product
                    </s-link>
                  ) : null}
                </s-stack>
              </div>
            </div>

            {Object.keys(product.options || {}).length ? (
              <div className="quote-option-grid">
                {Object.entries(product.options).map(([key, value]) => (
                  <div className="quote-option-item" key={key}>
                    <span>{key}</span>
                    <strong>{String(value)}</strong>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="quote-notes-grid">
              {product.additionalDetails ? (
                <div>
                  <span>Additional details</span>
                  <p>{product.additionalDetails}</p>
                </div>
              ) : null}
              {product.customSpecifications ? (
                <div>
                  <span>Custom specifications</span>
                  <p>{product.customSpecifications}</p>
                </div>
              ) : null}
              {product.artwork?.helpRequired ? (
                <div>
                  <span>Artwork</span>
                  <p>{product.artwork.helpRequired}</p>
                  {product.artwork.brief ? (
                    <p>{product.artwork.brief}</p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {(product.artwork?.uploadedFiles || []).length ||
            product.artwork?.sharedFileLink ? (
              <div className="quote-artwork-links">
                {(product.artwork?.uploadedFiles || []).map(
                  (url, fileIndex) => (
                    <s-link key={url} href={url} target="_blank">
                      Artwork file {fileIndex + 1}
                    </s-link>
                  ),
                )}
                {product.artwork?.sharedFileLink ? (
                  <s-link href={product.artwork.sharedFileLink} target="_blank">
                    Shared artwork folder
                  </s-link>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function QuotesPage() {
  // Temporarily hide CRM settings; retain the integration and saved configuration.
  const showGoHighLevelSettings = false;
  const {
    quotes,
    filters,
    pagination,
    summary,
    quoteNotificationEmail,
    goHighLevelLocationId,
    goHighLevelApiKeyConfigured,
  } = useLoaderData();
  const fetcher = useFetcher();
  const notificationFetcher = useFetcher();
  const webhookFetcher = useFetcher();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const [statusDrafts, setStatusDrafts] = useState(() =>
    Object.fromEntries(quotes.map((quote) => [quote.id, quote.status])),
  );
  const busy = fetcher.state !== "idle";
  const notificationBusy = notificationFetcher.state !== "idle";
  const [notificationEmail, setNotificationEmail] = useState(
    quoteNotificationEmail || "",
  );
  const [notificationConfirmed, setNotificationConfirmed] = useState(false);
  const webhookBusy = webhookFetcher.state !== "idle";

  useEffect(() => {
    setStatusDrafts(
      Object.fromEntries(quotes.map((quote) => [quote.id, quote.status])),
    );
  }, [quotes]);

  useEffect(() => {
    if (
      (!selected && !deleteTarget && !webhookModalOpen) ||
      typeof document === "undefined"
    )
      return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || busy) return;
      if (webhookModalOpen) {
        setWebhookModalOpen(false);
        return;
      }
      setSelected(null);
      setDeleteTarget(null);
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [busy, deleteTarget, selected, webhookModalOpen]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(
        fetcher.data.intent === "delete"
          ? "Quote request deleted"
          : "Quote statuses saved",
      );
      setDeleteTarget(null);
    } else if (fetcher.data.message) {
      shopify.toast.show(fetcher.data.message, { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  useEffect(() => {
    if (notificationFetcher.state !== "idle" || !notificationFetcher.data)
      return;
    if (notificationFetcher.data.ok) {
      setNotificationEmail(
        notificationFetcher.data.quoteNotificationEmail || "",
      );
      setNotificationConfirmed(true);
      shopify.toast.show("Quote notification email saved");
    } else if (notificationFetcher.data.message) {
      setNotificationConfirmed(false);
      shopify.toast.show(notificationFetcher.data.message, { isError: true });
    }
  }, [notificationFetcher.data, notificationFetcher.state, shopify]);

  useEffect(() => {
    if (webhookFetcher.state !== "idle" || !webhookFetcher.data) return;
    if (webhookFetcher.data.ok) {
      setWebhookModalOpen(false);
      shopify.toast.show(webhookFetcher.data.message);
    } else if (webhookFetcher.data.message) {
      shopify.toast.show(webhookFetcher.data.message, { isError: true });
    }
  }, [shopify, webhookFetcher.data, webhookFetcher.state]);

  const changedStatuses = useMemo(
    () =>
      quotes
        .filter((quote) => statusDrafts[quote.id] !== quote.status)
        .map((quote) => ({ id: quote.id, status: statusDrafts[quote.id] })),
    [quotes, statusDrafts],
  );
  const saveStatuses = () => {
    if (!changedStatuses.length || busy) return;
    fetcher.submit(
      {
        intent: "update-statuses",
        updates: JSON.stringify(changedStatuses),
      },
      { method: "post" },
    );
  };

  const deleteQuote = () => {
    if (!deleteTarget || busy) return;
    fetcher.submit(
      { intent: "delete", id: deleteTarget.id },
      { method: "post" },
    );
  };

  const queryForPage = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.search) params.set("q", filters.search);
    if (filters.status !== "ALL") params.set("status", filters.status);
    return params;
  }, [filters]);
  const pageHref = (page) => {
    const params = new URLSearchParams(queryForPage);
    params.set("page", String(page));
    return `?${params.toString()}`;
  };

  return (
    <s-page heading="Get a Quote List" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        icon="save"
        disabled={!changedStatuses.length || busy}
        loading={busy && changedStatuses.length > 0}
        onClick={saveStatuses}
      >
        {changedStatuses.length
          ? `Save changes (${changedStatuses.length})`
          : "Save changes"}
      </s-button>
      <div className="quote-page-shell">
        <div className="quote-page-intro">
          <div className="quote-intro-copy">
            <p className="quote-eyebrow">CUSTOMER ENQUIRIES</p>
            <div className="quote-intro-title-row">
              <h2>Quote request management</h2>
              {showGoHighLevelSettings && (
              <s-button
                icon="settings"
                variant="tertiary"
                accessibilityLabel="Open quote webhook settings"
                onClick={() => setWebhookModalOpen(true)}
              >
                Settings
              </s-button>
              )}
            </div>
            <p>
              Review customer requirements, update progress and manage every
              request in one place.
            </p>
          </div>
          <notificationFetcher.Form
            method="post"
            className="quote-notification-form"
          >
            <input
              type="hidden"
              name="intent"
              value="update-notification-email"
            />
            <label htmlFor="quote-notification-email">
              Quote notifications
            </label>
            <input
              id="quote-notification-email"
              className="quote-notification-input"
              name="quoteNotificationEmail"
              type="email"
              multiple
              autoComplete="email"
              placeholder="example@gmail.com"
              defaultValue={quoteNotificationEmail}
              onInput={() => setNotificationConfirmed(false)}
              required
            />
            {notificationConfirmed ? (
              <div className="quote-notification-success" role="status">
                <span aria-hidden="true">✓</span>
                Notification recipients saved successfully.
              </div>
            ) : null}
            <div className="quote-notification-actions">
              <div>
                <small>
                  Enter the email address(es) where you would like to receive
                  Get a Quote notifications. Use commas for multiple addresses.
                </small>
                {notificationEmail ? (
                  <span className="quote-notification-current">
                    Saved: {notificationEmail}
                  </span>
                ) : null}
              </div>
              <s-button
                type="submit"
                variant="primary"
                loading={notificationBusy}
                disabled={notificationBusy}
              >
                Save email
              </s-button>
            </div>
          </notificationFetcher.Form>
        </div>

        <div className="quote-metrics-grid">
          {[
            ["Total requests", summary.total, "01"],
            ["New", summary.new, "02"],
            ["Reviewing", summary.reviewing, "03"],
            ["Quoted", summary.quoted, "04"],
          ].map(([label, value, number]) => (
            <div className="quote-metric-card" key={label}>
              <span className="quote-metric-index">{number}</span>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>

        <div className="quote-list-card">
          <div className="quote-list-heading">
            <div>
              <h3>Customer quote requests</h3>
              <p>
                {pagination.total} matching request
                {pagination.total === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <Form method="get">
            <div className="quote-filters">
              <s-search-field
                label="Search"
                name="q"
                defaultValue={filters.search}
                placeholder="Customer, company, email or product"
              />
              <s-select label="Status" name="status" value={filters.status}>
                <s-option value="ALL">All statuses</s-option>
                {STATUSES.map((status) => (
                  <s-option key={status} value={status}>
                    {titleCase(status)}
                  </s-option>
                ))}
              </s-select>
              <s-button type="submit" variant="primary">
                Apply filters
              </s-button>
            </div>
          </Form>

          <div className="quote-table-wrap">
            {quotes.length ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header>#</s-table-header>
                  <s-table-header listSlot="primary">Customer</s-table-header>
                  <s-table-header>Company</s-table-header>
                  <s-table-header>Products</s-table-header>
                  <s-table-header>Received</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {quotes.map((quote, index) => (
                    <s-table-row key={quote.id}>
                      <s-table-cell>
                        <span className="quote-row-number">
                          {(pagination.page - 1) * PAGE_SIZE + index + 1}
                        </span>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-200">
                          <s-text type="strong">{quote.contactName}</s-text>
                          <s-link href={`mailto:${quote.contactEmail}`}>
                            {quote.contactEmail}
                          </s-link>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{quote.contactCompany || "—"}</s-table-cell>
                      <s-table-cell>
                        <span className="quote-product-count">
                          {quote.products.length}
                        </span>{" "}
                        {quote.products
                          .slice(0, 2)
                          .map((product) => product.title)
                          .join(", ")}
                        {quote.products.length > 2 ? "…" : ""}
                      </s-table-cell>
                      <s-table-cell>{formatDate(quote.createdAt)}</s-table-cell>
                      <s-table-cell>
                        <div className="quote-status-cell">
                          <s-select
                            name={`status-${quote.id}`}
                            value={statusDrafts[quote.id]}
                            label={`Status for ${quote.contactName}`}
                            labelAccessibilityVisibility="exclusive"
                            onChange={(event) => {
                              const nextStatus = event.currentTarget.value;
                              if (!STATUSES.includes(nextStatus)) return;
                              setStatusDrafts((current) => ({
                                ...current,
                                [quote.id]: nextStatus,
                              }));
                            }}
                          >
                            {STATUSES.map((status) => (
                              <s-option key={status} value={status}>
                                {titleCase(status)}
                              </s-option>
                            ))}
                          </s-select>
                        </div>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-200">
                          <s-button
                            icon="view"
                            onClick={() => setSelected(quote)}
                          >
                            View
                          </s-button>
                          <s-button
                            icon="delete"
                            tone="critical"
                            variant="tertiary"
                            accessibilityLabel={`Delete quote from ${quote.contactName}`}
                            onClick={() => setDeleteTarget(quote)}
                          />
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <div className="quote-empty-state">
                <span>◇</span>
                <h3>No quote requests found</h3>
                <p>New storefront submissions will appear here.</p>
              </div>
            )}
          </div>

          <div className="quote-pagination">
            <span>
              Page {pagination.page} of {pagination.totalPages} ·{" "}
              {pagination.total} results
            </span>
            <div>
              {pagination.page > 1 ? (
                <s-link href={pageHref(pagination.page - 1)}>Previous</s-link>
              ) : null}
              {pagination.page < pagination.totalPages ? (
                <s-link href={pageHref(pagination.page + 1)}>Next</s-link>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {showGoHighLevelSettings && webhookModalOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="quote-modal-backdrop quote-webhook-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !webhookBusy)
                  setWebhookModalOpen(false);
              }}
            >
              <section
                className="quote-modal-panel quote-ghl-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="quote-ghl-modal-title"
              >
                <header className="quote-modal-header quote-webhook-modal-header">
                  <div>
                    <span className="quote-webhook-kicker">
                      CRM INTEGRATION
                    </span>
                    <h2 id="quote-ghl-modal-title">Connect GoHighLevel</h2>
                    <p>
                      Automatically create or update a GoHighLevel contact when
                      a customer submits a quote request.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="quote-modal-close"
                    aria-label="Close GoHighLevel settings"
                    disabled={webhookBusy}
                    onClick={() => setWebhookModalOpen(false)}
                  >
                    ×
                  </button>
                </header>
                <div className="quote-modal-body quote-ghl-modal-body">
                  <div className="quote-ghl-status-card">
                    <span
                      className={
                        goHighLevelApiKeyConfigured && goHighLevelLocationId
                          ? "is-connected"
                          : ""
                      }
                      aria-hidden="true"
                    />
                    <div>
                      <strong>
                        {goHighLevelApiKeyConfigured && goHighLevelLocationId
                          ? "GoHighLevel is connected"
                          : "GoHighLevel is not configured"}
                      </strong>
                      <p>
                        Contact name, email, phone, company and source will sync
                        securely after each submission.
                      </p>
                    </div>
                  </div>

                  <webhookFetcher.Form method="post" className="quote-ghl-form">
                    <input
                      type="hidden"
                      name="intent"
                      value="update-gohighlevel-settings"
                    />
                    <label htmlFor="ghl-location-id">
                      Location ID
                      <input
                        id="ghl-location-id"
                        name="goHighLevelLocationId"
                        type="text"
                        maxLength={255}
                        defaultValue={goHighLevelLocationId}
                        placeholder="Enter the GoHighLevel Location ID"
                        required
                      />
                      <small>
                        The sub-account location where contacts will be stored.
                      </small>
                    </label>
                    <label htmlFor="ghl-api-key">
                      Private Integration API key
                      <input
                        id="ghl-api-key"
                        name="goHighLevelApiKey"
                        type="password"
                        autoComplete="new-password"
                        placeholder={
                          goHighLevelApiKeyConfigured
                            ? "Saved securely — enter a new key to replace"
                            : "Paste the API key supplied by the client"
                        }
                      />
                      <small>
                        Stored encrypted. The token requires the contacts.write
                        permission.
                      </small>
                    </label>
                    <div className="quote-ghl-security-note">
                      <span aria-hidden="true">✓</span>
                      <p>
                        Credentials are used only by the backend and are never
                        exposed to the storefront.
                      </p>
                    </div>
                    <div className="quote-ghl-form-actions">
                      <s-button
                        type="button"
                        disabled={webhookBusy}
                        onClick={() => setWebhookModalOpen(false)}
                      >
                        Cancel
                      </s-button>
                      <s-button
                        type="submit"
                        variant="primary"
                        loading={webhookBusy}
                        disabled={webhookBusy}
                      >
                        Save integration
                      </s-button>
                    </div>
                  </webhookFetcher.Form>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}

      {false && webhookModalOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="quote-modal-backdrop quote-webhook-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !webhookBusy) {
                  setWebhookModalOpen(false);
                  setShowWebhookForm(false);
                }
              }}
            >
              <section
                className="quote-modal-panel quote-webhook-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="quote-webhook-modal-title"
              >
                <header className="quote-modal-header quote-webhook-modal-header">
                  <div>
                    <span className="quote-webhook-kicker">QUOTE SETTINGS</span>
                    <h2 id="quote-webhook-modal-title">Webhook endpoints</h2>
                    <p>
                      Send each new quote request to one or more external
                      systems.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="quote-modal-close"
                    aria-label="Close webhook settings"
                    disabled={webhookBusy}
                    onClick={() => {
                      setWebhookModalOpen(false);
                      setShowWebhookForm(false);
                    }}
                  >
                    ×
                  </button>
                </header>
                <div className="quote-modal-body quote-webhook-modal-body">
                  <div className="quote-webhook-toolbar">
                    <div>
                      <strong>
                        {quoteWebhooks.length} endpoint
                        {quoteWebhooks.length === 1 ? "" : "s"}
                      </strong>
                      <span>HMAC-SHA256 signed · HTTPS endpoints only</span>
                    </div>
                    <s-button
                      variant="primary"
                      icon="plus"
                      onClick={() => setShowWebhookForm((current) => !current)}
                    >
                      {showWebhookForm ? "Cancel" : "Add endpoint"}
                    </s-button>
                  </div>

                  {showWebhookForm ? (
                    <webhookFetcher.Form
                      method="post"
                      className="quote-webhook-add-form"
                    >
                      <input type="hidden" name="intent" value="add-webhook" />
                      <div className="quote-webhook-form-heading">
                        <span aria-hidden="true">＋</span>
                        <div>
                          <h3>Add webhook endpoint</h3>
                          <p>
                            The signing secret is encrypted and cannot be viewed
                            again after saving.
                          </p>
                        </div>
                      </div>
                      <div className="quote-webhook-form-grid">
                        <label htmlFor="quote-webhook-name">
                          Endpoint name
                          <input
                            id="quote-webhook-name"
                            name="quoteWebhookName"
                            type="text"
                            maxLength={120}
                            placeholder="CRM integration"
                            required
                          />
                        </label>
                        <label htmlFor="quote-webhook-url">
                          Webhook URL
                          <input
                            id="quote-webhook-url"
                            name="quoteWebhookUrl"
                            type="url"
                            inputMode="url"
                            placeholder="https://example.com/webhooks/quotes"
                            required
                          />
                        </label>
                        <label htmlFor="quote-webhook-secret">
                          Signing secret
                          <input
                            id="quote-webhook-secret"
                            name="quoteWebhookSecret"
                            type="password"
                            autoComplete="new-password"
                            minLength={16}
                            placeholder="Minimum 16 characters"
                            required
                          />
                        </label>
                      </div>
                      <div className="quote-webhook-form-actions">
                        <s-button
                          type="button"
                          onClick={() => setShowWebhookForm(false)}
                        >
                          Cancel
                        </s-button>
                        <s-button
                          type="submit"
                          variant="primary"
                          loading={webhookBusy}
                          disabled={webhookBusy}
                        >
                          Add endpoint
                        </s-button>
                      </div>
                    </webhookFetcher.Form>
                  ) : null}

                  <div className="quote-webhook-list">
                    {quoteWebhooks.length ? (
                      quoteWebhooks.map((webhook, index) => (
                        <article
                          className="quote-webhook-item"
                          key={webhook.id}
                        >
                          <span className="quote-webhook-number">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className="quote-webhook-item-copy">
                            <div>
                              <h3>{webhook.name}</h3>
                              <span
                                className={`quote-webhook-state ${
                                  webhook.enabled ? "is-active" : ""
                                }`}
                              >
                                {webhook.enabled ? "Active" : "Paused"}
                              </span>
                            </div>
                            <code title={webhook.url}>{webhook.url}</code>
                          </div>
                          <div className="quote-webhook-item-actions">
                            <s-button
                              variant="secondary"
                              disabled={webhookBusy}
                              onClick={() => toggleWebhook(webhook)}
                            >
                              {webhook.enabled ? "Pause" : "Enable"}
                            </s-button>
                            <s-button
                              icon="delete"
                              tone="critical"
                              variant="tertiary"
                              accessibilityLabel={`Delete ${webhook.name}`}
                              disabled={webhookBusy}
                              onClick={() => setWebhookDeleteTarget(webhook)}
                            />
                          </div>
                        </article>
                      ))
                    ) : (
                      <div className="quote-webhook-empty">
                        <span aria-hidden="true">↗</span>
                        <h3>No webhook endpoints</h3>
                        <p>Add an endpoint to send new quote request data.</p>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {webhookDeleteTarget ? (
                <div className="quote-webhook-confirm-backdrop">
                  <section
                    className="quote-webhook-confirm"
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="delete-webhook-title"
                  >
                    <span className="quote-webhook-warning" aria-hidden="true">
                      !
                    </span>
                    <h3 id="delete-webhook-title">Delete webhook endpoint?</h3>
                    <p>
                      <strong>{webhookDeleteTarget.name}</strong> will stop
                      receiving new quote requests. This action cannot be
                      undone.
                    </p>
                    <div>
                      <s-button
                        disabled={webhookBusy}
                        onClick={() => setWebhookDeleteTarget(null)}
                      >
                        Cancel
                      </s-button>
                      <s-button
                        tone="critical"
                        variant="primary"
                        loading={webhookBusy}
                        disabled={webhookBusy}
                        onClick={deleteWebhook}
                      >
                        Delete endpoint
                      </s-button>
                    </div>
                  </section>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}

      {selected && typeof document !== "undefined"
        ? createPortal(
            <div
              className="quote-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setSelected(null);
              }}
            >
              <section
                className="quote-modal-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="quote-modal-title"
              >
                <header className="quote-modal-header">
                  <h2 id="quote-modal-title">
                    Quote from {selected.contactName}
                  </h2>
                  <button
                    type="button"
                    aria-label="Close quote details"
                    onClick={() => setSelected(null)}
                  >
                    ×
                  </button>
                </header>
                <div className="quote-modal-body">
                  <QuoteDetails quote={selected} />
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}

      {deleteTarget && typeof document !== "undefined"
        ? createPortal(
            <div
              className="quote-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !busy)
                  setDeleteTarget(null);
              }}
            >
              <section
                className="quote-modal-panel quote-modal-panel--confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-quote-title"
                aria-describedby="delete-quote-description"
              >
                <header className="quote-modal-header">
                  <h2 id="delete-quote-title">Delete quote request?</h2>
                  <button
                    type="button"
                    aria-label="Close delete confirmation"
                    disabled={busy}
                    onClick={() => setDeleteTarget(null)}
                  >
                    ×
                  </button>
                </header>
                <div className="quote-modal-body quote-confirm-body">
                  <s-banner
                    tone="critical"
                    heading="This action cannot be undone"
                  >
                    The quote request and all saved product requirements will be
                    permanently deleted.
                  </s-banner>
                  <p id="delete-quote-description">
                    Delete the quote request from {deleteTarget.contactName}?
                  </p>
                </div>
                <footer className="quote-modal-footer">
                  <s-button
                    disabled={busy}
                    onClick={() => setDeleteTarget(null)}
                  >
                    Cancel
                  </s-button>
                  <s-button
                    tone="critical"
                    variant="primary"
                    loading={busy}
                    disabled={busy}
                    onClick={deleteQuote}
                  >
                    Delete quote
                  </s-button>
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
