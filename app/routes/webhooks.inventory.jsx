import { authenticate } from "../shopify.server";
import { scheduleInventoryPush } from "../kogan/sync.server";

/**
 * Stock changes do not always trigger products/update, so inventory level
 * updates are watched separately and mapped back to their linked product.
 */
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);

  if (payload?.inventory_item_id) {
    scheduleInventoryPush(
      shop,
      `gid://shopify/InventoryItem/${payload.inventory_item_id}`,
    ).catch((error) => console.error("Kogan inventory handling failed:", error));
  }

  return new Response();
};
