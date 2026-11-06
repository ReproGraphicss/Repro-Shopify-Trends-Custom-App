const configurationCache = new WeakMap();
const CONFIGURATION_CACHE_MS = 30_000;

const loadShippingConfiguration = async (admin) => {
  const featureResponse = await admin.graphql(`#graphql
    query TrendsShippingModel {
      shop {
        features {
          marketDrivenShipping
        }
      }
    }
  `);
  const featureJson = await featureResponse.json();
  if (featureJson.errors?.length)
    throw new Error(
      featureJson.errors.map((error) => error.message).join("; "),
    );

  const marketDrivenShipping =
    featureJson.data?.shop?.features?.marketDrivenShipping;
  // An incomplete response must never authorize legacy shipping writes.
  if (typeof marketDrivenShipping !== "boolean") {
    throw new Error("Shopify shipping mode could not be verified. Please retry.");
  }
  if (marketDrivenShipping) {
    return {
      marketDrivenShipping: true,
      profiles: [],
    };
  }

  const profiles = [];
  let after = null;
  do {
    const response = await admin.graphql(`#graphql
      query TrendsShippingProfiles($after: String) {
        deliveryProfiles(first: 50, after: $after, merchantOwnedOnly: true) {
          nodes { id name default }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { variables: { after } });
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    const connection = json.data?.deliveryProfiles;
    if (!Array.isArray(connection?.nodes) || !connection.pageInfo) {
      throw new Error("Shopify shipping profiles could not be loaded. Please retry.");
    }
    profiles.push(...connection.nodes);
    const nextCursor = connection.pageInfo.endCursor;
    if (connection.pageInfo.hasNextPage && (!nextCursor || nextCursor === after)) {
      throw new Error("Shopify shipping profile pagination could not be completed.");
    }
    after = connection.pageInfo.hasNextPage ? nextCursor : null;
  } while (after);
  return {
    marketDrivenShipping: false,
    profiles: profiles.sort((a, b) =>
      a.default === b.default
        ? a.name.localeCompare(b.name)
        : a.default
          ? -1
          : 1,
    ),
  };
};

export async function getShippingConfiguration(admin) {
  const cached = configurationCache.get(admin);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = loadShippingConfiguration(admin).catch((error) => {
    configurationCache.delete(admin);
    throw error;
  });
  configurationCache.set(admin, {
    expiresAt: Date.now() + CONFIGURATION_CACHE_MS,
    promise,
  });
  return promise;
}

export async function getShippingProfiles(admin) {
  return (await getShippingConfiguration(admin)).profiles;
}
