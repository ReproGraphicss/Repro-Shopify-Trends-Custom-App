import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const activeWhere = {
    shop: session.shop,
    sourceFile: { not: null },
    includedInCurrentSheet: true,
  };
  const [counts, recentProducts, recentRuns, settings] = await Promise.all([
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
    prisma.syncRun.findMany({
      where: { shop: session.shop },
      orderBy: { startedAt: "desc" },
      take: 5,
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
    recentRuns,
    globalMarkupPercent: settings.globalMarkupPercent,
    configured: Boolean(
      settings.encryptedTrendsToken || process.env.TRENDS_API_TOKEN,
    ),
  };
};

export default function Dashboard() {
  const data = useLoaderData();
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

  return (
    <s-page heading="Dashboard" inlineSize="large">
      <s-button slot="primary-action" variant="primary" href="/app/products">
        Manage products
      </s-button>
      <div className="trends-shell trends-dashboard">
        <section className="trends-dashboard-hero">
          <div>
            <p className="trends-eyebrow">TRENDS commerce operations</p>
            <h2>Supplier-to-Shopify overview</h2>
            <p>
              Monitor the current sheet, supplier data readiness and Shopify
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
            label="Sheet products"
            value={total}
            hint="Current upload"
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
                <p>Current sheet status distribution</p>
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
                <h3>Quick actions</h3>
                <p>Continue the most common workflows</p>
              </div>
            </div>
            <div className="trends-card__body trends-quick-actions">
              <a href="/app/products">
                <strong>Upload and manage SKUs</strong>
                <span>Import a sheet, fetch details and sync products</span>
                <b>→</b>
              </a>
              <a href="/app/products?status=FAILED">
                <strong>Review failed items</strong>
                <span>Inspect supplier or Shopify sync errors</span>
                <b>→</b>
              </a>
              <a href="/app/settings">
                <strong>Integration settings</strong>
                <span>Manage the API, markup and inventory location</span>
                <b>→</b>
              </a>
            </div>
          </div>
        </section>

        <section className="trends-dashboard-grid trends-dashboard-grid--bottom">
          <div className="trends-card">
            <div className="trends-card__header">
              <div>
                <h3>Recently updated products</h3>
                <p>Latest activity in the current sheet</p>
              </div>
              <s-button href="/app/products">View all</s-button>
            </div>
            {data.recentProducts.length ? (
              <div className="trends-dashboard-list">
                {data.recentProducts.map((product) => (
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
                <h3>Recent sync runs</h3>
                <p>Latest Shopify publishing results</p>
              </div>
            </div>
            {data.recentRuns.length ? (
              <div className="trends-dashboard-list">
                {data.recentRuns.map((run) => (
                  <div key={run.id} className="trends-run-row">
                    <div>
                      <strong>
                        {new Date(run.startedAt).toLocaleString()}
                      </strong>
                      <span>{run.requested} products requested</span>
                    </div>
                    <div>
                      <StatusPill status={run.status} />
                      <small>
                        {run.succeeded} synced · {run.failed} failed
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
