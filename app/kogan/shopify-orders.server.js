import { shopifyGraphql } from "./shopify-products.server";

function money(amount, currencyCode) {
  return { shopMoney: { amount: Number(amount || 0).toFixed(2), currencyCode } };
}

function cleanProvince(code) {
  // Kogan sends ISO 3166-2 codes such as "AU-NSW"; Shopify expects "NSW".
  return code ? String(code).split("-").pop() : undefined;
}

function toMailingAddress(address) {
  if (!address) return undefined;

  const result = {
    firstName: address.FirstName || undefined,
    lastName: address.LastName || undefined,
    company: address.CompanyName || undefined,
    address1: address.AddressLine1 || undefined,
    address2: address.AddressLine2 || undefined,
    city: address.City || undefined,
    provinceCode: cleanProvince(address.StateOrProvince),
    countryCode: address.Country || undefined,
    zip: address.PostalCode || undefined,
    phone: address.DaytimePhone || address.EveningPhone || undefined,
  };

  return Object.values(result).some(Boolean) ? result : undefined;
}

/**
 * The buyer's name on a Kogan order, or null when there is none.
 */
function customerNames(order) {
  const address = order.ShippingAddress || order.BuyerAddress || {};
  const firstName = address.FirstName?.trim() || undefined;
  const lastName = address.LastName?.trim() || undefined;
  return firstName || lastName ? { firstName, lastName } : null;
}

/** The first message Shopify gave, without the raw request details. */
function shortMessage(error) {
  return error?.body?.errors?.[0]?.message || error?.message || String(error);
}

/**
 * Creates a Shopify customer from a name. Kogan does not share the buyer's
 * email address, and Shopify can only create a customer together with an
 * order when an email is given, so the customer is created on its own first.
 * A phone number is not used: Shopify allows each number on one customer only.
 * Returns the customer ID.
 */
export async function createCustomer(admin, { firstName, lastName }) {
  const created = await shopifyGraphql(
    admin,
    `#graphql
      mutation KoganCustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { input: { firstName, lastName, tags: ["Kogan"] } },
  );
  const errors = created.customerCreate.userErrors;
  if (errors.length > 0 || !created.customerCreate.customer) {
    throw new Error(`Shopify could not create the customer: ${errors.map((error) => error.message).join("; ")}`);
  }
  return created.customerCreate.customer.id;
}

async function assignCustomer(admin, orderId, customerId) {
  const set = await shopifyGraphql(
    admin,
    `#graphql
      mutation KoganOrderCustomerSet($orderId: ID!, $customerId: ID!) {
        orderCustomerSet(orderId: $orderId, customerId: $customerId) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    { orderId, customerId },
  );
  const errors = set.orderCustomerSet.userErrors;
  if (errors.length > 0) {
    throw new Error(`Shopify could not add the customer to the order: ${errors.map((error) => error.message).join("; ")}`);
  }
}

const scopeCache = new Map();
const SCOPE_CACHE_MS = 10 * 60 * 1000;

/**
 * Whether the app may create customers in this store (the write_customers
 * permission). Checked first, so an order is never sent with a customer that
 * Shopify would refuse. Cached for a few minutes per store.
 */
export async function canWriteCustomers(admin, shop) {
  const cached = scopeCache.get(shop);
  if (cached && Date.now() - cached.at < SCOPE_CACHE_MS) return cached.allowed;

  let allowed = false;
  try {
    const data = await shopifyGraphql(
      admin,
      `#graphql
        query KoganAppScopes {
          currentAppInstallation {
            accessScopes {
              handle
            }
          }
        }
      `,
    );
    allowed = (data.currentAppInstallation?.accessScopes || []).some((scope) => scope.handle === "write_customers");
  } catch {
    allowed = false;
  }

  scopeCache.set(shop, { allowed, at: Date.now() });
  return allowed;
}

function isCustomerProblem(text) {
  return /customer|protected|not approved|access denied/i.test(text);
}

function withoutCustomer(input) {
  const copy = { ...input };
  delete copy.customer;
  return copy;
}

function withoutPhones(input) {
  const strip = (address) => (address ? { ...address, phone: undefined } : address);
  return {
    ...input,
    shippingAddress: strip(input.shippingAddress),
    billingAddress: strip(input.billingAddress),
  };
}

/**
 * Creates a Shopify order for a Kogan order. Kogan has already taken payment,
 * so the order is recorded as paid through a "Kogan" gateway, and stock is
 * deducted even if the product does not allow overselling.
 */
export async function createOrderFromKogan(admin, { order, variantsBySku, tags, withCustomer = false }) {
  const currency = order.Currency;

  const lineItems = order.Items.map((item) => {
    const variant = variantsBySku.get(item.SellerSku);
    const line = {
      quantity: item.Quantity,
      priceSet: money(item.UnitPrice, currency),
      sku: item.SellerSku,
    };

    if (variant) {
      return { ...line, variantId: variant.variantId };
    }

    return {
      ...line,
      title: `Kogan item ${item.SellerSku}`,
      requiresShipping: true,
      taxable: true,
    };
  });

  const shippingAddress = toMailingAddress(order.ShippingAddress);
  const input = {
    currency,
    processedAt: order.OrderDateUtc,
    sourceIdentifier: order.ID,
    note: `Kogan order ${order.OrderLabel || order.ID}`,
    tags,
    taxesIncluded: true,
    lineItems,
    shippingAddress,
    billingAddress: toMailingAddress(order.BuyerAddress) || shippingAddress,
    shippingLines: [
      {
        title: `Kogan ${order.RequestedShippingMethod || "Standard"} shipping`,
        code: "KOGAN",
        priceSet: money(order.TotalShippingPrice, currency),
      },
    ],
    customAttributes: [
      { key: "Kogan order", value: String(order.OrderLabel || order.ID) },
      { key: "Kogan order ID", value: String(order.ID) },
    ],
    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        gateway: "Kogan",
        processedAt: order.OrderDateUtc,
        amountSet: money(order.TotalPrice, currency),
      },
    ],
  };

  let customerProblem = null;
  let customerId = null;
  const names = withCustomer ? customerNames(order) : null;
  if (names) {
    try {
      customerId = await createCustomer(admin, names);
      input.customer = { toAssociate: { id: customerId } };
    } catch (error) {
      customerProblem = shortMessage(error);
    }
  }

  const mutation = `#graphql
    mutation CreateKoganOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order {
          id
          name
          customer {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const options = {
    inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
    sendReceipt: false,
    sendFulfillmentReceipt: false,
  };

  const send = async (orderInput) => {
    try {
      return await shopifyGraphql(admin, mutation, { order: orderInput, options });
    } catch (error) {
      // When the order was created but a field of the answer could not be
      // read, the order is used as it is; sending again would duplicate it.
      const created = error.body?.data?.orderCreate;
      if (created?.order) return { orderCreate: { ...created, userErrors: created.userErrors || [] } };

      // Rejected before anything was created (no order in the answer) because
      // of the customer: the order is created without one.
      if (orderInput.customer && error.body && !created && isCustomerProblem(error.message)) {
        customerProblem = shortMessage(error);
        return send(withoutCustomer(orderInput));
      }
      throw error;
    }
  };

  let current = input;
  let data = await send(current);
  let errors = data.orderCreate.userErrors;

  // A rejected customer must not stop the order.
  if (current.customer && errors.some((error) => isCustomerProblem(`${(error.field || []).join(".")} ${error.message}`))) {
    customerProblem = errors.map((error) => error.message).join("; ");
    current = withoutCustomer(current);
    data = await send(current);
    errors = data.orderCreate.userErrors;
  }

  // Kogan phone numbers are free text; retry without them if Shopify rejects one.
  if (errors.some((error) => /phone/i.test(`${error.field} ${error.message}`))) {
    data = await send(withoutPhones(current));
    errors = data.orderCreate.userErrors;
  }

  if (errors.length > 0) {
    throw new Error(
      `Shopify could not create the order: ${errors
        .map((error) => `${(error.field || []).join(".")} ${error.message}`.trim())
        .join("; ")}`,
    );
  }

  const created = data.orderCreate.order;
  let attached = created.customer?.id || null;

  // The order was created without the customer: add the customer that was
  // already created, so no second customer is made for the same buyer.
  if (!attached && customerId) {
    try {
      await assignCustomer(admin, created.id, customerId);
      attached = customerId;
      customerProblem = null;
    } catch (error) {
      customerProblem = customerProblem || shortMessage(error);
    }
  }

  return { ...created, customerId: attached, customerProblem };
}

/**
 * Creates a customer from a name and sets it on an existing order, unless the
 * order already has one. Returns the customer ID.
 */
export async function setOrderCustomer(admin, orderId, { firstName, lastName }) {
  const current = await shopifyGraphql(
    admin,
    `#graphql
      query KoganOrderCustomer($id: ID!) {
        order(id: $id) {
          id
          customer {
            id
          }
        }
      }
    `,
    { id: orderId },
  );
  if (!current.order) throw new Error("The Shopify order no longer exists.");
  if (current.order.customer?.id) return current.order.customer.id;

  const customerId = await createCustomer(admin, { firstName, lastName });
  await assignCustomer(admin, orderId, customerId);
  return customerId;
}

/**
 * The fulfillments of a Shopify order in the shape of a fulfillments/create
 * webhook, so a dispatch that failed can be sent to Kogan again.
 */
export async function getOrderFulfillments(admin, orderId) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      query KoganOrderFulfillments($id: ID!) {
        order(id: $id) {
          legacyResourceId
          fulfillments(first: 50) {
            legacyResourceId
            status
            createdAt
            trackingInfo(first: 5) {
              company
              number
              url
            }
            fulfillmentLineItems(first: 100) {
              nodes {
                quantity
                lineItem {
                  sku
                }
              }
            }
          }
        }
      }
    `,
    { id: orderId },
  );
  if (!data.order) return [];

  return data.order.fulfillments.map((fulfillment) => {
    const tracking = fulfillment.trackingInfo?.[0] || {};
    return {
      id: fulfillment.legacyResourceId,
      order_id: data.order.legacyResourceId,
      status: String(fulfillment.status || "").toLowerCase(),
      created_at: fulfillment.createdAt,
      tracking_company: tracking.company || null,
      tracking_number: tracking.number || null,
      tracking_url: tracking.url || null,
      line_items: fulfillment.fulfillmentLineItems.nodes.map((line) => ({
        sku: line.lineItem?.sku || null,
        quantity: line.quantity,
      })),
    };
  });
}

/**
 * Active Shopify locations, for choosing where Kogan orders ship from.
 */
export async function listLocations(admin) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      query KoganLocations {
        locations(first: 50) {
          nodes {
            id
            name
            isActive
          }
        }
      }
    `,
  );
  return data.locations.nodes.filter((location) => location.isActive).map(({ id, name }) => ({ id, name }));
}

const MOVABLE_STATUSES = new Set(["OPEN", "SCHEDULED"]);

/**
 * Assigns the unfulfilled items of an order to a Shopify location, so the
 * shipping app that handles that location (for example eShip) picks the
 * order up. Returns how many fulfillment orders were moved; a problem
 * Shopify reports is thrown.
 */
export async function moveOrderToLocation(admin, orderId, locationId) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      query KoganOrderLocations($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 20) {
            nodes {
              id
              status
              assignedLocation {
                location {
                  id
                }
              }
            }
          }
        }
      }
    `,
    { id: orderId },
  );

  let moved = 0;
  for (const fulfillmentOrder of data.order?.fulfillmentOrders?.nodes || []) {
    if (!MOVABLE_STATUSES.has(fulfillmentOrder.status)) continue;
    if (fulfillmentOrder.assignedLocation?.location?.id === locationId) continue;

    const result = await shopifyGraphql(
      admin,
      `#graphql
        mutation KoganFulfillmentOrderMove($id: ID!, $newLocationId: ID!) {
          fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
            movedFulfillmentOrder {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      { id: fulfillmentOrder.id, newLocationId: locationId },
    );
    const errors = result.fulfillmentOrderMove.userErrors;
    if (errors.length > 0) {
      throw new Error(`Shopify could not move the order to the chosen location: ${errors.map((error) => error.message).join("; ")}`);
    }
    moved += 1;
  }
  return moved;
}

const SHIPPING_COMPARE_QUERY = `#graphql
  fragment KoganShippingDetails on Order {
    id
    name
    createdAt
    sourceName
    tags
    email
    requiresShipping
    displayFinancialStatus
    displayFulfillmentStatus
    channelInformation {
      displayName
      app {
        title
      }
    }
    shippingAddress {
      city
      countryCodeV2
    }
    shippingLine {
      title
    }
    fulfillmentOrders(first: 5) {
      nodes {
        status
        assignedLocation {
          name
        }
        deliveryMethod {
          methodType
        }
      }
    }
  }

  query KoganShippingCompare($id: ID!) {
    kogan: order(id: $id) {
      ...KoganShippingDetails
    }
    others: orders(first: 1, sortKey: CREATED_AT, reverse: true, query: "-tag:'Kogan order'") {
      nodes {
        ...KoganShippingDetails
      }
    }
  }
`;

function describeShipping(order) {
  if (!order) return null;
  const fulfillmentOrders = order.fulfillmentOrders?.nodes || [];
  const unique = (values) => [...new Set(values.filter(Boolean))].join(", ") || "—";
  return {
    name: order.name,
    createdAt: order.createdAt,
    channel: order.channelInformation?.displayName || order.channelInformation?.app?.title || order.sourceName || "—",
    paymentStatus: order.displayFinancialStatus || "—",
    fulfillmentStatus: order.displayFulfillmentStatus || "—",
    location: unique(fulfillmentOrders.map((item) => item.assignedLocation?.name)),
    deliveryMethod: unique(fulfillmentOrders.map((item) => item.deliveryMethod?.methodType)),
    fulfillmentOrderStatus: unique(fulfillmentOrders.map((item) => item.status)),
    shippingAddress: order.shippingAddress ? `${order.shippingAddress.city || ""} ${order.shippingAddress.countryCodeV2 || ""}`.trim() : "Missing",
    shippingMethod: order.shippingLine?.title || "—",
    requiresShipping: order.requiresShipping ? "Yes" : "No",
    email: order.email ? "Yes" : "No",
    tags: (order.tags || []).join(", ") || "—",
  };
}

/**
 * Shipping-related details of a Kogan order and of the newest order from
 * another channel, side by side, to see why a shipping app such as eShip
 * imports one and not the other.
 */
export async function compareOrderShipping(admin, koganOrderId) {
  const data = await shopifyGraphql(admin, SHIPPING_COMPARE_QUERY, { id: koganOrderId });
  return { kogan: describeShipping(data.kogan), other: describeShipping(data.others?.nodes?.[0]) };
}

export async function getOrderState(admin, orderId) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      query KoganOrderState($id: ID!) {
        order(id: $id) {
          id
          cancelledAt
          displayFulfillmentStatus
        }
      }
    `,
    { id: orderId },
  );

  return data.order;
}

export async function cancelShopifyOrder(admin, orderId, staffNote) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      mutation CancelKoganOrder($orderId: ID!, $staffNote: String) {
        orderCancel(
          orderId: $orderId
          reason: CUSTOMER
          restock: true
          notifyCustomer: false
          refundMethod: { originalPaymentMethodsRefund: false }
          staffNote: $staffNote
        ) {
          orderCancelUserErrors {
            field
            message
          }
        }
      }
    `,
    { orderId, staffNote },
  );

  const errors = data.orderCancel.orderCancelUserErrors;
  if (errors.length > 0) {
    throw new Error(`Shopify could not cancel the order: ${errors.map((error) => error.message).join("; ")}`);
  }
}

const FULFILLABLE_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);

async function getFulfillableLines(admin, orderId) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      query KoganFulfillmentOrders($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 20) {
            nodes {
              id
              status
              lineItems(first: 100) {
                nodes {
                  id
                  remainingQuantity
                  lineItem {
                    sku
                  }
                }
              }
            }
          }
        }
      }
    `,
    { id: orderId },
  );

  return (data.order?.fulfillmentOrders?.nodes || [])
    .filter((fulfillmentOrder) => FULFILLABLE_STATUSES.has(fulfillmentOrder.status))
    .map((fulfillmentOrder) => ({
      id: fulfillmentOrder.id,
      lines: fulfillmentOrder.lineItems.nodes
        .filter((line) => line.remainingQuantity > 0)
        .map((line) => ({ id: line.id, sku: line.lineItem?.sku?.trim() || "", remaining: line.remainingQuantity })),
    }));
}

/**
 * Marks items of a Shopify order as fulfilled with the carrier and tracking
 * number Kogan reported. `items` is a list of { sku, quantity }. Customers are
 * not notified, because Kogan already informs its own customers.
 *
 * Returns the IDs of the fulfillments that were created.
 */
export async function fulfillOrderItems(admin, orderId, items, tracking = {}) {
  const fulfillmentOrders = await getFulfillableLines(admin, orderId);
  const byFulfillmentOrder = new Map();

  for (const item of items) {
    let left = item.quantity;
    for (const fulfillmentOrder of fulfillmentOrders) {
      for (const line of fulfillmentOrder.lines) {
        if (left <= 0) break;
        if (line.sku !== item.sku || line.remaining <= 0) continue;

        const quantity = Math.min(left, line.remaining);
        line.remaining -= quantity;
        left -= quantity;

        const entries = byFulfillmentOrder.get(fulfillmentOrder.id) || [];
        entries.push({ id: line.id, quantity });
        byFulfillmentOrder.set(fulfillmentOrder.id, entries);
      }
    }
  }

  if (byFulfillmentOrder.size === 0) {
    throw new Error("Shopify has nothing left to fulfil for these items.");
  }

  const trackingInfo = tracking.number
    ? { number: tracking.number, ...(tracking.company ? { company: tracking.company } : {}) }
    : null;
  const fulfillmentIds = [];

  for (const [fulfillmentOrderId, fulfillmentOrderLineItems] of byFulfillmentOrder) {
    const data = await shopifyGraphql(
      admin,
      `#graphql
        mutation FulfillKoganOrder($fulfillment: FulfillmentInput!, $message: String) {
          fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
            fulfillment {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        message: "Dispatched on Kogan",
        fulfillment: {
          notifyCustomer: false,
          ...(trackingInfo ? { trackingInfo } : {}),
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId, fulfillmentOrderLineItems }],
        },
      },
    );

    const errors = data.fulfillmentCreate.userErrors;
    if (errors.length > 0) {
      throw new Error(`Shopify could not fulfil the order: ${errors.map((error) => error.message).join("; ")}`);
    }
    fulfillmentIds.push(data.fulfillmentCreate.fulfillment.id);
  }

  return fulfillmentIds;
}
