import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { decryptSecret } from "../lib/crypto.server";
import { parseSkuSheet } from "../lib/sheet-import.server";
import {
  deleteTrendsShopifyProducts,
  ensureTrendsMetafieldDefinitions,
  getPrimaryLocation,
  publishProductToOnlineStore,
  shopifyStatusFromTrends,
  syncTrendsProduct,
} from "../lib/shopify-sync.server";
import { TrendsClient } from "../lib/trends.server";
import { normalizeTrendsUrl } from "../lib/trends-url";

const BATCH_SIZE = 20;
const settingsFor = (shop) =>
  prisma.shopSettings.upsert({ where: { shop }, create: { shop }, update: {} });

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "";
  const sort = url.searchParams.get("sort") === "desc" ? "desc" : "asc";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = 25;
  const where = {
    shop: session.shop,
    sourceFile: { not: null },
    includedInCurrentSheet: true,
    ...(search
      ? {
          OR: [
            { productCode: { contains: search } },
            { title: { contains: search } },
            { metadataJson: { contains: search } },
          ],
        }
      : {}),
    ...(status ? { status } : {}),
  };
  const [settings, products, total, counts, runs, fetchAllRows] =
    await Promise.all([
      settingsFor(session.shop),
      prisma.syncProduct.findMany({
        where,
        orderBy: [{ rowNumber: sort }, { createdAt: sort }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.syncProduct.count({ where }),
      prisma.syncProduct.groupBy({
        by: ["status"],
        where: {
          shop: session.shop,
          sourceFile: { not: null },
          includedInCurrentSheet: true,
        },
        _count: { _all: true },
      }),
      prisma.syncRun.findMany({
        where: { shop: session.shop },
        orderBy: { startedAt: "desc" },
        take: 5,
      }),
      prisma.syncProduct.findMany({
        where: {
          shop: session.shop,
          sourceFile: { not: null },
          includedInCurrentSheet: true,
          status: { in: ["PENDING", "FAILED"] },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
  return {
    shop: session.shop,
    products,
    fetchAllIds: fetchAllRows.map((item) => item.id),
    total,
    counts: Object.fromEntries(
      counts.map((item) => [item.status, item._count._all]),
    ),
    runs,
    configured: Boolean(
      settings.encryptedTrendsToken || process.env.TRENDS_API_TOKEN,
    ),
    globalMarkupPercent: settings.globalMarkupPercent,
    additionalMarkupPercent: settings.additionalMarkupPercent,
    search,
    status,
    sort,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const settings = await settingsFor(session.shop);
  if (intent === "import") {
    const file = form.get("skuFile");
    if (file instanceof File && file.size) {
      if (file.size > 5000000)
        return { ok: false, message: "Sheet must be smaller than 5 MB" };
      try {
        const sheet = await parseSkuSheet(file);
        const validRows = [
          ...new Map(
            sheet.items
              .filter((item) => /^\d{6}$/.test(item.code))
              .map((item) => [item.code, item]),
          ).values(),
        ];
        if (!validRows.length)
          return {
            ok: false,
            message: 'No valid six-digit values found in the "code" column',
          };
        const existing = await prisma.syncProduct.findMany({
          where: {
            shop: session.shop,
            productCode: { in: validRows.map((item) => item.code) },
          },
          select: { productCode: true },
        });
        const existingCodes = new Set(existing.map((item) => item.productCode));
        const newRows = validRows.filter(
          (item) => !existingCodes.has(item.code),
        );
        await prisma.$transaction([
          prisma.syncProduct.updateMany({
            where: { shop: session.shop, sourceFile: { not: null } },
            data: { includedInCurrentSheet: false },
          }),
          prisma.syncProduct.updateMany({
            where: {
              shop: session.shop,
              productCode: { in: validRows.map((item) => item.code) },
            },
            data: { includedInCurrentSheet: true },
          }),
          ...validRows
            .filter((item) => existingCodes.has(item.code))
            .map((item) =>
              prisma.syncProduct.updateMany({
                where: { shop: session.shop, productCode: item.code },
                data: {
                  sourceFile: sheet.name,
                  rowNumber: item.rowNumber,
                },
              }),
            ),
          ...(newRows.length
            ? [
                prisma.syncProduct.createMany({
                  data: newRows.map((item) => ({
                    shop: session.shop,
                    productCode: item.code,
                    sourceFile: sheet.name,
                    includedInCurrentSheet: true,
                    rowNumber: item.rowNumber,
                    metadataJson: JSON.stringify(item.metadata),
                    tagsJson: JSON.stringify(item.tags),
                    status: "PENDING",
                  })),
                }),
              ]
            : []),
        ]);
        const skipped = validRows.length - newRows.length;
        return {
          ok: true,
          message: `${newRows.length} new SKU(s) imported${skipped ? ` · ${skipped} existing SKU(s) skipped` : ""}`,
        };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : "Could not read the sheet",
        };
      }
    }
    return {
      ok: false,
      message: "Upload an Excel, CSV or TXT sheet with a code column",
    };
  }
  if (intent === "fetch") {
    const id = String(form.get("productId") || "");
    const item = await prisma.syncProduct.findFirst({
      where: {
        id,
        shop: session.shop,
        sourceFile: { not: null },
        includedInCurrentSheet: true,
      },
    });
    if (!item) return { ok: false, message: "Sheet item not found" };
    const token =
      process.env.TRENDS_API_TOKEN ||
      (settings.encryptedTrendsToken
        ? decryptSecret(settings.encryptedTrendsToken)
        : "");
    if (!token)
      return {
        ok: false,
        message: "Configure the TRENDS API token in Settings",
      };
    await prisma.syncProduct.update({
      where: { id },
      data: { status: "FETCHING", lastError: null },
    });
    try {
      const product = await new TrendsClient(
        settings.trendsBaseUrl,
        token,
      ).getProduct(item.productCode);
      await prisma.syncProduct.update({
        where: { id },
        data: {
          title: product.name,
          imageUrl: normalizeTrendsUrl(product.images?.[0]?.link),
          resolvedProductCode: String(product.code),
          trendsDataJson: JSON.stringify(product),
          trendsFetchedAt: new Date(),
          status: "FETCHED",
          lastError: null,
        },
      });
      return { ok: true, message: `${item.productCode} fetched from TRENDS` };
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : "TRENDS fetch failed"
      ).slice(0, 1000);
      await prisma.syncProduct.update({
        where: { id },
        data: { status: "FAILED", lastError: message },
      });
      return { ok: false, message };
    }
  }
  if (intent === "markup") {
    const mainRaw = String(form.get("individualMarkup") || "").trim();
    const additionalRaw = String(form.get("additionalMarkup") || "").trim();
    const value = mainRaw === "" ? null : Number(mainRaw);
    const additionalValue = additionalRaw === "" ? null : Number(additionalRaw);
    if (
      [value, additionalValue].some(
        (markup) =>
          markup !== null &&
          (!Number.isFinite(markup) || markup < 0 || markup > 1000),
      )
    )
      return { ok: false, message: "Markup must be between 0% and 1000%" };
    await prisma.syncProduct.updateMany({
      where: { id: String(form.get("id")), shop: session.shop },
      data: {
        individualMarkup: value,
        additionalMarkup: additionalValue,
      },
    });
    return {
      ok: true,
      message:
        value === null && additionalValue === null
          ? "Global markups will be used"
          : "Product markups saved",
    };
  }
  if (intent === "remove" || intent === "remove_shopify") {
    const ids = form.getAll("productId").map(String);
    const items = await prisma.syncProduct.findMany({
      where: { shop: session.shop, id: { in: ids } },
      select: {
        id: true,
        shopifyProductId: true,
        shopifyAdditionalProductId: true,
        resolvedProductCode: true,
        trendsDataJson: true,
      },
    });
    if (!items.length) return { ok: false, message: "No items found" };
    let deletedFromShopify = 0;
    try {
      deletedFromShopify = await deleteTrendsShopifyProducts({ admin, items });
    } catch (error) {
      return {
        ok: false,
        message: `Shopify deletion failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
    if (intent === "remove") {
      await prisma.syncProduct.deleteMany({
        where: { shop: session.shop, id: { in: ids } },
      });
    } else {
      await prisma.$transaction(
        items.map((item) =>
          prisma.syncProduct.update({
            where: { id: item.id },
            data: {
              shopifyProductId: null,
              shopifyAdditionalProductId: null,
              lastSyncedAt: null,
              status: item.trendsDataJson ? "FETCHED" : "PENDING",
              lastError: null,
            },
          }),
        ),
      );
    }
    return {
      ok: true,
      message:
        intent === "remove"
          ? `${items.length} item(s) removed from the list${deletedFromShopify ? ` · ${deletedFromShopify} Shopify product(s) deleted` : ""}`
          : `${deletedFromShopify} Shopify product(s) deleted · ${items.length} list item(s) retained`,
    };
  }
  if (intent === "publish_online_store") {
    const ids = form.getAll("productId").map(String);
    const items = await prisma.syncProduct.findMany({
      where: {
        shop: session.shop,
        status: "SYNCED",
        shopifyProductId: { not: null },
        ...(ids.length ? { id: { in: ids } } : {}),
      },
    });
    const activeItems = [
      ...new Map(
        items
          .filter((item) => {
            try {
              return (
                shopifyStatusFromTrends(
                  JSON.parse(item.trendsDataJson || "{}"),
                ) === "ACTIVE"
              );
            } catch {
              return true;
            }
          })
          .map((item) => [item.shopifyProductId, item]),
      ).values(),
    ];
    let published = 0;
    let failed = 0;
    const queue = [...activeItems];
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          try {
            await publishProductToOnlineStore(admin, item.shopifyProductId);
            await prisma.syncProduct.updateMany({
              where: {
                shop: session.shop,
                shopifyProductId: item.shopifyProductId,
              },
              data: { lastError: null },
            });
            published++;
          } catch (error) {
            failed++;
            await prisma.syncProduct.updateMany({
              where: {
                shop: session.shop,
                shopifyProductId: item.shopifyProductId,
              },
              data: {
                lastError: `Online Store publishing: ${(error instanceof Error
                  ? error.message
                  : "Publishing failed"
                ).slice(0, 900)}`,
              },
            });
          }
        }
      }),
    );
    return {
      ok: failed === 0,
      message: `${published} product(s) published to Online Store${failed ? ` · ${failed} failed` : ""}${items.length - activeItems.length ? ` · ${items.length - activeItems.length} draft product(s) skipped` : ""}`,
    };
  }
  if (intent === "sync") {
    const ids = form.getAll("productId").map(String);
    const where = ids.length
      ? { shop: session.shop, id: { in: ids }, sourceFile: { not: null } }
      : {
          shop: session.shop,
          status: { in: ["PENDING", "FAILED"] },
          sourceFile: { not: null },
          includedInCurrentSheet: true,
        };
    const queued = (
      await prisma.syncProduct.findMany({
        where,
        orderBy: { createdAt: "asc" },
        ...(ids.length ? {} : { take: BATCH_SIZE }),
      })
    ).filter((item) => item.trendsDataJson);
    if (!queued.length)
      return {
        ok: false,
        message: "Fetch the selected SKUs from TRENDS before syncing",
      };
    let metafieldPreparationWarning = "";
    try {
      await ensureTrendsMetafieldDefinitions(admin);
    } catch (error) {
      metafieldPreparationWarning =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : error?.message ||
              error?.statusText ||
              "Shopify API request failed";
      console.warn(
        `TRENDS metafield definition preparation was skipped: ${metafieldPreparationWarning}`,
      );
    }
    const run = await prisma.syncRun.create({
      data: { shop: session.shop, requested: queued.length },
    });
    const locationId = await getPrimaryLocation(
      admin,
      settings.inventoryLocationId,
    );
    let succeeded = 0;
    let failed = 0;
    const groups = new Map();
    for (const item of queued) {
      await prisma.syncProduct.update({
        where: { id: item.id },
        data: { status: "SYNCING", lastError: null },
      });
      try {
        const product = JSON.parse(item.trendsDataJson);
        const key = String(product.code);
        const group = groups.get(key) || {
          product,
          items: [],
          tags: new Set(),
          markup: null,
          additionalMarkup: null,
        };
        group.items.push(item);
        JSON.parse(item.tagsJson || "[]").forEach((tag) => group.tags.add(tag));
        if (item.individualMarkup !== null)
          group.markup = item.individualMarkup;
        if (item.additionalMarkup !== null)
          group.additionalMarkup = item.additionalMarkup;
        groups.set(key, group);
      } catch (error) {
        await prisma.syncProduct.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            lastError: (error instanceof Error
              ? error.message
              : "Unknown error"
            ).slice(0, 1000),
          },
        });
        failed++;
      }
    }
    for (const group of groups.values()) {
      try {
        const synced = await syncTrendsProduct({
          admin,
          product: group.product,
          shopifyProductId:
            group.items.find((item) => item.shopifyProductId)
              ?.shopifyProductId || null,
          shopifyAdditionalProductId:
            group.items.find((item) => item.shopifyAdditionalProductId)
              ?.shopifyAdditionalProductId || null,
          markupPercent: group.markup ?? settings.globalMarkupPercent,
          additionalMarkupPercent:
            group.additionalMarkup ?? settings.additionalMarkupPercent,
          locationId,
          extraTags: [...group.tags],
        });
        await prisma.syncProduct.updateMany({
          where: { id: { in: group.items.map((item) => item.id) } },
          data: {
            title: group.product.name,
            resolvedProductCode: String(group.product.code),
            imageUrl: normalizeTrendsUrl(group.product.images?.[0]?.link),
            status: "SYNCED",
            shopifyProductId: synced.id,
            shopifyAdditionalProductId:
              synced.additionalProducts?.[0]?.id || null,
            lastSyncedAt: new Date(),
            lastError: synced.publicationWarning?.slice(0, 1000) || null,
          },
        });
        succeeded += group.items.length;
      } catch (error) {
        const message = (
          error instanceof Error ? error.message : "Unknown error"
        ).slice(0, 1000);
        await prisma.syncProduct.updateMany({
          where: { id: { in: group.items.map((item) => item.id) } },
          data: { status: "FAILED", lastError: message },
        });
        failed += group.items.length;
      }
    }
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        succeeded,
        failed,
        status: failed ? (succeeded ? "PARTIAL" : "FAILED") : "COMPLETED",
        finishedAt: new Date(),
      },
    });
    return {
      ok: failed === 0,
      message: `${succeeded} synced, ${failed} failed${metafieldPreparationWarning ? " · metafield definition setup was skipped, but product metafields were still written" : ""}`,
    };
  }
  return { ok: false, message: "Unknown action" };
};

export default function ProductSync() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const importer = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [markupItem, setMarkupItem] = useState(null);
  const [priceItem, setPriceItem] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [activeIntent, setActiveIntent] = useState("");
  const [file, setFile] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [draggingFile, setDraggingFile] = useState(false);
  const fileInputRef = useRef(null);
  const [progress, setProgress] = useState(null);
  const busy = fetcher.state !== "idle" || Boolean(progress);
  const importing = importer.state !== "idle";
  const selectUploadFile = (nextFile) => {
    setUploadError("");
    if (!nextFile) {
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const extension = nextFile.name.toLowerCase().split(".").pop();
    if (!["xlsx", "csv", "txt"].includes(extension)) {
      setFile(null);
      setUploadError("Choose an Excel (.xlsx), CSV or TXT file.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (nextFile.size > 5_000_000) {
      setFile(null);
      setUploadError("The selected file is larger than the 5 MB limit.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFile(nextFile);
  };
  const closeUpload = () => {
    if (importing) return;
    setUploadOpen(false);
    setDraggingFile(false);
    setUploadError("");
    setFile(null);
  };
  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
      if (fetcher.data.ok && activeIntent === "markup") setMarkupItem(null);
      if (fetcher.state === "idle") setActiveIntent("");
    }
  }, [fetcher.data, fetcher.state, shopify, activeIntent]);
  useEffect(() => {
    if (importer.data?.message) {
      shopify.toast.show(importer.data.message, { isError: !importer.data.ok });
      if (importer.data.ok) {
        setUploadOpen(false);
        setFile(null);
      }
    }
  }, [importer.data, shopify]);
  const submit = (intent, ids = selected) => {
    setActiveIntent(intent);
    const form = new FormData();
    form.set("intent", intent);
    ids.forEach((id) => form.append("productId", id));
    fetcher.submit(form, { method: "POST" });
  };
  const fetchProducts = async (ids) => {
    if (!ids.length) return;
    let failed = 0;
    setProgress({
      label: "Fetching product details from TRENDS",
      current: 0,
      total: ids.length,
      failed: 0,
    });
    for (let i = 0; i < ids.length; i++) {
      const form = new FormData();
      form.set("productId", ids[i]);
      try {
        const response = await fetch(`/app/fetch${window.location.search}`, {
          method: "POST",
          body: form,
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          failed++;
          shopify.toast.show(result.message || "TRENDS fetch failed", {
            isError: true,
          });
        }
      } catch (error) {
        failed++;
        shopify.toast.show(
          error instanceof Error ? error.message : "TRENDS fetch failed",
          { isError: true },
        );
      }
      setProgress({
        label: "Fetching product details from TRENDS",
        current: i + 1,
        total: ids.length,
        failed,
      });
      if ((i + 1) % 10 === 0 || i + 1 === ids.length) {
        await revalidator.revalidate();
      }
    }
    if (!failed) shopify.toast.show(`${ids.length} product detail(s) fetched`);
    setTimeout(() => setProgress(null), 900);
  };
  const allChecked =
    data.products.length > 0 &&
    data.products.every((p) => selected.includes(p.id));
  const fetched = (data.counts.FETCHED || 0) + (data.counts.SYNCED || 0);
  return (
    <s-page heading="TRENDS product sync" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => setUploadOpen(true)}
      >
        Upload SKU sheet
      </s-button>
      <div className="trends-shell">
        {!data.configured && (
          <s-banner tone="critical" heading="TRENDS connection required">
            Open Settings and save the API token before fetching products.
          </s-banner>
        )}
        <div className="trends-metrics">
          <QueueMetric
            label="Total sheet products"
            value={Object.values(data.counts).reduce((a, b) => a + b, 0)}
          />
          <QueueMetric label="Details fetched" value={fetched} tone="success" />
          <QueueMetric
            label="Synced to Shopify"
            value={data.counts.SYNCED || 0}
            tone="success"
          />
          <QueueMetric
            label="Needs attention"
            value={data.counts.FAILED || 0}
            tone="critical"
          />
        </div>
        {progress && <ProgressPanel progress={progress} />}
        <div className="trends-card">
          <div className="trends-card__header">
            <div>
              <h3>Sheet products</h3>
              <p>
                Import SKUs, fetch their supplier details, then sync approved
                products to Shopify.
              </p>
            </div>
            <div className="trends-actions">
              <s-button
                disabled={!data.counts.SYNCED || busy}
                onClick={() =>
                  setConfirm({
                    type: "publish_online_store",
                    ids: [],
                    title: "Publish all synced products to Online Store?",
                    body: "All active TRENDS products already synced to Shopify will be made available on the Online Store sales channel. Draft products will remain unpublished.",
                  })
                }
              >
                Publish all to Online Store
              </s-button>
              <s-button
                disabled={!data.fetchAllIds.length || busy || !data.configured}
                onClick={() => fetchProducts(data.fetchAllIds)}
              >
                Fetch all ({data.fetchAllIds.length})
              </s-button>
              <s-button
                variant="primary"
                disabled={!selected.length || busy || !data.configured}
                onClick={() => fetchProducts(selected)}
              >
                Fetch from TRENDS ({selected.length})
              </s-button>
            </div>
          </div>
          <div className="trends-card__body">
            <Form method="get">
              <div className="trends-toolbar trends-toolbar--sorting">
                <label className="trends-field">
                  Search products
                  <input
                    className="trends-input"
                    name="q"
                    defaultValue={data.search}
                    placeholder="Search title, SKU or sheet data"
                  />
                </label>
                <label className="trends-field">
                  Status
                  <select
                    className="trends-input"
                    name="status"
                    defaultValue={data.status}
                  >
                    <option value="">All statuses</option>
                    <option value="PENDING">Pending fetch</option>
                    <option value="FETCHED">Fetched</option>
                    <option value="SYNCED">Synced</option>
                    <option value="FAILED">Failed</option>
                  </select>
                </label>
                <label className="trends-field">
                  Display order
                  <select
                    className="trends-input"
                    name="sort"
                    defaultValue={data.sort}
                  >
                    <option value="asc">First to last</option>
                    <option value="desc">Last to first</option>
                  </select>
                </label>
                <button className="trends-filter-button" type="submit">
                  Apply filters
                </button>
              </div>
            </Form>
          </div>
          {selected.length > 0 && (
            <div className="trends-bulkbar">
              <strong>{selected.length} selected</strong>
              <s-button onClick={() => fetchProducts(selected)} disabled={busy}>
                Fetch details
              </s-button>
              <s-button
                onClick={() =>
                  setConfirm({
                    type: "publish_online_store",
                    ids: selected,
                    title: `Publish ${selected.length} selected product(s)?`,
                    body: "Active products will be published to the Online Store sales channel. Draft products will be skipped.",
                  })
                }
                disabled={busy}
              >
                Publish Online Store
              </s-button>
              <s-button
                onClick={() =>
                  setConfirm({
                    type: "sync",
                    ids: selected,
                    title: `Sync ${selected.length} selected product(s) to Shopify?`,
                    body: "Fetched product data, variants, inventory, images and pricing will be created or updated in Shopify.",
                  })
                }
                disabled={busy}
              >
                Sync to Shopify
              </s-button>
              <s-button
                tone="critical"
                onClick={() =>
                  setConfirm({
                    type: "remove",
                    ids: selected,
                    title: `Delete ${selected.length} selected item(s)?`,
                    body: "Choose whether to delete the linked main and additional-cost products from Shopify only, or delete them from Shopify and remove the selected rows from this list as well.",
                  })
                }
                disabled={busy}
              >
                Delete
              </s-button>
            </div>
          )}
          {data.products.length ? (
            <div className="trends-table-wrap">
              <table className="trends-table trends-products-table">
                <colgroup>
                  <col className="trends-col-select" />
                  <col className="trends-col-count" />
                  <col className="trends-col-product" />
                  <col className="trends-col-sku" />
                  <col className="trends-col-source" />
                  <col className="trends-col-markup" />
                  <col className="trends-col-status" />
                  <col className="trends-col-updated" />
                  <col className="trends-col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all products on this page"
                        checked={allChecked}
                        onChange={() =>
                          setSelected(
                            allChecked
                              ? selected.filter(
                                  (id) =>
                                    !data.products.some((p) => p.id === id),
                                )
                              : [
                                  ...new Set([
                                    ...selected,
                                    ...data.products.map((p) => p.id),
                                  ]),
                                ],
                          )
                        }
                      />
                    </th>
                    <th>#</th>
                    <th>Product</th>
                    <th>SKU / code</th>
                    <th>Source</th>
                    <th>Markup</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((product, index) => (
                    <tr key={product.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.includes(product.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...new Set([...selected, product.id])]
                                : selected.filter((id) => id !== product.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <span className="trends-row-count">
                          {data.sort === "asc"
                            ? (data.page - 1) * data.pageSize + index + 1
                            : data.total -
                              ((data.page - 1) * data.pageSize + index)}
                        </span>
                      </td>
                      <td>
                        <div className="trends-product">
                          <span className="trends-thumb">
                            {product.imageUrl ? (
                              <img src={product.imageUrl} alt="" />
                            ) : (
                              "—"
                            )}
                          </span>
                          <span className="trends-product__name">
                            {product.title || "Details not fetched"}
                            <small className="trends-product__sub">
                              {product.resolvedProductCode
                                ? `Parent ${product.resolvedProductCode}`
                                : "Fetch from TRENDS to load title and image"}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="trends-code">
                          {product.productCode}
                        </span>
                      </td>
                      <td>
                        <span>{product.sourceFile}</span>
                        <small className="trends-product__sub">
                          Row {product.rowNumber || "—"}
                        </small>
                      </td>
                      <td>
                        <button
                          className="trends-markup-button"
                          onClick={() => setMarkupItem(product)}
                        >
                          M{" "}
                          {product.individualMarkup ?? data.globalMarkupPercent}
                          %
                          <small>
                            A{" "}
                            {product.additionalMarkup ??
                              data.additionalMarkupPercent}
                            %
                          </small>
                        </button>
                      </td>
                      <td>
                        <StatusBadge status={product.status} />
                        {product.lastError && (
                          <small className="trends-error">
                            {product.lastError}
                          </small>
                        )}
                      </td>
                      <td>
                        {product.trendsFetchedAt
                          ? new Date(product.trendsFetchedAt).toLocaleString()
                          : product.lastSyncedAt
                            ? new Date(product.lastSyncedAt).toLocaleString()
                            : "—"}
                      </td>
                      <td>
                        <div className="trends-row-actions">
                          <span title="View product details">
                            <s-button
                              variant="tertiary"
                              icon="view"
                              accessibilityLabel="View product details"
                              disabled={!product.trendsDataJson}
                              onClick={() => setDetails(product)}
                            />
                          </span>
                          <span title="Price calculation">
                            <s-button
                              variant="tertiary"
                              icon="calculator"
                              accessibilityLabel="View price calculation"
                              disabled={!product.trendsDataJson}
                              onClick={() => setPriceItem(product)}
                            />
                          </span>
                          <span title="Sync or update Shopify product">
                            <s-button
                              variant="tertiary"
                              icon="refresh"
                              accessibilityLabel="Sync or update product in Shopify"
                              disabled={!product.trendsDataJson}
                              onClick={() =>
                                setConfirm({
                                  type: "sync",
                                  ids: [product.id],
                                  title: `Sync ${product.productCode} to Shopify?`,
                                  body: "This product and all fetched variants will be created or updated in Shopify.",
                                })
                              }
                            />
                          </span>
                          <span title="Delete product">
                            <s-button
                              variant="tertiary"
                              icon="delete"
                              tone="critical"
                              accessibilityLabel="Delete product"
                              onClick={() =>
                                setConfirm({
                                  type: "remove",
                                  ids: [product.id],
                                  title: `Delete ${product.productCode}?`,
                                  body: "Choose whether to delete the linked main and additional-cost products from Shopify only, or delete them from Shopify and remove this row from the list as well.",
                                })
                              }
                            />
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="trends-empty">
              <div className="trends-empty__icon">▤</div>
              <h3>No sheet products yet</h3>
              <p>Upload a spreadsheet to create your SKU list.</p>
              <div style={{ marginTop: 14 }}>
                <s-button variant="primary" onClick={() => setUploadOpen(true)}>
                  Upload SKU sheet
                </s-button>
              </div>
            </div>
          )}
          <div className="trends-footer">
            <span>{data.total.toLocaleString()} results</span>
            <div className="trends-pagination">
              <s-button
                disabled={data.page <= 1}
                href={queuePage(data, data.page - 1)}
              >
                Previous
              </s-button>
              <span>
                Page {data.page} of {data.pages}
              </span>
              <s-button
                disabled={data.page >= data.pages}
                href={queuePage(data, data.page + 1)}
              >
                Next
              </s-button>
            </div>
          </div>
        </div>
        {uploadOpen && (
          <Modal title="Upload SKU sheet" onClose={closeUpload}>
            <importer.Form method="post" encType="multipart/form-data">
              <input type="hidden" name="intent" value="import" />
              <div className="trends-upload-intro">
                <strong>Import your product codes</strong>
                <span>
                  We will validate the sheet and add only unique six-digit codes
                  to the current product list.
                </span>
              </div>
              <label
                className={`trends-upload${draggingFile ? " trends-upload--dragging" : ""}${uploadError ? " trends-upload--error" : ""}${file ? " trends-upload--ready" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (!importing) setDraggingFile(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setDraggingFile(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDraggingFile(false);
                  if (importing) return;
                  const droppedFile = event.dataTransfer.files?.[0] || null;
                  if (droppedFile && fileInputRef.current) {
                    const transfer = new DataTransfer();
                    transfer.items.add(droppedFile);
                    fileInputRef.current.files = transfer.files;
                  }
                  selectUploadFile(droppedFile);
                }}
              >
                <input
                  ref={fileInputRef}
                  className="trends-upload__input"
                  name="skuFile"
                  type="file"
                  accept=".xlsx,.csv,.txt"
                  required
                  disabled={importing}
                  onChange={(event) =>
                    selectUploadFile(event.target.files?.[0] || null)
                  }
                />
                {file ? (
                  <div className="trends-upload__selected">
                    <span className="trends-upload__file-icon">
                      {file.name.split(".").pop()?.toUpperCase()}
                    </span>
                    <div>
                      <strong>{file.name}</strong>
                      <span>
                        {(file.size / 1024).toFixed(1)} KB · Ready to import
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={importing}
                      onClick={(event) => {
                        event.preventDefault();
                        selectUploadFile(null);
                      }}
                      aria-label="Remove selected file"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="trends-upload__empty">
                    <span className="trends-upload__icon" aria-hidden="true">
                      ↑
                    </span>
                    <strong>
                      {draggingFile
                        ? "Drop your sheet here"
                        : "Drag and drop your sheet"}
                    </strong>
                    <span>
                      or <b>browse files</b> from your computer
                    </span>
                    <small>XLSX, CSV or TXT · Maximum 5 MB</small>
                  </div>
                )}
              </label>
              {uploadError && (
                <div className="trends-upload-message trends-upload-message--error">
                  <span>!</span>
                  {uploadError}
                </div>
              )}
              <div className="trends-upload-requirements">
                <div>
                  <span>1</span>
                  <p>
                    <strong>Required column</strong>The sheet must contain a
                    column named <code>code</code>.
                  </p>
                </div>
                <div>
                  <span>2</span>
                  <p>
                    <strong>Additional columns</strong>Other values are
                    preserved and added as Shopify tags.
                  </p>
                </div>
                <div>
                  <span>3</span>
                  <p>
                    <strong>Duplicates</strong>Existing and repeated SKUs are
                    skipped automatically.
                  </p>
                </div>
              </div>
              <div className="trends-modal-actions">
                <s-button onClick={closeUpload} disabled={importing}>
                  Cancel
                </s-button>
                <s-button
                  type="submit"
                  variant="primary"
                  loading={importing}
                  disabled={!file || importing}
                >
                  Import sheet
                </s-button>
              </div>
            </importer.Form>
          </Modal>
        )}
        {details && (
          <DetailsModal
            item={details}
            shop={data.shop}
            onClose={() => setDetails(null)}
          />
        )}
        {priceItem && (
          <PriceCalculationModal
            item={priceItem}
            mainMarkup={priceItem.individualMarkup ?? data.globalMarkupPercent}
            additionalMarkup={
              priceItem.additionalMarkup ?? data.additionalMarkupPercent
            }
            onClose={() => setPriceItem(null)}
          />
        )}
        {markupItem && (
          <Modal
            title={`Markup for ${markupItem.productCode}`}
            onClose={() => !busy && setMarkupItem(null)}
          >
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="markup" />
              <input type="hidden" name="id" value={markupItem.id} />
              <div className="trends-form-grid trends-form-grid--two">
                <label className="trends-field">
                  Main product markup (%)
                  <input
                    className="trends-input"
                    name="individualMarkup"
                    type="number"
                    min="0"
                    max="1000"
                    step="0.01"
                    defaultValue={markupItem.individualMarkup ?? ""}
                    placeholder={`${data.globalMarkupPercent}% global`}
                  />
                  <small>
                    Leave blank to use {data.globalMarkupPercent}% global main
                    markup.
                  </small>
                </label>
                <label className="trends-field">
                  Additional product markup (%)
                  <input
                    className="trends-input"
                    name="additionalMarkup"
                    type="number"
                    min="0"
                    max="1000"
                    step="0.01"
                    defaultValue={markupItem.additionalMarkup ?? ""}
                    placeholder={`${data.additionalMarkupPercent}% global`}
                  />
                  <small>
                    Leave blank to use {data.additionalMarkupPercent}% global
                    additional markup.
                  </small>
                </label>
              </div>
              <div className="trends-modal-actions">
                <s-button onClick={() => setMarkupItem(null)} disabled={busy}>
                  Cancel
                </s-button>
                <s-button
                  type="submit"
                  variant="primary"
                  loading={
                    activeIntent === "markup" && fetcher.state !== "idle"
                  }
                  onClick={() => setActiveIntent("markup")}
                >
                  Save markup
                </s-button>
              </div>
            </fetcher.Form>
          </Modal>
        )}
        {confirm && (
          <ConfirmModal
            value={confirm}
            busy={fetcher.state !== "idle"}
            onCancel={() => !busy && setConfirm(null)}
            onConfirm={(intent) => {
              submit(
                typeof intent === "string" ? intent : confirm.type,
                confirm.ids,
              );
              setConfirm(null);
            }}
          />
        )}
        {fetcher.state !== "idle" && activeIntent === "sync" && (
          <div className="trends-action-loader">
            <span className="trends-spinner" />
            <div>
              <strong>Syncing products to Shopify</strong>
              <small>Creating products, variants, images and inventory…</small>
            </div>
          </div>
        )}
      </div>
    </s-page>
  );
}
function QueueMetric({ label, value, tone = "" }) {
  return (
    <div className="trends-metric">
      <div className="trends-metric__top">
        <span>{label}</span>
        <span
          className={`trends-metric__dot${tone ? ` trends-metric__dot--${tone}` : ""}`}
        />
      </div>
      <strong>{Number(value).toLocaleString()}</strong>
    </div>
  );
}
function StatusBadge({ status }) {
  const tone =
    status === "SYNCED" || status === "FETCHED"
      ? "success"
      : status === "FAILED"
        ? "critical"
        : status === "FETCHING"
          ? "info"
          : "warning";
  return (
    <s-badge tone={tone}>{status.toLowerCase().replace("_", " ")}</s-badge>
  );
}
function ProgressPanel({ progress }) {
  const percent = Math.round((progress.current / progress.total) * 100);
  return (
    <div className="trends-import-progress">
      <div className="trends-import-progress__head">
        <div className="trends-import-progress__title">
          {percent < 100 && <span className="trends-spinner" />}
          {progress.label}
        </div>
        <s-badge
          tone={
            percent === 100 ? (progress.failed ? "warning" : "success") : "info"
          }
        >
          {progress.current} / {progress.total}
        </s-badge>
      </div>
      <div className="trends-progress-track">
        <span
          className="trends-progress-bar"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="trends-progress-meta">
        <span>
          {percent === 100
            ? `Fetch completed${progress.failed ? ` · ${progress.failed} failed` : ""}`
            : "Loading titles, images, variants and pricing"}
        </span>
        <span>{percent}%</span>
      </div>
    </div>
  );
}
function Modal({ title, onClose, children, compact = false, wide = false }) {
  return (
    <div
      className="trends-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`trends-modal${compact ? " trends-modal--compact" : ""}${wide ? " trends-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="trends-modal-header">
          <div>
            <p className="trends-eyebrow">Product operations</p>
            <h2>{title}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="trends-modal-body">{children}</div>
      </div>
    </div>
  );
}
function ConfirmModal({ value, busy, onCancel, onConfirm }) {
  return (
    <Modal title={value.title} onClose={onCancel} compact>
      <p className="trends-confirm-copy">{value.body}</p>
      <div className="trends-modal-actions">
        <s-button onClick={onCancel} disabled={busy}>
          Cancel
        </s-button>
        {value.type === "remove" ? (
          <>
            <s-button
              tone="critical"
              loading={busy}
              onClick={() => onConfirm("remove_shopify")}
            >
              Delete from Shopify only
            </s-button>
            <s-button
              variant="primary"
              tone="critical"
              loading={busy}
              onClick={() => onConfirm("remove")}
            >
              Delete from Shopify + list
            </s-button>
          </>
        ) : (
          <s-button
            variant="primary"
            loading={busy}
            onClick={() => onConfirm(value.type)}
          >
            {value.type === "publish_online_store"
              ? "Confirm publish"
              : "Confirm sync"}
          </s-button>
        )}
      </div>
    </Modal>
  );
}

function PriceCalculationModal({
  item,
  mainMarkup,
  additionalMarkup,
  onClose,
}) {
  const product = safeJson(item.trendsDataJson);
  const prices = product.pricing?.[0]?.prices || [];
  const costs = uniqueAdditionalCosts(product);
  const calculate = (price, markup) =>
    Number(price || 0) * (1 + Number(markup || 0) / 100);
  return (
    <Modal title={`Price calculation · ${item.productCode}`} onClose={onClose}>
      <div className="trends-price-summary">
        <Detail label="Main product markup" value={`${mainMarkup}%`} />
        <Detail
          label="Additional product markup"
          value={`${additionalMarkup}%`}
        />
        <Detail label="Currency" value="NZD" />
      </div>
      <DetailSection title="Main product pricing">
        <p className="trends-detail-note">
          Shopify price = TRENDS supplier price × (1 + main markup ÷ 100)
        </p>
        <SimpleTable
          headers={[
            "Quantity",
            "Supplier price",
            `Markup (${mainMarkup}%)`,
            "Calculated price",
          ]}
          rows={prices.map((price) => [
            price.quantity,
            money(price.price),
            money(
              calculate(price.price, mainMarkup) - Number(price.price || 0),
            ),
            money(calculate(price.price, mainMarkup)),
          ])}
        />
      </DetailSection>
      <DetailSection title="Additional product variants">
        <p className="trends-detail-note">
          Each branding method becomes one variant. Its unit and setup prices
          use the separate additional-product markup.
        </p>
        <SimpleTable
          headers={[
            "Branding variant",
            "Supplier unit",
            "Calculated unit",
            "Supplier setup",
            "Calculated setup",
          ]}
          rows={costs.map((cost) => [
            cost.branding_option || cost.description || "Branding",
            money(cost.unit_price),
            money(calculate(cost.unit_price, additionalMarkup)),
            money(cost.setup_price ?? cost.setup),
            money(calculate(cost.setup_price ?? cost.setup, additionalMarkup)),
          ])}
        />
      </DetailSection>
    </Modal>
  );
}

function ProductRelationshipSection({ item, product, shop }) {
  const costs = uniqueAdditionalCosts(product);
  const isSynced = item.status === "SYNCED" && item.shopifyProductId;
  return (
    <DetailSection title="Shopify product structure">
      <div className="trends-detail-note">
        <strong>{isSynced ? "Connected to Shopify" : "Not synced yet"}</strong>
        <span>
          {isSynced
            ? " The main merchandise product and its branding-service product are linked through one product-reference metafield."
            : " Sync this product to create its Shopify products and metafield relationship."}
        </span>
      </div>
      <div className="trends-relation-flow">
        <div className="trends-relation-node">
          <span>Main Shopify product</span>
          <strong>{product.name || item.title || item.productCode}</strong>
          {item.shopifyProductId ? (
            <a
              className="trends-admin-product-link"
              href={shopifyAdminProductUrl(shop, item.shopifyProductId)}
              target="_blank"
              rel="noreferrer"
            >
              Open main product in Shopify Admin ↗
            </a>
          ) : (
            <em className="trends-relation-status">Not synced</em>
          )}
        </div>
        <div className="trends-relation-arrow">
          <span>product_reference metafield</span>
          <strong>trends.additional_product</strong>
          <b>→</b>
        </div>
        <div className="trends-relation-node trends-relation-node--additional">
          <span>Linked additional product</span>
          <strong>{product.name || item.productCode} — Branding options</strong>
          {item.shopifyAdditionalProductId ? (
            <a
              className="trends-admin-product-link"
              href={shopifyAdminProductUrl(
                shop,
                item.shopifyAdditionalProductId,
              )}
              target="_blank"
              rel="noreferrer"
            >
              Open additional product in Shopify Admin ↗
            </a>
          ) : (
            <em className="trends-relation-status">No additional product</em>
          )}
        </div>
      </div>
      {costs.length ? (
        <DetailSection title={`Branding variants (${costs.length})`}>
          <SimpleTable
            headers={["Method", "Unit-charge variant", "Setup-charge variant"]}
            rows={costs.map((cost) => [
              cost.branding_option || cost.description || "Branding",
              (cost.price_per_unit_charge_codes || [])
                .map((code) => code.price_per_unit_charge_code)
                .filter(Boolean)
                .join(", ") || "—",
              Number(cost.setup_price ?? cost.setup ?? 0) > 0
                ? `TRENDS-${product.code}-SETUP-${cost.id}`
                : "Not required",
            ])}
          />
        </DetailSection>
      ) : (
        <div className="trends-dashboard-empty">
          <p>This TRENDS product has no additional branding options.</p>
        </div>
      )}
      <details className="trends-raw-details">
        <summary>Metafield assignment details</summary>
        <pre>
          {JSON.stringify(
            {
              metafield: {
                namespace: "trends",
                keys: ["product_configuration", "additional_product"],
                configuration_type: "json",
                relationship_type: "product_reference",
              },
              additional_product_handle: `trends-${product.code || item.resolvedProductCode}-branding-options`,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </DetailSection>
  );
}

const safeJson = (value) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
};
const uniqueAdditionalCosts = (product) => [
  ...new Map(
    (product.pricing?.flatMap((tier) => tier.additional_costs || []) || []).map(
      (cost, index) => [
        String(cost.id ?? `${cost.description}-${index}`),
        cost,
      ],
    ),
  ).values(),
];
const money = (value) =>
  `$${Number(value || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shopifyAdminProductUrl = (shop, productId) =>
  `https://${shop}/admin/products/${encodeURIComponent(String(productId).split("/").pop())}`;

function DetailsModal({ item, shop, onClose }) {
  let p = {};
  try {
    p = JSON.parse(item.trendsDataJson || "{}");
  } catch {
    p = {};
  }
  const pricing = p.pricing || [];
  const costs = [
    ...new Map(
      pricing
        .flatMap((tier) => tier.additional_costs || [])
        .map((cost, index) => [
          String(cost.id ?? `${cost.description}-${index}`),
          cost,
        ]),
    ).values(),
  ];
  return (
    <Modal title={p.name || item.productCode} onClose={onClose} wide>
      <div className="trends-details-content">
        <div className="trends-detail-hero">
          {item.imageUrl && <img src={item.imageUrl} alt="" />}
          <div>
            <span className="trends-code">{item.productCode}</span>
            <p>
              {p.description || p.short_description || "TRENDS product details"}
            </p>
          </div>
        </div>
        <div className="trends-detail-grid">
          <Detail label="Parent code" value={p.code} />
          <Detail
            label="Status"
            value={`${p.active || "—"} · ${p.status || "—"}`}
          />
          <Detail label="Colours" value={p.colours} />
          <Detail label="Variants" value={p.stock?.length || 0} />
          <Detail label="Images" value={p.images?.length || 0} />
          <Detail label="Packaging" value={p.packaging} />
          <Detail label="Last updated" value={p.last_updated} />
          <Detail
            label="Product wire"
            value={p.product_wire ? "Available" : "—"}
          />
        </div>
        <ProductRelationshipSection item={item} product={p} shop={shop} />
        {!!p.features?.length && (
          <DetailSection title="Features">
            <ul className="trends-detail-list">
              {p.features.map((feature, index) => (
                <li key={`${feature}${index}`}>{feature}</li>
              ))}
            </ul>
          </DetailSection>
        )}
        {!!p.images?.length && (
          <DetailSection title="Product images">
            <div className="trends-image-grid">
              {p.images.map((image, index) => (
                <a
                  key={`${image.link}${index}`}
                  href={normalizeTrendsUrl(image.link)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={normalizeTrendsUrl(image.link)}
                    alt={image.caption || image.colour || p.name || "Product"}
                  />
                  <span>
                    {image.caption || image.colour || `Image ${index + 1}`}
                  </span>
                </a>
              ))}
            </div>
          </DetailSection>
        )}
        <DetailSection title="Stock and variants">
          <div className="trends-table-wrap">
            <table className="trends-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Colour</th>
                  <th>Stock</th>
                  <th>Next shipment</th>
                  <th>Due date</th>
                </tr>
              </thead>
              <tbody>
                {(p.stock || []).slice(0, 50).map((v, i) => (
                  <tr key={`${v.stock_code}${i}`}>
                    <td>
                      <span className="trends-code">{v.stock_code || "—"}</span>
                    </td>
                    <td>{v.description || v.colour || v.color || "—"}</td>
                    <td>{v.quantity ?? "—"}</td>
                    <td>{v.next_shipment ?? "—"}</td>
                    <td>{v.due_date || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
        {pricing.map((tier, tierIndex) => (
          <DetailSection
            key={`${tier.type}${tierIndex}`}
            title={`${tier.primary_price_description || tier.type || "Product"} pricing`}
          >
            <div className="trends-table-wrap">
              <table className="trends-table">
                <thead>
                  <tr>
                    <th>Quantity</th>
                    <th>Supplier price</th>
                    <th>Less than MOQ</th>
                  </tr>
                </thead>
                <tbody>
                  {(tier.prices || []).map((price, index) => (
                    <tr key={`${price.quantity}${index}`}>
                      <td>{price.quantity}</td>
                      <td>${Number(price.price || 0).toFixed(2)}</td>
                      <td>{tier.less_than_moq || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tier.pricing_comment && (
              <p className="trends-detail-note">{tier.pricing_comment}</p>
            )}
          </DetailSection>
        ))}
        {!!costs.length && (
          <DetailSection title={`Additional costs (${costs.length})`}>
            <p className="trends-detail-note">
              These entries are synced into one linked Shopify branding product.
              Each branding method becomes a variant with its own unit price,
              setup price and charge-code metafields.
            </p>
            <div className="trends-table-wrap">
              <table className="trends-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Branding</th>
                    <th>Area</th>
                    <th>Unit</th>
                    <th>Setup</th>
                    <th>Unit SKU(s)</th>
                    <th>Order SKU</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.map((cost, index) => (
                    <tr key={`${cost.id}${index}`}>
                      <td>{cost.description || "—"}</td>
                      <td>{cost.branding_option || "—"}</td>
                      <td>{cost.branding_area || "—"}</td>
                      <td>${Number(cost.unit_price || 0).toFixed(2)}</td>
                      <td>
                        $
                        {Number(cost.setup_price ?? cost.setup ?? 0).toFixed(2)}
                      </td>
                      <td>
                        {(cost.price_per_unit_charge_codes || [])
                          .map((code) => code.price_per_unit_charge_code)
                          .join(", ") || "—"}
                      </td>
                      <td>{cost.price_per_order_charge_code || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DetailSection>
        )}
        {!!p.branding_options?.length && (
          <DetailSection title="Branding options">
            <SimpleTable
              headers={["Print type", "Description"]}
              rows={p.branding_options.map((option) => [
                option.print_type,
                option.print_description,
              ])}
            />
          </DetailSection>
        )}
        {!!p.additional_specifications?.length && (
          <DetailSection title="Specifications">
            <SimpleTable
              headers={["Specification", "Description"]}
              rows={p.additional_specifications.map((spec) => [
                spec.specification,
                spec.description,
              ])}
            />
          </DetailSection>
        )}
        {!!p.additional_materials?.length && (
          <DetailSection title="Materials">
            <SimpleTable
              headers={["Component", "Material"]}
              rows={p.additional_materials.map((material) => [
                material.component,
                material.material,
              ])}
            />
          </DetailSection>
        )}
        {!!p.categories?.length && (
          <DetailSection title="Categories">
            <SimpleTable
              headers={["Category", "Parent", "Number"]}
              rows={p.categories.map((category) => [
                category.name,
                category.appa_parent || "—",
                category.num,
              ])}
            />
          </DetailSection>
        )}
        <DetailSection title="Logistics and dimensions">
          <div className="trends-detail-grid">
            <Detail
              label="Dimensions"
              value={(p.dimensions || []).join(", ")}
            />
            <Detail label="Sizing" value={(p.sizing || []).join(", ")} />
            <Detail
              label="Carton size"
              value={
                p.carton
                  ? `${p.carton.length} × ${p.carton.width} × ${p.carton.height}`
                  : "—"
              }
            />
            <Detail label="Carton weight" value={p.carton?.weight} />
            <Detail label="Carton quantity" value={p.carton?.quantity} />
            <Detail label="Standard colours" value={p.standard_colours} />
          </div>
        </DetailSection>
        <details className="trends-raw-details">
          <summary>Complete raw TRENDS data</summary>
          <pre>{JSON.stringify(p, null, 2)}</pre>
        </details>
      </div>
    </Modal>
  );
}
function DetailSection({ title, children }) {
  return (
    <section className="trends-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function SimpleTable({ headers, rows }) {
  return (
    <div className="trends-table-wrap">
      <table className="trends-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, column) => (
                <td key={column}>{value || "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Detail({ label, value }) {
  return (
    <div className="trends-help">
      <strong>{label}</strong>
      {value || "—"}
    </div>
  );
}
const queuePage = (data, page) =>
  `/app/products?${new URLSearchParams({ ...(data.search ? { q: data.search } : {}), ...(data.status ? { status: data.status } : {}), sort: data.sort || "asc", page: String(Math.max(1, page)) })}`;
export const headers = (args) => boundary.headers(args);
