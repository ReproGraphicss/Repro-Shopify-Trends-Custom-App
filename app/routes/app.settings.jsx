import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { decryptSecret, encryptSecret } from "../lib/crypto.server";
import { TrendsClient } from "../lib/trends.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {},
  });
  const response = await admin.graphql(`#graphql
    query SyncLocations {
      locations(first: 50, includeInactive: false) {
        nodes { id name }
      }
    }
  `);
  const savedToken = settings.encryptedTrendsToken
    ? decryptSecret(settings.encryptedTrendsToken)
    : process.env.TRENDS_API_TOKEN || "";
  return {
    settings: {
      trendsBaseUrl: settings.trendsBaseUrl,
      globalMarkupPercent: settings.globalMarkupPercent,
      additionalMarkupPercent: settings.additionalMarkupPercent,
      inventoryLocationId: settings.inventoryLocationId,
    },
    tokenConfigured: Boolean(
      settings.encryptedTrendsToken || process.env.TRENDS_API_TOKEN,
    ),
    savedToken,
    locations: (await response.json()).data?.locations?.nodes || [],
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const settings = await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {},
  });
  if (form.get("intent") === "test") {
    const token =
      process.env.TRENDS_API_TOKEN ||
      (settings.encryptedTrendsToken
        ? decryptSecret(settings.encryptedTrendsToken)
        : "");
    if (!token) return { ok: false, message: "Save the TRENDS token first" };
    try {
      const product = await new TrendsClient(
        settings.trendsBaseUrl,
        token,
      ).getProduct(String(form.get("testProductCode") || "125567"));
      return {
        ok: true,
        message: `Connected: ${product.code} — ${product.name}`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }
  const markup = Number(form.get("globalMarkupPercent"));
  if (!Number.isFinite(markup) || markup < 0 || markup > 1000)
    return { ok: false, message: "Main markup must be between 0% and 1000%" };
  const additionalMarkup = Number(form.get("additionalMarkupPercent"));
  if (
    !Number.isFinite(additionalMarkup) ||
    additionalMarkup < 0 ||
    additionalMarkup > 1000
  )
    return {
      ok: false,
      message: "Additional markup must be between 0% and 1000%",
    };
  const tokenChanged = String(form.get("tokenChanged") || "") === "true";
  const token = tokenChanged
    ? String(form.get("trendsToken") || "").trim()
    : "";
  await prisma.shopSettings.update({
    where: { shop: session.shop },
    data: {
      trendsBaseUrl: String(
        form.get("trendsBaseUrl") || "https://nz.api.trends.nz",
      ).replace(/\/$/, ""),
      globalMarkupPercent: markup,
      additionalMarkupPercent: additionalMarkup,
      inventoryLocationId:
        String(form.get("inventoryLocationId") || "") || null,
      ...(token ? { encryptedTrendsToken: encryptSecret(token) } : {}),
    },
  });
  return { ok: true, message: "Settings saved" };
};

export default function Settings() {
  const { settings, tokenConfigured, savedToken, locations } = useLoaderData();
  const result = useActionData();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [tokenValue, setTokenValue] = useState(savedToken || "");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenChanged, setTokenChanged] = useState(false);
  useEffect(() => {
    if (result?.message)
      shopify.toast.show(result.message, { isError: !result.ok });
  }, [result, shopify]);
  const busy = navigation.state !== "idle";
  return (
    <s-page heading="TRENDS sync settings" inlineSize="large">
      <div className="trends-shell">
        <div className="trends-hero">
          <div className="trends-hero__content">
            <p className="trends-eyebrow">Integration settings</p>
            <h2>Control how TRENDS products reach Shopify</h2>
            <p>
              Manage the supplier connection, pricing rules and inventory
              destination from one place.
            </p>
          </div>
          <div className="trends-hero__meta">
            {tokenConfigured ? "● API connected" : "○ Setup required"}
          </div>
        </div>
        {!tokenConfigured && (
          <s-banner tone="warning" heading="Complete the TRENDS connection">
            Add your API token below, save the settings, then test with a
            product code.
          </s-banner>
        )}
        <div className="trends-split">
          <div className="trends-card">
            <div className="trends-card__header">
              <div>
                <h3>Connection and sync defaults</h3>
                <p>
                  Configure the shared connection, markup and inventory
                  destination for product sync.
                </p>
              </div>
              <s-badge tone={tokenConfigured ? "success" : "warning"}>
                {tokenConfigured ? "Token saved" : "Not connected"}
              </s-badge>
            </div>
            <div className="trends-card__body">
              <Form method="post">
                <input type="hidden" name="intent" value="save" />
                <div className="trends-form-grid">
                  <label className="trends-field">
                    TRENDS API URL
                    <input
                      className="trends-input"
                      name="trendsBaseUrl"
                      required
                      defaultValue={settings.trendsBaseUrl}
                    />
                    <small>
                      The base URL used for catalog and single-product requests.
                    </small>
                  </label>
                  <label className="trends-field">
                    TRENDS bearer token
                    <span
                      className={`trends-secret-field${tokenVisible ? " trends-secret-field--visible" : ""}`}
                    >
                      <input
                        className="trends-input"
                        name="trendsToken"
                        type={tokenVisible ? "text" : "password"}
                        autoComplete="new-password"
                        value={tokenValue}
                        placeholder="Paste the API token"
                        onChange={(event) => {
                          setTokenValue(event.target.value);
                          setTokenChanged(true);
                        }}
                      />
                      <input
                        type="hidden"
                        name="tokenChanged"
                        value={String(tokenChanged)}
                      />
                      <button
                        type="button"
                        className="trends-secret-toggle"
                        aria-label={
                          tokenVisible ? "Hide API token" : "Show API token"
                        }
                        onClick={() => setTokenVisible((visible) => !visible)}
                      >
                        {tokenVisible ? (
                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <path d="m3.1 1.7 15.2 15.2-1.4 1.4-2.6-2.6A8.3 8.3 0 0 1 10 17c-4.3 0-7.2-3.7-8-5.1a2.8 2.8 0 0 1 0-2.8A13 13 0 0 1 4.3 6L1.7 3.1l1.4-1.4Zm2.6 5.7A10.8 10.8 0 0 0 3.8 10c-.2.3-.2.7 0 1 1 1.6 3.3 4 6.2 4a6 6 0 0 0 2.8-.8l-1.5-1.5A4.1 4.1 0 0 1 7.3 8.7L5.7 7.4Zm4.5-4.4c4.1.1 6.9 3.7 7.8 5.1.5.9.5 1.9 0 2.8-.3.5-.8 1.2-1.5 2l-1.4-1.4c.5-.6.9-1.1 1.1-1.5.2-.3.2-.7 0-1-1-1.6-3.3-4-6.2-4h-.1L8 3.1c.7-.1 1.4-.2 2.2-.1Zm-.1 4a3 3 0 0 1 2.9 2.9L10.1 7Z" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <path d="M10 3.5c-4.3 0-7.2 3.7-8 5.1a2.8 2.8 0 0 0 0 2.8c.8 1.4 3.7 5.1 8 5.1s7.2-3.7 8-5.1a2.8 2.8 0 0 0 0-2.8c-.8-1.4-3.7-5.1-8-5.1Zm0 10.6a4.1 4.1 0 1 1 0-8.2 4.1 4.1 0 0 1 0 8.2Zm0-2.1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
                          </svg>
                        )}
                      </button>
                    </span>
                    <span className="trends-secret-help">
                      <span className="trends-secret-help__status">
                        {tokenConfigured
                          ? "✓ Token securely saved"
                          : "Token required"}
                      </span>
                      <small>Encrypted before storage.</small>
                    </span>
                  </label>
                  <div className="trends-form-grid trends-form-grid--two">
                    <label className="trends-field">
                      Main product markup (%)
                      <input
                        className="trends-input"
                        name="globalMarkupPercent"
                        type="number"
                        min="0"
                        max="1000"
                        step="0.01"
                        required
                        defaultValue={settings.globalMarkupPercent}
                      />
                      <small>Default markup for main product prices.</small>
                    </label>
                    <label className="trends-field">
                      Additional product markup (%)
                      <input
                        className="trends-input"
                        name="additionalMarkupPercent"
                        type="number"
                        min="0"
                        max="1000"
                        step="0.01"
                        required
                        defaultValue={settings.additionalMarkupPercent}
                      />
                      <small>
                        Default markup for branding and setup costs.
                      </small>
                    </label>
                  </div>
                  <label className="trends-field">
                    Inventory location
                    <select
                      className="trends-input"
                      name="inventoryLocationId"
                      defaultValue={settings.inventoryLocationId || ""}
                    >
                      <option value="">
                        Automatically use the primary location
                      </option>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Stock quantities for every synced variant are assigned
                      here.
                    </small>
                  </label>
                  <div>
                    <s-button
                      type="submit"
                      variant="primary"
                      loading={busy}
                      disabled={busy}
                    >
                      Save settings
                    </s-button>
                  </div>
                </div>
              </Form>
            </div>
          </div>
          <div style={{ display: "grid", gap: 16 }}>
            <div className="trends-card">
              <div className="trends-card__header">
                <div>
                  <h3>Test connection</h3>
                  <p>Verify the saved credentials with a real product.</p>
                </div>
              </div>
              <div className="trends-card__body">
                <Form method="post">
                  <input type="hidden" name="intent" value="test" />
                  <div className="trends-form-grid">
                    <label className="trends-field">
                      Six-digit product code
                      <input
                        className="trends-input"
                        name="testProductCode"
                        defaultValue="125567"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                      />
                    </label>
                    <s-button type="submit" disabled={!tokenConfigured || busy}>
                      Test TRENDS API
                    </s-button>
                  </div>
                </Form>
              </div>
            </div>
            <div className="trends-help">
              <strong>How pricing works</strong>The first TRENDS quantity-break
              price is used as the Shopify variant price. Your global markup is
              added automatically; product-level markup overrides it.
            </div>
            <div className="trends-help">
              <strong>Automatic publishing status</strong>A TRENDS active
              product is active in Shopify, while a TRENDS draft or inactive
              product remains draft. If TRENDS provides no status, the product
              is active by default.
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}
export const headers = (args) => boundary.headers(args);
