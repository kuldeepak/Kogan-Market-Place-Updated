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
export async function createOrderFromKogan(admin, { order, variantsBySku, tags }) {
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

  const mutation = `#graphql
    mutation CreateKoganOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order {
          id
          name
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

  let data = await shopifyGraphql(admin, mutation, { order: input, options });
  let errors = data.orderCreate.userErrors;

  // Kogan phone numbers are free text; retry without them if Shopify rejects one.
  if (errors.some((error) => /phone/i.test(`${error.field} ${error.message}`))) {
    data = await shopifyGraphql(admin, mutation, { order: withoutPhones(input), options });
    errors = data.orderCreate.userErrors;
  }

  if (errors.length > 0) {
    throw new Error(
      `Shopify could not create the order: ${errors
        .map((error) => `${(error.field || []).join(".")} ${error.message}`.trim())
        .join("; ")}`,
    );
  }

  return data.orderCreate.order;
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
