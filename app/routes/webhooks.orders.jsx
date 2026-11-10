import { authenticate } from "../shopify.server";
import { handleFulfillmentCreated, handleOrderCancelled } from "../kogan/orders.server";

/**
 * Receives fulfillments/create, fulfillments/update and orders/cancelled.
 * Only orders that came from Kogan are acted on; every other order is
 * ignored. An update matters when tracking details are added to a
 * fulfillment after it was created; a fulfillment already sent to Kogan is
 * never sent twice.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const work =
    topic === "FULFILLMENTS_CREATE" || topic === "FULFILLMENTS_UPDATE"
      ? handleFulfillmentCreated(shop, payload)
      : topic === "ORDERS_CANCELLED"
        ? handleOrderCancelled(shop, payload)
        : null;

  work?.catch((error) => console.error(`Kogan ${topic} handling failed:`, error));

  return new Response();
};
