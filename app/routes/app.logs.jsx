/* eslint-disable react/prop-types */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Form,
  Link,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const safeErrors = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const safeDetails = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = String(url.searchParams.get("search") || "").trim();
  const requestedMode = String(url.searchParams.get("type") || "prices");
  const requestedStatus = String(url.searchParams.get("status") || "all");
  const mode = ["prices", "full", "catalog", "cleanup", "settings"].includes(
    requestedMode,
  )
    ? requestedMode
    : "prices";
  const status = [
    "RUNNING",
    "COMPLETED",
    "PARTIAL",
    "FAILED",
    "INTERRUPTED",
  ].includes(requestedStatus)
    ? requestedStatus
    : "all";
  const pageSize = 50;
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const now = Date.now();
  const staleModes = [
    ["prices", 18],
    ["catalog", 45],
    ["cleanup", 60],
    ["full", 180],
    ["settings", 60],
  ];
  await Promise.all(
    staleModes.map(([staleMode, minutes]) =>
      prisma.cronSyncLog.updateMany({
        where: {
          shop: session.shop,
          mode: staleMode,
          status: "RUNNING",
          startedAt: { lt: new Date(now - minutes * 60 * 1000) },
        },
        data: {
          status: "INTERRUPTED",
          errorsJson: JSON.stringify([
            {
              message:
                "The synchronization stopped reporting progress and was automatically released.",
            },
          ]),
          finishedAt: new Date(),
        },
      }),
    ),
  );
  const where = {
    shop: session.shop,
    mode,
    ...(status !== "all" ? { status } : {}),
    ...(search
      ? {
          OR: [
            { mode: { contains: search } },
            { status: { contains: search.toUpperCase() } },
            { errorsJson: { contains: search } },
            { detailsJson: { contains: search } },
          ],
        }
      : {}),
  };
  const [total, latestRun, statusGroups, recentRuns] = await Promise.all([
    prisma.cronSyncLog.count({ where }),
    prisma.cronSyncLog.findFirst({
      where: { shop: session.shop, mode },
      orderBy: { startedAt: "desc" },
    }),
    prisma.syncProduct.groupBy({
      by: ["status"],
      where: { shop: session.shop, sourceFile: { not: null } },
      _count: { _all: true },
    }),
    prisma.cronSyncLog.findMany({
      where: { shop: session.shop, detailsJson: { not: "[]" } },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: {
        id: true,
        mode: true,
        status: true,
        startedAt: true,
        detailsJson: true,
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const logs = await prisma.cronSyncLog.findMany({
    where,
    orderBy: { startedAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  const serializeLog = (log) =>
    log
      ? {
          ...log,
          errors: safeErrors(log.errorsJson),
          details: safeDetails(log.detailsJson).filter(
            (item) => !item.internal,
          ),
          errorsJson: undefined,
          detailsJson: undefined,
          startedAt: log.startedAt.toISOString(),
          finishedAt: log.finishedAt?.toISOString() || null,
        }
      : null;
  return {
    logs: logs.map(serializeLog),
    latest: serializeLog(latestRun),
    filters: { search, mode, status },
    pagination: { page, pageSize, total, totalPages },
    catalog: Object.fromEntries(
      statusGroups.map((group) => [group.status, group._count._all]),
    ),
    latestChanges: recentRuns
      .flatMap((run) =>
        safeDetails(run.detailsJson)
          .filter((item) => !item.internal)
          .map((item, index) => ({
            ...item,
            eventId: `${run.id}-${index}`,
            syncMode: run.mode,
            runStatus: run.status,
            occurredAt: run.startedAt.toISOString(),
          })),
      )
      .filter(
        (item) =>
          item.syncMode !== "settings" || item.action !== "settings_applied",
      )
      .filter(
        (item) =>
          item.status === "failed" ||
          (item.action && item.action !== "verified_no_change") ||
          item.priceChanged ||
          item.inventoryChanged ||
          item.recordsRemoved ||
          item.logsDeleted,
      )
      .slice(0, 500),
  };
};

const modeName = (mode) =>
  ({
    prices: "Price & quantity sync",
    full: "Daily product sync",
    cleanup: "Temporary item sync",
    catalog: "Product sync",
    settings: "Settings updates",
  })[mode] || mode;

const cronSchedules = {
  prices: {
    label: "Every 15 minutes",
    expression: "5-59/15 * * * *",
    description:
      "Verifies live prices and quantities and records every value that changed.",
  },
  full: {
    label: "Daily at 2:02 AM UTC (7:32 AM IST)",
    expression: "2 2 * * *",
    description: "Performs a complete refresh of every synced product.",
  },
  cleanup: {
    label: "Daily at 4:43 AM UTC (10:13 AM IST)",
    expression: "43 4 * * *",
    description: "Removes expired configured variants and stale records.",
  },
  catalog: {
    label: "Every 30 minutes",
    expression: "*/30 * * * *",
    description: "Imports up to 25 queued TRENDS products per run.",
  },
  settings: {
    label: "When settings change",
    expression: "Triggered by an administrator",
    description:
      "Tracks configuration changes and their rollout to existing Shopify products.",
  },
};

const metricLabels = {
  catalog: {
    processed: "Products attempted",
    successful: "Products synced",
    failed: "Products failed",
    remaining: "Still queued",
  },
  prices: {
    processed: "Products checked",
    successful: "Checks completed",
    failed: "Products failed",
    remaining: "Require retry",
  },
  full: {
    processed: "Products refreshed",
    successful: "Refresh completed",
    failed: "Products failed",
    remaining: "Require retry",
  },
  cleanup: {
    processed: "Expired records checked",
    successful: "Records removed",
    failed: "Cleanup errors",
    remaining: "Still pending",
  },
  settings: {
    processed: "Products processed",
    successful: "Products updated",
    failed: "Products failed",
    remaining: "Still pending",
  },
};

const duration = (milliseconds) => {
  if (!milliseconds) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const tone = (status) =>
  status === "COMPLETED"
    ? "success"
    : status === "RUNNING"
      ? "info"
      : status === "PARTIAL"
        ? "warning"
        : "critical";

const DETAIL_PAGE_SIZE = 50;
const WATCHED_CHANGES_STORAGE_KEY = "trends-sync-watched-changes-v1";
const humanizeAction = (value) =>
  String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const hasPriceChanges = (item) =>
  Number(item.priceChanged || 0) > 0 || item.priceChanges?.length > 0;
const hasQuantityChanges = (item) =>
  Number(item.inventoryChanged || 0) > 0 || item.inventoryChanges?.length > 0;
const hasOtherChanges = (item) =>
  item.status === "failed" ||
  item.recordsRemoved !== undefined ||
  item.logsDeleted !== undefined ||
  item.changes?.length > 0 ||
  Boolean(item.message) ||
  (!hasPriceChanges(item) && !hasQuantityChanges(item));

const changeDirection = (change, quantity = false) => {
  const from = Number(change.from);
  const to = Number(change.to);
  if (quantity && Number.isFinite(to) && to < 10)
    return { label: "Low stock", tone: "critical" };
  if (!Number.isFinite(from) || !Number.isFinite(to))
    return { label: "Changed", tone: "neutral" };
  if (to > from) return { label: "Increased", tone: "increase" };
  if (to < from) return { label: "Decreased", tone: "decrease" };
  return { label: "Unchanged", tone: "neutral" };
};

const initialDetailTab = (details) =>
  details.some(hasPriceChanges)
    ? "price"
    : details.some(hasQuantityChanges)
      ? "quantity"
      : "other";

function ProductDetailsModal({
  log,
  mode,
  onClose,
  heading = "Affected items",
  eyebrow,
  watchedIds = [],
  onMarkWatched,
}) {
  const [page, setPage] = useState(1);
  const itemListRef = useRef(null);
  const details = log?.details || [];
  const [activeTab, setActiveTab] = useState(() => initialDetailTab(details));
  const [selectedItem, setSelectedItem] = useState(null);
  const tabs = [
    {
      id: "price",
      label: "Price changes",
      items: details.filter(hasPriceChanges),
    },
    {
      id: "quantity",
      label: "Quantity changes",
      items: details.filter(hasQuantityChanges),
    },
    {
      id: "other",
      label: "Other changes",
      items: details.filter(hasOtherChanges),
    },
  ];
  const selectedTab = tabs.find((tab) => tab.id === activeTab) || tabs[0];
  const filteredDetails = selectedTab.items;
  const totalPages = Math.max(
    1,
    Math.ceil(filteredDetails.length / DETAIL_PAGE_SIZE),
  );
  const visibleItems = filteredDetails.slice(
    (page - 1) * DETAIL_PAGE_SIZE,
    page * DETAIL_PAGE_SIZE,
  );

  const selectTab = (tab) => {
    setActiveTab(tab);
    setPage(1);
    setSelectedItem(null);
  };

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      if (selectedItem) setSelectedItem(null);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, selectedItem]);

  useEffect(() => {
    if (!onMarkWatched || !itemListRef.current) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const watchId = entry.target.getAttribute("data-watch-id");
          if (watchId) onMarkWatched(watchId);
          observer.unobserve(entry.target);
        });
      },
      {
        root: itemListRef.current,
        rootMargin: "0px 0px -8% 0px",
        threshold: 0.6,
      },
    );
    itemListRef.current
      .querySelectorAll("[data-watch-id]")
      .forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [activeTab, onMarkWatched, page, visibleItems]);

  if (!log) return null;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="trends-log-modal-backdrop" role="presentation">
      <section
        className="trends-log-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-detail-title"
      >
        <header className="trends-log-modal__head">
          <div>
            <span>{eyebrow || modeName(mode)}</span>
            <h2 id="sync-detail-title">{heading}</h2>
            <p>
              {details.length} item{details.length === 1 ? "" : "s"} recorded ·{" "}
              {new Date(log.startedAt).toLocaleString()}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details">
            ×
          </button>
        </header>
        <nav className="trends-log-detail-tabs" aria-label="Change categories">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`is-${tab.id}${activeTab === tab.id ? " is-active" : ""}`}
              aria-pressed={activeTab === tab.id}
              onClick={() => selectTab(tab.id)}
            >
              <span>{tab.label}</span>
              <strong>{tab.items.length}</strong>
            </button>
          ))}
        </nav>
        <div className="trends-log-modal__body" ref={itemListRef}>
          {!visibleItems.length ? (
            <div className="trends-log-modal__empty">
              <strong>No recorded changes yet</strong>
              <p>New synchronization changes will appear here.</p>
            </div>
          ) : null}
          {visibleItems.map((item, index) => {
            const itemKey = `${item.eventId || log.id}-${item.code || index}-${(page - 1) * DETAIL_PAGE_SIZE + index}`;
            const watchId = item.eventId || itemKey;
            const watched = watchedIds.includes(watchId);
            return (
              <article
                className={`trends-log-detail-item is-${activeTab}`}
                key={itemKey}
                data-watch-id={watched || !onMarkWatched ? undefined : watchId}
              >
                <div className="trends-log-detail-item__head">
                  <span className={`is-${item.status || "success"}`}>
                    {item.status || "success"}
                  </span>
                  {watched ? (
                    <span className="trends-log-watched-badge">Watched</span>
                  ) : onMarkWatched ? (
                    <span className="trends-log-unread-badge">New</span>
                  ) : null}
                  <div>
                    <strong>{item.title || "TRENDS item"}</strong>
                    <small>
                      {item.code ? `SKU ${item.code}` : "No SKU recorded"}
                      {item.action ? ` · ${humanizeAction(item.action)}` : ""}
                    </small>
                    {item.syncMode || item.occurredAt ? (
                      <small className="trends-log-event-meta">
                        {item.syncMode ? modeName(item.syncMode) : "Sync event"}
                        {item.occurredAt
                          ? ` · ${new Date(item.occurredAt).toLocaleString()}`
                          : ""}
                      </small>
                    ) : null}
                  </div>
                  <div className="trends-log-detail-summary">
                    {hasPriceChanges(item) ? (
                      <span className="is-price">
                        {item.priceChanged || item.priceChanges?.length || 0}{" "}
                        price
                      </span>
                    ) : null}
                    {hasQuantityChanges(item) ? (
                      <span className="is-quantity">
                        {item.inventoryChanged ||
                          item.inventoryChanges?.length ||
                          0}{" "}
                        quantity
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-expanded={selectedItem === item}
                      onClick={() => {
                        setSelectedItem((current) =>
                          current === item ? null : item,
                        );
                      }}
                    >
                      {selectedItem === item ? "Hide item" : "View item"}
                    </button>
                  </div>
                </div>
                {selectedItem === item ? (
                  <ItemChangeDetails item={item} />
                ) : null}
              </article>
            );
          })}
        </div>
        <footer className="trends-log-modal__footer">
          <span>
            Showing{" "}
            {filteredDetails.length ? (page - 1) * DETAIL_PAGE_SIZE + 1 : 0}–
            {Math.min(page * DETAIL_PAGE_SIZE, filteredDetails.length)} of{" "}
            {filteredDetails.length}
          </span>
          <div>
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </button>
            <strong>
              Page {page} of {totalPages}
            </strong>
            <button
              type="button"
              disabled={page === totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function ItemChangeDetails({ item }) {
  return (
    <div className="trends-item-change-accordion">
      <div className="trends-item-change-accordion__inner">
        <div className="trends-item-change-modal__summary">
          <span className={`is-${item.status || "success"}`}>
            {item.status || "success"}
          </span>
          <strong>
            {humanizeAction(item.action) || "Synchronization event"}
          </strong>
          <small>Detailed changes for SKU {item.code || "not recorded"}</small>
        </div>
        <div className="trends-item-change-modal__body">
          {hasPriceChanges(item) ? (
            <section className="is-price">
              <header>
                <div>
                  <span>Price</span>
                  <strong>Price changes</strong>
                </div>
                <b>{item.priceChanged || item.priceChanges?.length || 0}</b>
              </header>
              <ul className="trends-log-change-list">
                {(item.priceChanges || []).map((change, index) => {
                  const direction = changeDirection(change);
                  return (
                    <li key={`item-price-${index}`}>
                      <strong>{change.sku || item.code}</strong>
                      <span className="trends-log-change-values">
                        ${change.from} → ${change.to}
                      </span>
                      <em className={`is-${direction.tone}`}>
                        {direction.label}
                      </em>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {hasQuantityChanges(item) ? (
            <section className="is-quantity">
              <header>
                <div>
                  <span>Inventory</span>
                  <strong>Quantity changes</strong>
                </div>
                <b>
                  {item.inventoryChanged || item.inventoryChanges?.length || 0}
                </b>
              </header>
              <ul className="trends-log-change-list">
                {(item.inventoryChanges || []).map((change, index) => {
                  const direction = changeDirection(change, true);
                  return (
                    <li key={`item-quantity-${index}`}>
                      <strong>{change.sku || item.code}</strong>
                      <span className="trends-log-change-values">
                        {change.from} → {change.to}
                      </span>
                      <em className={`is-${direction.tone}`}>
                        {direction.label}
                      </em>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {hasOtherChanges(item) ? (
            <section className="is-other">
              <header>
                <div>
                  <span>Activity</span>
                  <strong>Other information</strong>
                </div>
              </header>
              <OtherChangeDetails item={item} />
            </section>
          ) : null}
          {!hasPriceChanges(item) &&
          !hasQuantityChanges(item) &&
          !hasOtherChanges(item) ? (
            <div className="trends-log-modal__empty">
              <strong>No item-level changes recorded</strong>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function OtherChangeDetails({ item }) {
  return (
    <div className="trends-log-other-details">
      {item.recordsRemoved !== undefined ? (
        <p>
          {item.recordsRemoved} records removed · {item.variantsDeleted || 0}{" "}
          variants deleted
        </p>
      ) : null}
      {item.logsDeleted !== undefined ? (
        <p>
          {item.logsDeleted} old log record{item.logsDeleted === 1 ? "" : "s"}{" "}
          deleted · newest {item.retained || 1000} retained
        </p>
      ) : null}
      {item.changes?.length ? (
        <ul className="trends-log-action-list">
          {item.changes.map((change, index) => (
            <li key={`action-${index}`}>{change}</li>
          ))}
        </ul>
      ) : null}
      {item.targetProductId ? (
        <p>Shopify target: {item.targetProductId}</p>
      ) : null}
      {item.message ? <p>{item.message}</p> : null}
      {item.recordsRemoved === undefined &&
      item.logsDeleted === undefined &&
      !item.changes?.length &&
      !item.message ? (
        <p>
          {item.action === "verified_no_change"
            ? "Price and quantity already matched; no update was required."
            : humanizeAction(item.action) ||
              "No additional change details were recorded."}
        </p>
      ) : null}
    </div>
  );
}

export default function SyncLogsPage() {
  const { logs, latest, latestChanges, catalog, filters, pagination } =
    useLoaderData();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const [selectedLog, setSelectedLog] = useState(null);
  const [selectedErrorLog, setSelectedErrorLog] = useState(null);
  const [showRecentChanges, setShowRecentChanges] = useState(false);
  const [watchedChangeIds, setWatchedChangeIds] = useState([]);
  const [watchedChangesLoaded, setWatchedChangesLoaded] = useState(false);
  const queueRemaining =
    (catalog.FETCHED || 0) + (catalog.FAILED || 0) + (catalog.SYNCING || 0);
  const labels = metricLabels[filters.mode];
  const remaining =
    filters.mode === "catalog" ? queueRemaining : latest?.remaining || 0;
  const unreadChanges = watchedChangesLoaded
    ? latestChanges.filter((item) => !watchedChangeIds.includes(item.eventId))
        .length
    : latestChanges.length;

  useEffect(() => {
    try {
      const stored = JSON.parse(
        window.localStorage.getItem(WATCHED_CHANGES_STORAGE_KEY) || "[]",
      );
      setWatchedChangeIds(Array.isArray(stored) ? stored : []);
    } catch {
      setWatchedChangeIds([]);
    }
    setWatchedChangesLoaded(true);
  }, []);

  useEffect(() => {
    if (!watchedChangesLoaded) return;
    const currentIds = new Set(
      latestChanges.map((item) => item.eventId).filter(Boolean),
    );
    const retained = watchedChangeIds.filter((id) => currentIds.has(id));
    window.localStorage.setItem(
      WATCHED_CHANGES_STORAGE_KEY,
      JSON.stringify(retained),
    );
  }, [watchedChangeIds, watchedChangesLoaded, latestChanges]);

  const markChangeWatched = useCallback((eventId) => {
    if (!eventId) return;
    setWatchedChangeIds((current) =>
      current.includes(eventId) ? current : [...current, eventId],
    );
  }, []);

  useEffect(() => {
    if (latest?.status !== "RUNNING") return undefined;
    const timer = window.setInterval(() => revalidator.revalidate(), 10000);
    return () => window.clearInterval(timer);
  }, [latest?.status, revalidator]);

  const pageUrl = (page) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(page));
    return `?${params.toString()}`;
  };

  return (
    <s-page heading="Sync Activity" inlineSize="large">
      <div className="trends-log-page">
        <div className="trends-cron-toolbar">
          <nav className="trends-cron-tabs" aria-label="Cron analytics">
            {Object.entries(cronSchedules).map(([mode, schedule]) => (
              <Link
                key={mode}
                to={`?type=${mode}`}
                className={filters.mode === mode ? "is-active" : ""}
                aria-current={filters.mode === mode ? "page" : undefined}
              >
                <strong>{modeName(mode)}</strong>
                <small>{schedule.label}</small>
              </Link>
            ))}
          </nav>
          <div className="trends-log-toolbar-actions">
            <button
              type="button"
              className="trends-log-changes-button"
              onClick={() => setShowRecentChanges(true)}
              aria-label="View synchronization notifications"
              title={`${unreadChanges} unread of ${latestChanges.length} recent changes`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 8v4l3 2m6-2a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
              <strong>Notifications</strong>
              <span className="trends-log-changes-count">{unreadChanges}</span>
            </button>
            <button
              type="button"
              className="trends-log-refresh"
              disabled={revalidator.state !== "idle"}
              onClick={() => revalidator.revalidate()}
            >
              {revalidator.state === "idle" ? "Refresh" : "Refreshing…"}
            </button>
          </div>
        </div>

        <section className="trends-log-cards">
          <article className="trends-log-card">
            <span>Latest run</span>
            <strong>{latest?.status?.toLowerCase() || "No runs yet"}</strong>
            <small>
              {latest
                ? new Date(latest.startedAt).toLocaleString()
                : "Waiting for the first recorded run"}
            </small>
          </article>
          <article className="trends-log-card">
            <span>{labels.processed}</span>
            <strong>{latest?.processed || 0}</strong>
            <small>Items checked in the latest run</small>
          </article>
          <article className="trends-log-card">
            <span>{labels.successful}</span>
            <strong>{latest?.updated || 0}</strong>
            <small>Completed successfully in the latest run</small>
          </article>
          <article className="trends-log-card">
            <span>Needs attention</span>
            <strong>{latest?.failed || 0}</strong>
            <small>
              {labels.remaining}:{" "}
              {filters.mode === "catalog" && remaining === 0
                ? "No remaining"
                : remaining}
            </small>
          </article>
        </section>

        <section className="trends-log-panel">
          <div className="trends-log-panel__head">
            <div>
              <h3>Run history</h3>
              <p>
                {pagination.total} recorded sync
                {pagination.total === 1 ? " run" : " runs"}.
              </p>
            </div>
          </div>
          <Form method="get" className="trends-log-filters">
            <input type="hidden" name="type" value={filters.mode} />
            <label className="trends-log-field trends-log-field--search">
              <span>Search</span>
              <input
                type="search"
                name="search"
                defaultValue={filters.search}
                placeholder="Search SKU, error or operation"
              />
            </label>
            <label className="trends-log-field">
              <span>Run status</span>
              <select name="status" defaultValue={filters.status}>
                <option value="all">All statuses</option>
                <option value="COMPLETED">Completed</option>
                <option value="RUNNING">Running</option>
                <option value="PARTIAL">Partially completed</option>
                <option value="FAILED">Failed</option>
                <option value="INTERRUPTED">Interrupted</option>
              </select>
            </label>
            <button type="submit" className="trends-log-filter-button">
              Apply filters
            </button>
            {(filters.search || filters.status !== "all") && (
              <Link
                to={`/app/logs?type=${filters.mode}`}
                className="trends-log-clear"
              >
                Clear
              </Link>
            )}
          </Form>
          {logs.length ? (
            <div className="trends-log-table-wrap">
              <table className="trends-log-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Status</th>
                    <th>Summary</th>
                    <th>Changes</th>
                    <th>Remaining</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td>
                        <strong>
                          {new Date(log.startedAt).toLocaleDateString()}
                        </strong>
                        <small>
                          {new Date(log.startedAt).toLocaleTimeString()}
                        </small>
                      </td>
                      <td>
                        <s-badge tone={tone(log.status)}>
                          {log.status.toLowerCase()}
                        </s-badge>
                        {log.errors.length ? (
                          <button
                            type="button"
                            className="trends-log-error-button"
                            onClick={() => setSelectedErrorLog(log)}
                          >
                            {log.failed || log.errors.length} error
                            {(log.failed || log.errors.length) === 1 ? "" : "s"}
                          </button>
                        ) : null}
                      </td>
                      <td>
                        <strong>{log.processed} processed</strong>
                        <small>
                          {log.updated} successful · {log.failed} failed
                        </small>
                      </td>
                      <td className="trends-log-changes-cell">
                        {log.details.length ? (
                          <button
                            type="button"
                            className="trends-log-view-button"
                            onClick={() => setSelectedLog(log)}
                          >
                            View {log.details.length}{" "}
                            {filters.mode === "cleanup"
                              ? "results"
                              : `item${log.details.length === 1 ? "" : "s"}`}
                          </button>
                        ) : (
                          <small className="trends-log-legacy">
                            {log.processed
                              ? "Aggregate-only legacy log"
                              : "No products required processing"}
                          </small>
                        )}
                        {filters.mode === "prices" ? (
                          <small>
                            {log.priceChanged} price · {log.inventoryChanged}{" "}
                            quantity updated
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {filters.mode === "catalog" && log.remaining === 0
                          ? "No remaining"
                          : log.remaining}
                      </td>
                      <td>
                        {log.status === "RUNNING"
                          ? "In progress"
                          : duration(log.durationMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="trends-log-empty">
              <h3>
                {pagination.total ? "No logs on this page" : "No matching logs"}
              </h3>
              <p>
                Try adjusting the search term or filters to see more results.
              </p>
            </div>
          )}
          {pagination.totalPages > 1 ? (
            <nav className="trends-log-pagination" aria-label="Log pagination">
              <span>
                Showing {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(
                  pagination.page * pagination.pageSize,
                  pagination.total,
                )}{" "}
                of {pagination.total}
              </span>
              <div>
                {pagination.page > 1 ? (
                  <Link to={pageUrl(pagination.page - 1)}>Previous</Link>
                ) : (
                  <span className="is-disabled">Previous</span>
                )}
                <strong>
                  Page {pagination.page} of {pagination.totalPages}
                </strong>
                {pagination.page < pagination.totalPages ? (
                  <Link to={pageUrl(pagination.page + 1)}>Next</Link>
                ) : (
                  <span className="is-disabled">Next</span>
                )}
              </div>
            </nav>
          ) : null}
        </section>
      </div>
      {selectedLog ? (
        <ProductDetailsModal
          log={selectedLog}
          mode={filters.mode}
          onClose={() => setSelectedLog(null)}
        />
      ) : null}
      {showRecentChanges ? (
        <ProductDetailsModal
          log={{
            id: "recent-changes",
            startedAt: latestChanges[0]?.occurredAt || new Date().toISOString(),
            details: latestChanges,
          }}
          mode="prices"
          eyebrow="All synchronization types"
          heading="Recent changes"
          watchedIds={watchedChangeIds}
          onMarkWatched={markChangeWatched}
          onClose={() => setShowRecentChanges(false)}
        />
      ) : null}
      {selectedErrorLog ? (
        <ProductDetailsModal
          log={{
            ...selectedErrorLog,
            details:
              selectedErrorLog.details.filter(
                (item) => item.status === "failed",
              ).length > 0
                ? selectedErrorLog.details.filter(
                    (item) => item.status === "failed",
                  )
                : selectedErrorLog.errors.map((error, index) => ({
                    status: "failed",
                    code: error.code,
                    title: error.code
                      ? `SKU ${error.code}`
                      : `Synchronization error ${index + 1}`,
                    action: "sync_failed",
                    message: error.message,
                  })),
          }}
          mode={filters.mode}
          eyebrow="Synchronization errors"
          heading="Items requiring attention"
          onClose={() => setSelectedErrorLog(null)}
        />
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
