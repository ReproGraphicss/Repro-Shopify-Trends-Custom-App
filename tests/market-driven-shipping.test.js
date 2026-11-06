import assert from "node:assert/strict";
import test from "node:test";
import { getShippingConfiguration } from "../app/lib/shipping-compatibility.server.js";

const response = (data) => ({
  json: async () => ({ data }),
});

test("market-driven stores never read merchant delivery profiles", async () => {
  const operations = [];
  const admin = {
    graphql: async (query) => {
      operations.push(query);
      return response({
        shop: { features: { marketDrivenShipping: true } },
      });
    },
  };

  const configuration = await getShippingConfiguration(admin);

  assert.deepEqual(configuration, {
    marketDrivenShipping: true,
    profiles: [],
  });
  assert.equal(operations.length, 1);
  assert.doesNotMatch(operations[0], /deliveryProfiles/);
});

test("legacy stores still load merchant delivery profiles", async () => {
  let calls = 0;
  const admin = {
    graphql: async (query) => {
      calls += 1;
      if (query.includes("TrendsShippingModel")) {
        return response({
          shop: { features: { marketDrivenShipping: false } },
        });
      }
      return response({
        deliveryProfiles: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { id: "custom", name: "TRENDS", default: false },
            { id: "general", name: "General", default: true },
          ],
        },
      });
    },
  };

  const configuration = await getShippingConfiguration(admin);

  assert.equal(configuration.marketDrivenShipping, false);
  assert.deepEqual(
    configuration.profiles.map((profile) => profile.id),
    ["general", "custom"],
  );
  assert.equal(calls, 2);
});

test("unknown shipping mode fails closed without reading merchant profiles", async () => {
  for (const features of [{}, { marketDrivenShipping: null }, { marketDrivenShipping: "false" }]) {
    let calls = 0;
    const admin = { graphql: async () => {
      calls += 1;
      return response({ shop: { features } });
    } };
    await assert.rejects(getShippingConfiguration(admin), /could not be verified/);
    assert.equal(calls, 1);
  }
});

test("failed mode detection is retried rather than cached", async () => {
  let calls = 0;
  const admin = { graphql: async () => {
    calls += 1;
    if (calls === 1) return { json: async () => ({ errors: [{ message: "Unavailable" }] }) };
    return response({ shop: { features: { marketDrivenShipping: true } } });
  } };
  await assert.rejects(getShippingConfiguration(admin), /Unavailable/);
  assert.equal((await getShippingConfiguration(admin)).marketDrivenShipping, true);
  assert.equal(calls, 2);
});

test("legacy profiles include subsequent pages", async () => {
  const cursors = [];
  const admin = { graphql: async (query, options) => {
    if (query.includes("TrendsShippingModel")) {
      return response({ shop: { features: { marketDrivenShipping: false } } });
    }
    const after = options.variables.after;
    cursors.push(after);
    return response({ deliveryProfiles: {
      nodes: after
        ? [{ id: "general", name: "General", default: true }]
        : [{ id: "custom", name: "Custom", default: false }],
      pageInfo: { hasNextPage: !after, endCursor: after ? "last" : "next" },
    } });
  } };
  const configuration = await getShippingConfiguration(admin);
  assert.deepEqual(cursors, [null, "next"]);
  assert.deepEqual(configuration.profiles.map(({ id }) => id), ["general", "custom"]);
});

test("incomplete legacy profile data is rejected", async () => {
  const admin = { graphql: async (query) => response(
    query.includes("TrendsShippingModel")
      ? { shop: { features: { marketDrivenShipping: false } } }
      : {},
  ) };
  await assert.rejects(getShippingConfiguration(admin), /profiles could not be loaded/);
});
