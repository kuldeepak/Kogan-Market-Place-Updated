import { authenticate } from "../shopify.server";
import { handleProductDeleted, schedulePush } from "../kogan/sync.server";

/**
 * Receives products/create, products/update and products/delete. The work is
 * queued and the webhook is acknowledged right away, because Shopify expects a
 * response within a few seconds.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const productId =
    payload?.admin_graphql_api_id || (payload?.id ? `gid://shopify/Product/${payload.id}` : null);

  if (!productId) {
    return new Response();
  }

  if (topic === "PRODUCTS_DELETE") {
    handleProductDeleted(shop, productId).catch((error) =>
      console.error(`Kogan delete handling failed for ${productId}:`, error),
    );
  } else {
    schedulePush(shop, productId, "webhook");
  }

  return new Response();
};
