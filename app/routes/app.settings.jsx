import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { CategoryPicker } from "../components/category-picker";
import { authenticate } from "../shopify.server";
import { DEFAULT_API_BASE_URL, createKoganClient } from "../kogan/kogan-client.server";
import { categorySourceFor, resolveCategoryValue } from "../kogan/categories.server";
import { canWriteDraftOrders, listLocations } from "../kogan/shopify-orders.server";
import {
  scheduleFullKoganCheck,
  startCatalogueCheckJob,
  startKoganFirstJob,
  startLocationJob,
  startShippingJob,
} from "../kogan/sync.server";

/**
 * Sends the shipping option to every product on Kogan. Returns false when
 * another job is running, so the merchant can send it once that finishes.
 */
async function sendShipping(shop, mode) {
  const job = await startShippingJob(shop, mode);
  if (job.type !== "shipping") return false;
  await saveSettings(shop, { koganShipping: mode });
  return true;
}

function shippingMessage(started, mode, prefix = "") {
  return started
    ? `${prefix}Sending ${mode} shipping to Kogan for all products`
    : `${prefix}Another job is running. Click "Send ${mode} shipping to all products now" once it finishes`;
}

function apiHost(apiBaseUrl) {
  try {
    return new URL(apiBaseUrl || DEFAULT_API_BASE_URL).host;
  } catch {
    return null;
  }
}
import {
  KOGAN_FIRST_MAX_PERCENT,
  KOGAN_FIRST_MIN_PERCENT,
  ORDER_METHODS,
  SHIPPING_MODES,
  SUPPORTED_CURRENCIES,
  getSettings,
  hasEnvCredentials,
  koganFirstPercent,
  orderMethodOf,
  saveSettings,
  shippingModeOf,
} from "../kogan/store.server";

/**
 * Sends the Kogan FIRST discount from Settings to every listing on Kogan.
 * Returns false when another job is running.
 */
async function sendKoganFirst(shop) {
  const job = await startKoganFirstJob(shop);
  return job.type === "koganfirst";
}

function koganFirstMessage(started, percent, prefix = "") {
  if (!started) {
    return `${prefix}Another job is running. Click "Send Kogan FIRST prices to Kogan now" once it finishes`;
  }
  return percent
    ? `${prefix}Sending Kogan FIRST prices (${percent}% off) to all Kogan listings. Progress is shown on the Dashboard`
    : `${prefix}Removing Kogan FIRST prices set on single SKUs and resyncing all listings. Progress is shown on the Dashboard`;
}

const STOCK_LOCATIONS = ["AU", "NZ", "CN", "HK", "US", "UK"];
const STOCK_LOCATION_NAMES = {
  AU: "Australia",
  NZ: "New Zealand",
  CN: "China",
  HK: "Hong Kong",
  US: "United States",
  UK: "United Kingdom",
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const locations = await listLocations(admin).catch(() => []);
  const draftOrdersAllowed = await canWriteDraftOrders(admin, session.shop);
  const defaultCategoryRecord = settings.defaultCategory
    ? await resolveCategoryValue(categorySourceFor(settings).source, settings.defaultCategory).catch(() => null)
    : null;

  return {
    sellerId: settings.sellerId || "",
    hasSavedToken: Boolean(settings.sellerToken),
    apiBaseUrl: settings.apiBaseUrl || "",
    envFallback: hasEnvCredentials(),
    defaultApiBaseUrl: DEFAULT_API_BASE_URL,
    syncTag: settings.syncTag,
    currency: settings.currency,
    defaultCategory: settings.defaultCategory || "",
    defaultCategoryPath: defaultCategoryRecord?.display || "",
    handlingDays: settings.handlingDays,
    productLocation: settings.productLocation || "",
    koganShipping: shippingModeOf(settings),
    autoSyncEnabled: settings.autoSyncEnabled,
    createOnKogan: settings.createOnKogan,
    zeroStockOnDelete: settings.zeroStockOnDelete,
    importAsActive: settings.importAsActive,
    autoGenerateSkus: settings.autoGenerateSkus,
    orderSyncEnabled: settings.orderSyncEnabled,
    orderSyncMinutes: settings.orderSyncMinutes,
    importDispatchedOrders: settings.importDispatchedOrders,
    dispatchCarrier: settings.dispatchCarrier || "",
    koganOrderLocation: settings.koganOrderLocation || "",
    locations,
    koganFirstDiscount: koganFirstPercent(settings) || "",
    koganFirstLimits: { min: KOGAN_FIRST_MIN_PERCENT, max: KOGAN_FIRST_MAX_PERCENT },
    koganOrderMethod: orderMethodOf(settings),
    draftOrdersAllowed,
    dispatchedOrdersFrom: settings.dispatchedOrdersFrom
      ? new Date(settings.dispatchedOrdersFrom).toISOString().slice(0, 10)
      : "",
  };
};

// Returns a Date, null for an empty value, or undefined when the text is not a date.
function parseDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readForm(formData, current) {
  const text = (name) => String(formData.get(name) ?? "").trim();
  const token = text("sellerToken");

  return {
    sellerId: text("sellerId") || null,
    sellerToken: token || current.sellerToken || null,
    apiBaseUrl: text("apiBaseUrl") || null,
    syncTag: text("syncTag"),
    currency: text("currency"),
    defaultCategory: text("defaultCategory") || null,
    handlingDays: Number(text("handlingDays")),
    productLocation: text("productLocation") || null,
    koganShipping: text("koganShipping") || shippingModeOf(current),
    autoSyncEnabled: formData.has("autoSyncEnabled"),
    createOnKogan: formData.has("createOnKogan"),
    zeroStockOnDelete: formData.has("zeroStockOnDelete"),
    importAsActive: formData.has("importAsActive"),
    autoGenerateSkus: formData.has("autoGenerateSkus"),
    orderSyncEnabled: formData.has("orderSyncEnabled"),
    orderSyncMinutes: Number(text("orderSyncMinutes")),
    importDispatchedOrders: formData.has("importDispatchedOrders"),
    dispatchCarrier: text("dispatchCarrier") || null,
    koganOrderLocation: text("koganOrderLocation") || null,
    koganFirstDiscount: text("koganFirstDiscount") || null,
    koganOrderMethod: text("koganOrderMethod") || orderMethodOf(current),
    dispatchedOrdersFrom: parseDate(text("dispatchedOrdersFrom")),
  };
}

function validate(values) {
  const errors = {};

  if (!values.syncTag) errors.syncTag = "Enter the tag used to mark Kogan products.";
  if (!SUPPORTED_CURRENCIES.includes(values.currency)) errors.currency = "Choose a currency.";
  if (!SHIPPING_MODES.includes(values.koganShipping)) errors.koganShipping = "Choose a shipping option.";
  if (!Number.isInteger(values.handlingDays) || values.handlingDays < 0 || values.handlingDays > 60) {
    errors.handlingDays = "Enter a whole number of days between 0 and 60.";
  }
  if (values.dispatchedOrdersFrom === undefined) {
    errors.dispatchedOrdersFrom = "Enter a valid date.";
  } else if (values.dispatchedOrdersFrom && values.dispatchedOrdersFrom > new Date()) {
    errors.dispatchedOrdersFrom = "Choose today or a date in the past.";
  }
  if (!Number.isInteger(values.orderSyncMinutes) || values.orderSyncMinutes < 5 || values.orderSyncMinutes > 1440) {
    errors.orderSyncMinutes = "Enter a whole number of minutes between 5 and 1440.";
  }
  if (values.apiBaseUrl) {
    try {
      new URL(values.apiBaseUrl);
    } catch {
      errors.apiBaseUrl = "Enter a valid URL.";
    }
  }
  if (values.dispatchCarrier && values.dispatchCarrier.length > 100) {
    errors.dispatchCarrier = "Enter at most 100 characters.";
  }
  if (values.koganFirstDiscount !== null) {
    const percent = Number(values.koganFirstDiscount);
    if (
      !Number.isFinite(percent) ||
      percent < KOGAN_FIRST_MIN_PERCENT ||
      percent > KOGAN_FIRST_MAX_PERCENT ||
      Math.round(percent * 100) !== percent * 100
    ) {
      errors.koganFirstDiscount = `Enter a percentage between ${KOGAN_FIRST_MIN_PERCENT} and ${KOGAN_FIRST_MAX_PERCENT} (up to 2 decimals), or leave it empty.`;
    }
  }
  if (!ORDER_METHODS.includes(values.koganOrderMethod)) {
    errors.koganOrderMethod = "Choose how Kogan orders are created.";
  }
  if (values.defaultCategory && values.defaultCategory.length > 255) {
    errors.defaultCategory = "The category is too long.";
  }

  return errors;
}

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const current = await getSettings(session.shop);
  const values = readForm(formData, current);

  if (formData.get("intent") === "test") {
    try {
      await createKoganClient(values).ping();
      return { intent: "test", ok: true, message: "Connected to Kogan successfully" };
    } catch (error) {
      return { intent: "test", ok: false, message: error.message };
    }
  }

  if (formData.get("intent") === "check-all") {
    const count = await scheduleFullKoganCheck(session.shop);
    return {
      intent: "check-all",
      ok: true,
      message: `Checking ${count} SKUs on Kogan. Missing ones are listed again automatically`,
    };
  }

  if (formData.get("intent") === "check-catalogue") {
    const job = await startCatalogueCheckJob(session.shop);
    const started = job.type === "catalogue";
    return {
      intent: "check-catalogue",
      ok: started,
      message: started
        ? "Checking brands and titles of all Kogan listings. Progress is shown on the Dashboard"
        : "Another job is running. Try again once it finishes",
    };
  }

  if (formData.get("intent") === "kogan-first") {
    const started = await sendKoganFirst(session.shop);
    return {
      intent: "kogan-first",
      ok: started,
      message: koganFirstMessage(started, koganFirstPercent(current)),
    };
  }

  if (formData.get("intent") === "apply-location") {
    if (!current.productLocation) {
      return { intent: "apply-location", ok: false, message: "Choose and save a stock location first" };
    }
    await startLocationJob(session.shop);
    return {
      intent: "apply-location",
      ok: true,
      message: `Sending stock location ${current.productLocation} to Kogan for all products`,
    };
  }

  if (formData.get("intent") === "apply-shipping") {
    const mode = shippingModeOf(current);
    const started = await sendShipping(session.shop, mode);
    return { intent: "apply-shipping", ok: started, message: shippingMessage(started, mode) };
  }

  const errors = validate(values);
  if (Object.keys(errors).length > 0) {
    return { intent: "save", ok: false, errors, message: "Please fix the highlighted fields" };
  }

  // Saved as a normalised percentage ("5", "7.5"), or null when empty.
  values.koganFirstDiscount = koganFirstPercent(values);
  const koganFirstChanged = values.koganFirstDiscount !== koganFirstPercent(current);
  const koganFirstNote = koganFirstChanged
    ? `. The new Kogan FIRST discount is used for every product from now on; click "Send Kogan FIRST prices to Kogan now" once the running job finishes to update all listings at once`
    : "";
  const shippingChanged = values.koganShipping !== current.koganShipping;
  const environmentChanged = apiHost(values.apiBaseUrl) !== apiHost(current.apiBaseUrl);
  const locationChanged = Boolean(values.productLocation) && values.productLocation !== current.productLocation;

  // A new shipping option (or the default, before it was first sent) is
  // saved once the job that sends it to Kogan has started. The stock location
  // job sends each price with the saved shipping option, so with a location
  // change it is saved right away.
  await saveSettings(session.shop, {
    ...values,
    koganShipping: shippingChanged && !locationChanged ? current.koganShipping : values.koganShipping,
  });

  // Kogan cannot move listings between its test and live environments, so
  // after a switch every product is checked and missing ones are listed again.
  if (environmentChanged) {
    const count = await scheduleFullKoganCheck(session.shop);
    let note = "";
    if (locationChanged) {
      await startLocationJob(session.shop);
      note = `. Sending stock location ${values.productLocation} to Kogan for all products`;
    } else if (shippingChanged) {
      note = `. ${shippingMessage(await sendShipping(session.shop, values.koganShipping), values.koganShipping)}`;
    }
    return {
      intent: "save",
      ok: true,
      message: `Settings saved. Kogan environment changed: checking ${count} SKUs and listing missing ones again${note}${koganFirstNote}`,
    };
  }

  // A new stock location is applied to every product already on Kogan.
  if (locationChanged) {
    await startLocationJob(session.shop);
    return {
      intent: "save",
      ok: true,
      message: `Settings saved. Sending stock location ${values.productLocation} to Kogan for all products${koganFirstNote}`,
    };
  }

  // A new shipping option is applied to every product already on Kogan.
  if (shippingChanged) {
    const started = await sendShipping(session.shop, values.koganShipping);
    return {
      intent: "save",
      ok: true,
      message: `${shippingMessage(started, values.koganShipping, "Settings saved. ")}${koganFirstNote}`,
    };
  }

  // A new Kogan FIRST discount is applied to every listing already on Kogan.
  if (koganFirstChanged) {
    const started = await sendKoganFirst(session.shop);
    return {
      intent: "save",
      ok: true,
      message: koganFirstMessage(started, values.koganFirstDiscount, "Settings saved. "),
    };
  }

  return { intent: "save", ok: true, message: "Settings saved" };
};

export default function Settings() {
  const settings = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const [currency, setCurrency] = useState(settings.currency);
  const [location, setLocation] = useState(settings.productLocation);
  const [shipping, setShipping] = useState(settings.koganShipping);
  const [category, setCategory] = useState(settings.defaultCategory);
  const [categoryLabel, setCategoryLabel] = useState(settings.defaultCategoryPath);
  const [categoryFieldKey, setCategoryFieldKey] = useState(0);

  const errors = fetcher.data?.errors || {};
  const busyIntent = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent) => {
    const formData = new FormData(formRef.current);
    formData.set("intent", intent);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={busyIntent === "save" || undefined}
        onClick={() => submit("save")}
      >
        Save
      </s-button>

      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          submit("save");
        }}
      >
        <input type="hidden" name="defaultCategory" value={category} />

        <s-stack gap="base">
          <s-section heading="Kogan account">
            <s-stack gap="base">
              <s-paragraph>
                Find these in the Kogan Marketplace seller portal under API settings.
                {settings.envFallback &&
                  " Fields left empty use the credentials from the server's .env file."}
              </s-paragraph>
              <s-text-field
                name="sellerId"
                label="Seller ID"
                value={settings.sellerId}
                autocomplete="off"
              />
              <s-password-field
                name="sellerToken"
                label="Seller token"
                placeholder={settings.hasSavedToken ? "Saved. Leave empty to keep the current token." : ""}
                autocomplete="new-password"
              />
              <s-url-field
                name="apiBaseUrl"
                label="API base URL"
                value={settings.apiBaseUrl}
                placeholder={settings.defaultApiBaseUrl}
                details="Leave empty to use the default. Use the production URL Kogan gives you when you go live."
                error={errors.apiBaseUrl}
              />
              <s-stack direction="inline" gap="small">
                <s-button
                  loading={busyIntent === "test" || undefined}
                  onClick={() => submit("test")}
                >
                  Test connection
                </s-button>
                <s-button
                  loading={busyIntent === "check-all" || undefined}
                  onClick={() => submit("check-all")}
                >
                  Check all products on Kogan
                </s-button>
                <s-button
                  loading={busyIntent === "check-catalogue" || undefined}
                  onClick={() => submit("check-catalogue")}
                >
                  Check brands and titles on Kogan
                </s-button>
              </s-stack>
              <s-text color="subdued">
                Kogan keeps its test and live environments separate. After switching the API
                URL, every product is checked on the new environment and products Kogan does
                not have yet are created there automatically. “Check brands and titles on
                Kogan” reads every Kogan listing, sends the Shopify brand (Vendor) and title
                again wherever Kogan shows something different, and lists Kogan listings that
                are not linked to a Shopify product in Activity.
              </s-text>
            </s-stack>
          </s-section>

          <s-section heading="Listing defaults">
            <s-stack gap="base">
              <s-text-field
                name="syncTag"
                label="Sync tag"
                value={settings.syncTag}
                details="Shopify products with this tag are kept in sync with Kogan. Imported products get this tag automatically. Removing the tag from a product sets its Kogan stock to 0 and removes it from the app (Kogan removes the listing after 7 days), so products that do not carry a new tag are taken off sale when they are next updated."
                error={errors.syncTag}
              />
              <s-select
                name="currency"
                label="Kogan store currency"
                details="AUD lists on Kogan Australia, NZD on Kogan New Zealand. Imported products keep the currency they have on Kogan."
                error={errors.currency}
                onChange={(event) => setCurrency(event.currentTarget.value)}
                onInput={(event) => setCurrency(event.currentTarget.value)}
              >
                {["AUD", "NZD"].map((code) => (
                  <s-option key={code} value={code} selected={settings.currency === code || undefined}>
                    {code === "AUD" ? "AUD (Kogan Australia)" : "NZD (Kogan New Zealand)"}
                  </s-option>
                ))}
              </s-select>
              <s-number-field
                name="handlingDays"
                label="Handling days"
                value={String(settings.handlingDays)}
                min={0}
                max={60}
                step={1}
                details="Days it takes you to dispatch an order. Used for products created on Kogan from Shopify."
                error={errors.handlingDays}
              />
              <s-select
                name="productLocation"
                label="Stock location"
                details="The country your stock ships from. It is sent to Kogan for every product and kept up to date."
                onChange={(event) => setLocation(event.currentTarget.value)}
                onInput={(event) => setLocation(event.currentTarget.value)}
              >
                <s-option value="" selected={!settings.productLocation || undefined}>
                  Not specified
                </s-option>
                {STOCK_LOCATIONS.map((code) => (
                  <s-option key={code} value={code} selected={settings.productLocation === code || undefined}>
                    {STOCK_LOCATION_NAMES[code] ? `${code} – ${STOCK_LOCATION_NAMES[code]}` : code}
                  </s-option>
                ))}
              </s-select>
              {currency === "NZD" && location !== "NZ" && (
                <s-banner tone="warning" heading="Kogan adds 15% GST to your prices">
                  Kogan New Zealand treats stock that is not located in New Zealand as imported and
                  adds 15% GST to the price you send. If your stock ships from New Zealand, choose
                  “NZ – New Zealand” and save.
                </s-banner>
              )}
              {settings.productLocation && (
                <s-stack direction="inline">
                  <s-button
                    loading={busyIntent === "apply-location" || undefined}
                    onClick={() => submit("apply-location")}
                  >
                    Send stock location {settings.productLocation} to all products now
                  </s-button>
                </s-stack>
              )}
            </s-stack>
          </s-section>

          <s-section heading="Shipping on Kogan">
            <s-stack gap="base">
              <s-select
                name="koganShipping"
                label="Shipping"
                details="Sent to Kogan for every product and kept up to date. Saving a different option updates all products already on Kogan."
                error={errors.koganShipping}
                onChange={(event) => setShipping(event.currentTarget.value)}
                onInput={(event) => setShipping(event.currentTarget.value)}
              >
                <s-option value="free" selected={settings.koganShipping === "free" || undefined}>
                  Free shipping (default)
                </s-option>
                <s-option value="variable" selected={settings.koganShipping === "variable" || undefined}>
                  Variable shipping (Kogan shipping matrix)
                </s-option>
              </s-select>
              {shipping === "free" ? (
                <s-banner tone="info" heading="Free shipping">
                  Shipping is sent to Kogan as 0, so customers pay only the product price. Make sure
                  your Kogan prices cover your delivery costs.
                </s-banner>
              ) : (
                <s-banner tone="info" heading="Variable shipping">
                  Kogan works out the shipping charge from each product&apos;s weight and the
                  customer&apos;s location, using the shipping matrix you send to Kogan (Per Kilo
                  Charge or Weight Range template). Keep product weights in Shopify accurate, and do
                  not mention free shipping in your product descriptions.
                </s-banner>
              )}
              <s-stack direction="inline">
                <s-button
                  loading={busyIntent === "apply-shipping" || undefined}
                  onClick={() => submit("apply-shipping")}
                >
                  Send {settings.koganShipping} shipping to all products now
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Kogan FIRST price (Mighty Ape Primate)">
            <s-stack gap="base">
              <s-number-field
                name="koganFirstDiscount"
                label="Kogan FIRST discount"
                suffix="%"
                value={settings.koganFirstDiscount}
                min={settings.koganFirstLimits.min}
                max={settings.koganFirstLimits.max}
                step={0.01}
                placeholder="Not managed by the app"
                details="Kogan FIRST members (Primate on Mighty Ape) pay this much less than the normal price. Sent to Kogan for every product and kept up to date when prices change. Leave empty to let Kogan's own store-wide discount apply."
                error={errors.koganFirstDiscount}
              />
              <s-banner tone="info" heading="How Kogan applies it">
                Each Kogan listing gets a Kogan FIRST price of its normal price minus this
                percentage, for example 5% of $499.00 gives $474.05. Kogan requires at least $2 or
                3% off (whichever is greater), so cheaper items get $2 off. If Kogan also has a
                store-wide Kogan FIRST discount for your store, Kogan shows the larger of the two;
                ask Kogan to set the store-wide discount to 0% so this setting has full control.
                Saving a different value updates all listings already on Kogan. Leaving it empty
                and clicking the button below removes the Kogan FIRST prices set on single SKUs.
              </s-banner>
              <s-stack direction="inline">
                <s-button
                  loading={busyIntent === "kogan-first" || undefined}
                  onClick={() => submit("kogan-first")}
                >
                  Send Kogan FIRST prices to Kogan now
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Default Kogan category">
            <s-stack gap="base">
              <s-paragraph>
                Used when a Shopify product is listed on Kogan for the first time and its
                “Kogan category” metafield is empty.
              </s-paragraph>
              <s-text-field
                key={categoryFieldKey}
                label="Default category"
                value={category}
                placeholder="kogan:46114"
                details={categoryLabel || "A Kogan category ID such as kogan:46114, or an exact Kogan category name."}
                error={errors.defaultCategory}
                onInput={(event) => {
                  setCategory(event.currentTarget.value);
                  setCategoryLabel("");
                }}
              />
              <CategoryPicker
                currency={currency}
                onSelect={(value, label) => {
                  setCategory(value);
                  setCategoryLabel(label);
                  setCategoryFieldKey((key) => key + 1);
                }}
              />
            </s-stack>
          </s-section>

          <s-section heading="Sync behaviour">
            <s-stack gap="base">
              <s-switch
                value="on"
                name="autoSyncEnabled"
                label="Send Shopify changes to Kogan automatically"
                details="When a tagged product is edited in Shopify, the change is sent to Kogan within a few seconds."
                checked={settings.autoSyncEnabled || undefined}
              />
              <s-switch
                value="on"
                name="createOnKogan"
                label="List new tagged products on Kogan"
                details="When you add the sync tag to a product that is not on Kogan yet, create it on Kogan."
                checked={settings.createOnKogan || undefined}
              />
              <s-switch
                value="on"
                name="autoGenerateSkus"
                label="Create SKUs for variants that do not have one"
                details="Kogan needs a SKU for every variant. When a tagged product has a variant without a SKU, the app creates one from the product SKU (or handle) and the option values, e.g. SAMSUNG-S24-256GB."
                checked={settings.autoGenerateSkus || undefined}
              />
              <s-switch
                value="on"
                name="zeroStockOnDelete"
                label="Remove products from Kogan when they are deleted in Shopify"
                details="Kogan has no delete API, so the product is delisted from your Kogan store and its stock is set to 0. Customers can no longer find or buy it."
                checked={settings.zeroStockOnDelete || undefined}
              />
              <s-switch
                value="on"
                name="importAsActive"
                label="Publish imported products"
                details="When off, products imported from Kogan are created as drafts so you can review them first."
                checked={settings.importAsActive || undefined}
              />
            </s-stack>
          </s-section>

          <s-section heading="Orders">
            <s-stack gap="base">
              <s-switch
                value="on"
                name="orderSyncEnabled"
                label="Fetch new Kogan orders automatically"
                details="New Kogan orders are created in Shopify Orders. Fulfilments and cancellations in Shopify are sent back to Kogan."
                checked={settings.orderSyncEnabled || undefined}
              />
              <s-number-field
                name="orderSyncMinutes"
                label="Check for new orders every"
                suffix="minutes"
                value={String(settings.orderSyncMinutes)}
                min={5}
                max={1440}
                step={1}
                error={errors.orderSyncMinutes}
              />
              <s-select
                name="koganOrderMethod"
                label="Create Kogan orders in Shopify as"
                details="Applies to new Kogan orders. Shipping apps such as eShip only import orders that Shopify marks as needing shipping."
                error={errors.koganOrderMethod}
              >
                <s-option value="draft" selected={settings.koganOrderMethod === "draft" || undefined}>
                  Draft order, completed as paid (recommended: Shopify shows “Shipping”)
                </s-option>
                <s-option value="direct" selected={settings.koganOrderMethod === "direct" || undefined}>
                  Direct order (older method: Shopify shows “Shipping not required”)
                </s-option>
              </s-select>
              {settings.koganOrderMethod === "draft" && !settings.draftOrdersAllowed && (
                <s-banner tone="warning" heading="Permission needed for draft orders">
                  The app needs the “Draft orders” permission to create Kogan orders this way.
                  Until it is approved, Kogan orders are still created as direct orders. Open the
                  app from Shopify Admin → Apps and approve the updated permissions when asked.
                </s-banner>
              )}
              <s-select
                name="koganOrderLocation"
                label="Ship Kogan orders from"
                details="The Shopify location new Kogan orders are assigned to. Choose the location your shipping app (for example eShip) imports orders from. Open Kogan orders are moved there on the next order check."
              >
                <s-option value="" selected={!settings.koganOrderLocation || undefined}>
                  Let Shopify decide
                </s-option>
                {settings.locations.map((location) => (
                  <s-option key={location.id} value={location.id} selected={settings.koganOrderLocation === location.id || undefined}>
                    {location.name}
                  </s-option>
                ))}
              </s-select>
              <s-text-field
                name="dispatchCarrier"
                label="Default carrier for Kogan dispatches"
                value={settings.dispatchCarrier}
                placeholder="e.g. NZ Post"
                details="Kogan needs a carrier name for every dispatch. It is taken from the fulfillment in Shopify (or its tracking link); this name is used when neither has one."
                error={errors.dispatchCarrier}
              />
              <s-switch
                value="on"
                name="importDispatchedOrders"
                label="Bring in orders dispatched on Kogan"
                details="When an order is dispatched on Kogan, it is created in Shopify if it is not there yet and marked as fulfilled with Kogan's carrier and tracking number."
                checked={settings.importDispatchedOrders || undefined}
              />
              <s-date-field
                name="dispatchedOrdersFrom"
                label="Only orders dispatched on or after"
                value={settings.dispatchedOrdersFrom}
                details="Older dispatched orders are not created in Shopify, so turning this on does not add past orders or take their stock again. Kogan keeps dispatched orders for the last 14 days. Leave empty to start from today."
                error={errors.dispatchedOrdersFrom}
              />
            </s-stack>
          </s-section>

          <s-stack direction="inline" justifyContent="end">
            <s-button
              variant="primary"
              loading={busyIntent === "save" || undefined}
              onClick={() => submit("save")}
            >
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </form>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
