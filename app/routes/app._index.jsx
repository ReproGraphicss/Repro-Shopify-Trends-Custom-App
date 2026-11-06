import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const activeWhere = {
    shop: session.shop,
    sourceFile: { not: null },
  };
  const [counts, recentProducts, recentCronRuns, recentRuns, settings] =
    await Promise.all([
      prisma.syncProduct.groupBy({
        by: ["status"],
        where: activeWhere,
        _count: { _all: true },
      }),
      prisma.syncProduct.findMany({
        where: activeWhere,
        orderBy: { updatedAt: "desc" },
        take: 6,
        select: {
          id: true,
          productCode: true,
          title: true,
          imageUrl: true,
          status: true,
          updatedAt: true,
        },
      }),
      prisma.cronSyncLog.findMany({
        where: { shop: session.shop },
        orderBy: { startedAt: "desc" },
        take: 12,
        select: {
          id: true,
          mode: true,
          status: true,
          processed: true,
          updated: true,
          failed: true,
          remaining: true,
          durationMs: true,
          startedAt: true,
        },
      }),
      prisma.syncRun.findMany({
        where: { shop: session.shop },
        orderBy: { startedAt: "desc" },
        take: 6,
      }),
      prisma.shopSettings.upsert({
        where: { shop: session.shop },
        create: { shop: session.shop },
        update: {},
      }),
    ]);
  return {
    counts: Object.fromEntries(
      counts.map((item) => [item.status, item._count._all]),
    ),
    recentProducts,
    recentCronRuns: recentCronRuns.map((run) => ({
      ...run,
      startedAt: run.startedAt.toISOString(),
    })),
    recentRuns: recentRuns.map((run) => ({
      ...run,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() || null,
    })),
    globalMarkupPercent: settings.globalMarkupPercent,
    configured: Boolean(settings.encryptedTrendsToken),
  };
};

export default function Dashboard() {
  const data = useLoaderData();
  const recentProducts = data.recentProducts || [];
  const recentCronRuns = data.recentCronRuns || [];
  const pending = (data.counts.PENDING || 0) + (data.counts.FETCHING || 0);
  const fetched = data.counts.FETCHED || 0;
  const synced = data.counts.SYNCED || 0;
  const failed = data.counts.FAILED || 0;
  const total = Object.values(data.counts).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
  const syncRate = total ? Math.round((synced / total) * 100) : 0;
  const fetchRate = total ? Math.round(((fetched + synced) / total) * 100) : 0;
  const segments = [
    { label: "Pending", value: pending, className: "pending" },
    { label: "Fetched", value: fetched, className: "fetched" },
    { label: "Synced", value: synced, className: "synced" },
    { label: "Failed", value: failed, className: "failed" },
  ];
  const activityRuns = [...recentCronRuns].reverse();
  const maxActivity = Math.max(
    1,
    ...activityRuns.map((run) =>
      Math.max(run.processed, run.updated + run.failed),
    ),
  );

  return (
    <s-page heading="Overview" inlineSize="large">
      <s-button slot="primary-action" variant="primary" href="/app/products">
        Manage products
      </s-button>
      <div className="trends-shell trends-dashboard">
        <section className="trends-dashboard-hero">
          <div>
            <p className="trends-eyebrow">TRENDS commerce operations</p>
            <h2>Supplier-to-Shopify overview</h2>
            <p>
              Monitor the imported catalog, supplier data readiness and Shopify
              publishing progress from one place.
            </p>
          </div>
          <div className="trends-dashboard-hero__actions">
            <s-badge tone={data.configured ? "success" : "critical"}>
              {data.configured ? "TRENDS connected" : "Setup required"}
            </s-badge>
            <span>Global markup · {data.globalMarkupPercent}%</span>
          </div>
        </section>

        <section className="trends-metrics">
          <DashboardMetric
            label="TRENDS products"
            value={total}
            hint="All sheet uploads"
          />
          <DashboardMetric
            label="Ready to sync"
            value={fetched}
            hint={`${fetchRate}% details loaded`}
            tone="info"
          />
          <DashboardMetric
            label="Shopify synced"
            value={synced}
            hint={`${syncRate}% completion`}
            tone="success"
          />
          <DashboardMetric
            label="Needs attention"
            value={failed}
            hint="Review failed items"
            tone="critical"
          />
        </section>

        <section className="trends-dashboard-grid">
          <div className="trends-card">
            <div className="trends-card__header">
              <div>
                <h3>Sync health</h3>
                <p>Imported catalog status distribution</p>
              </div>
              <s-badge tone={failed ? "warning" : "success"}>
                {failed ? `${failed} need attention` : "Healthy"}
              </s-badge>
            </div>
            <div className="trends-card__body trends-health-layout">
              <div
                className="trends-ring"
                style={{ "--dashboard-progress": `${syncRate * 3.6}deg` }}
              >
                <div>
                  <strong>{syncRate}%</strong>
                  <span>synced</span>
                </div>
              </div>
              <div className="trends-status-chart">
                {segments.map((segment) => (
                  <div className="trends-chart-row" key={segment.label}>
                    <div>
                      <span
                        className={`trends-chart-dot trends-chart-dot--${segment.className}`}
                      />
                      {segment.label}
                      <strong>{segment.value}</strong>
                    </div>
                    <div className="trends-chart-track">
                      <span
                        className={`trends-chart-fill trends-chart-fill--${segment.className}`}
                        style={{
                          width: `${total ? (segment.value / total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="trends-card">
            <div className="trends-card__header">
              <div>
                <h3>Automation activity</h3>
                <p>Items processed in the latest 12 cron runs</p>
              </div>
              <s-button href="/app/logs">View activity</s-button>
            </div>
            {activityRuns.length ? (
              <div className="trends-activity-chart">
                <div className="trends-activity-chart__plot">
                  {activityRuns.map((run) => {
                    const successful = Math.max(0, run.updated);
                    const failedCount = Math.max(0, run.failed);
                    return (
                      <div
                        className="trends-activity-bar"
                        key={run.id}
                        title={`${automationName(run.mode)}: ${run.processed} processed, ${successful} successful, ${failedCount} failed`}
                      >
                        <div>
                          <span
                            className="is-failed"
                            style={{
                              height: `${(failedCount / maxActivity) * 100}%`,
                            }}
                          />
                          <span
                            className="is-success"
                            style={{
                              height: `${(successful / maxActivity) * 100}%`,
                            }}
                          />
                        </div>
                        <small>{automationShortName(run.mode)}</small>
                      </div>
                    );
                  })}
                </div>
                <div className="trends-activity-legend">
                  <span>
                    <i className="is-success" />
                    Successful
                  </span>
                  <span>
                    <i className="is-failed" />
                    Failed
                  </span>
                </div>
              </div>
            ) : (
              <DashboardEmpty text="Automation activity will appear after the first cron run." />
            )}
          </div>
        </section>

        <section className="trends-dashboard-grid trends-dashboard-grid--bottom">
          <div className="trends-card">
            <div className="trends-card__header">
              <div>
                <h3>Recently updated products</h3>
                <p>Latest activity across all uploaded sheets</p>
              </div>
              <s-button href="/app/products">View all</s-button>
            </div>
            {recentProducts.length ? (
              <div className="trends-dashboard-list">
                {recentProducts.map((product) => (
                  <div key={product.id} className="trends-dashboard-product">
                    <div className="trends-thumb">
                      {product.imageUrl ? (
                        <img src={product.imageUrl} alt="" />
                      ) : (
                        <span>—</span>
                      )}
                    </div>
                    <div>
                      <strong>{product.title || "Awaiting TRENDS data"}</strong>
                      <span>
                        {product.productCode} ·{" "}
                        {new Date(product.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    <StatusPill status={product.status} />
                  </div>
                ))}
              </div>
            ) : (
              <DashboardEmpty text="Upload a SKU sheet to begin." />
            )}
          </div>
          <div className="trends-card">
            <div className="trends-card__header">
              <div>
                <h3>Latest automation runs</h3>
                <p>Recent background sync activity</p>
              </div>
              <s-button href="/app/logs">View all</s-button>
            </div>
            {recentCronRuns.length ? (
              <div className="trends-dashboard-list">
                {recentCronRuns.slice(0, 6).map((run) => (
                  <div key={run.id} className="trends-run-row">
                    <div>
                      <strong>{automationName(run.mode)}</strong>
                      <span>
                        {new Date(run.startedAt).toLocaleString()} ·{" "}
                        {run.processed} processed
                      </span>
                    </div>
                    <div>
                      <StatusPill status={run.status} />
                      <small>
                        {run.updated} successful · {run.failed} failed
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <DashboardEmpty text="No sync runs yet." />
            )}
          </div>
        </section>
      </div>
    </s-page>
  );
}

const automationName = (mode) =>
  ({
    prices: "Price & quantity sync",
    full: "Daily product sync",
    cleanup: "Temporary item cleanup",
    catalog: "Product sync",
  })[mode] || mode;

const automationShortName = (mode) =>
  ({ prices: "P&Q", full: "Full", cleanup: "Clean", catalog: "Product" })[
    mode
  ] || "Sync";

function DashboardMetric({ label, value, hint, tone = "" }) {
  return (
    <div className="trends-metric">
      <div className="trends-metric__top">
        <span>{label}</span>
        <span
          className={`trends-metric__dot${tone ? ` trends-metric__dot--${tone}` : ""}`}
        />
      </div>
      <strong>{Number(value).toLocaleString()}</strong>
      <small className="trends-dashboard-metric__hint">{hint}</small>
    </div>
  );
}

function StatusPill({ status }) {
  const tone = ["SYNCED", "COMPLETED"].includes(status)
    ? "success"
    : ["FAILED"].includes(status)
      ? "critical"
      : ["FETCHED", "PARTIAL"].includes(status)
        ? "warning"
        : "info";
  return (
    <s-badge tone={tone}>
      {String(status).toLowerCase().replaceAll("_", " ")}
    </s-badge>
  );
}

function DashboardEmpty({ text }) {
  return (
    <div className="trends-dashboard-empty">
      <span>◇</span>
      <p>{text}</p>
    </div>
  );
}

export const headers = (args) => boundary.headers(args);
