import { createTemporaryConfiguredVariant } from "../lib/temporary-variant.server";
import { authenticate, unauthenticated } from "../shopify.server";

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop)
    return json({ ok: false, message: "Store is not connected" }, 401);
  try {
    const input = await request.json();
    const { admin } = await unauthenticated.admin(session.shop);
    const result = await createTemporaryConfiguredVariant({
      admin,
      shop: session.shop,
      input,
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return json(
      {
        ok: false,
        message:
          error instanceof Error ? error.message : "Configuration failed",
      },
      400,
    );
  }
};

export const loader = () =>
  json({ ok: false, message: "Use POST for this endpoint" }, 405);
