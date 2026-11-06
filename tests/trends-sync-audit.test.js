import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrendsSyncAudit,
  productMatchesTrendsIdentity,
} from "../app/lib/trends-sync-audit.js";

const source = JSON.stringify({ code: 126879, name: "Compadre Bottle" });

test("validates main and master ownership using role and source code", () => {
  const main = {
    id: "main-1",
    tags: ["TRENDS", "TRENDS Main Product", "126879"],
    productType: "Drinkware",
    variants: { nodes: [{ sku: "126879" }] },
  };
  const master = {
    id: "master-1",
    tags: ["TRENDS", "TRENDS Master Product", "126879"],
    productType: "Configured order master",
    variants: { nodes: [{ sku: "CFG-CORE-126879-25" }] },
  };
  assert.equal(
    productMatchesTrendsIdentity({
      product: main,
      sourceCode: 126879,
      expectedSkus: ["126879"],
      role: "main",
    }),
    true,
  );
  assert.equal(
    productMatchesTrendsIdentity({
      product: {
        ...main,
        id: "wrong-main",
        tags: ["TRENDS", "TRENDS Main Product", "999999"],
      },
      sourceCode: 126879,
      expectedSkus: ["126879"],
      role: "main",
    }),
    false,
    "a colliding SKU must not allow another source-code product to be reused",
  );
  assert.equal(
    productMatchesTrendsIdentity({
      product: master,
      sourceCode: 126879,
      role: "main",
    }),
    false,
  );
  assert.equal(
    productMatchesTrendsIdentity({
      product: master,
      sourceCode: 126879,
      role: "master",
    }),
    true,
  );
});

test("audit selects missing and incorrectly linked products for repair", () => {
  const rows = [
    {
      id: "row-1",
      productCode: "126879",
      title: "Compadre Bottle",
      trendsDataJson: source,
      status: "SYNCED",
      lastError: null,
      shopifyProductId: "wrong-main",
      shopifyMasterProductId: "master-1",
    },
    {
      id: "row-2",
      productCode: "125054",
      title: "Wine Bag",
      trendsDataJson: JSON.stringify({ code: 125054, name: "Wine Bag" }),
      status: "SYNCED",
      lastError: null,
      shopifyProductId: "missing-main",
      shopifyMasterProductId: "master-2",
    },
  ];
  const shopifyProducts = [
    {
      id: "main-1",
      title: "Compadre Bottle",
      tags: ["TRENDS", "TRENDS Main Product", "126879"],
      productType: "Drinkware",
      configuration: { value: "{}" },
    },
    {
      id: "master-1",
      title: "Compadre master",
      tags: ["TRENDS", "TRENDS Master Product", "126879"],
      productType: "Configured order master",
    },
    {
      id: "master-2",
      title: "Wine Bag master",
      tags: ["TRENDS", "TRENDS Master Product", "125054"],
      productType: "Configured order master",
    },
  ];
  const audit = buildTrendsSyncAudit({ rows, shopifyProducts });
  assert.equal(audit.checked, 2);
  assert.equal(audit.healthy, 0);
  assert.equal(audit.repairable, 2);
  assert.match(audit.issues[0].reason, /Saved main product link is incorrect/);
  assert.match(audit.issues[1].reason, /Main storefront product is missing/);
});

test("audit leaves fully linked products healthy", () => {
  const rows = [
    {
      id: "row-1",
      productCode: "126879",
      title: "Compadre Bottle",
      trendsDataJson: source,
      status: "SYNCED",
      lastError: null,
      shopifyProductId: "main-1",
      shopifyMasterProductId: "master-1",
    },
  ];
  const shopifyProducts = [
    {
      id: "main-1",
      status: "ACTIVE",
      tags: ["TRENDS", "TRENDS Main Product", "126879"],
      productType: "Drinkware",
      configuration: { value: "{}" },
    },
    {
      id: "master-1",
      tags: ["TRENDS", "TRENDS Master Product", "126879"],
      productType: "Configured order master",
    },
  ];
  const audit = buildTrendsSyncAudit({ rows, shopifyProducts });
  assert.equal(audit.healthy, 1);
  assert.equal(audit.mainProducts, 1);
  assert.equal(audit.activeMainProducts, 1);
  assert.deepEqual(audit.issues, []);
});

test("audit counts multiple sheet SKUs for one TRENDS product only once", () => {
  const rows = [
    {
      id: "row-white",
      productCode: "126857",
      resolvedProductCode: "126879",
      trendsDataJson: source,
      status: "SYNCED",
      shopifyProductId: "main-1",
      shopifyMasterProductId: "master-1",
    },
    {
      id: "row-black",
      productCode: "126864",
      resolvedProductCode: "126879",
      trendsDataJson: source,
      status: "SYNCED",
      shopifyProductId: "main-1",
      shopifyMasterProductId: "master-1",
    },
  ];
  const shopifyProducts = [
    {
      id: "main-1",
      status: "ACTIVE",
      tags: ["TRENDS", "TRENDS Main Product", "126879"],
      productType: "Drinkware",
      configuration: { value: "{}" },
    },
    {
      id: "master-1",
      tags: ["TRENDS", "TRENDS Master Product", "126879"],
      productType: "Configured order master",
    },
  ];

  const audit = buildTrendsSyncAudit({ rows, shopifyProducts });

  assert.equal(audit.checked, 1);
  assert.equal(audit.healthy, 1);
  assert.equal(audit.mainProducts, 1);
  assert.deepEqual(audit.issues, []);
});

test("audit reports duplicate Shopify mains separately from unique products", () => {
  const rows = [
    {
      id: "row-1",
      productCode: "126879",
      trendsDataJson: source,
      status: "SYNCED",
      shopifyProductId: "main-1",
      shopifyMasterProductId: "master-1",
    },
  ];
  const shopifyProducts = [
    {
      id: "main-1",
      status: "ACTIVE",
      tags: ["TRENDS", "TRENDS Main Product", "126879"],
      configuration: { value: "{}" },
    },
    {
      id: "main-duplicate",
      status: "ACTIVE",
      tags: ["TRENDS", "TRENDS Main Product", "126879"],
      configuration: { value: "{}" },
    },
    {
      id: "master-1",
      tags: ["TRENDS", "TRENDS Master Product", "126879"],
      productType: "Configured order master",
    },
  ];

  const audit = buildTrendsSyncAudit({ rows, shopifyProducts });

  assert.equal(audit.mainProducts, 1);
  assert.equal(audit.activeMainProducts, 1);
  assert.equal(audit.duplicateMainProducts, 1);
  assert.equal(audit.issues.length, 1);
  assert.match(audit.issues[0].reason, /Multiple main products/);
  assert.equal(audit.issues[0].canSync, false);
});
