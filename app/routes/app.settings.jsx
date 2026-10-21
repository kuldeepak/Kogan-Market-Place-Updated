import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { CategoryPicker } from "../components/category-picker";
import { authenticate } from "../shopify.server";
import { DEFAULT_API_BASE_URL, createKoganClient } from "../kogan/kogan-client.server";
import { categorySourceFor, resolveCategoryValue } from "../kogan/categories.server";
import { startLocationJob } from "../kogan/sync.server";
import {
  SUPPORTED_CURRENCIES,
  getSettings,
  hasEnvCredentials,
  saveSettings,
} from "../kogan/store.server";

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
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
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
    autoSyncEnabled: settings.autoSyncEnabled,
    createOnKogan: settings.createOnKogan,
    zeroStockOnDelete: settings.zeroStockOnDelete,
    importAsActive: settings.importAsActive,
    autoGenerateSkus: settings.autoGenerateSkus,
    orderSyncEnabled: settings.orderSyncEnabled,
    orderSyncMinutes: settings.orderSyncMinutes,
    importDispatchedOrders: settings.importDispatchedOrders,
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
    autoSyncEnabled: formData.has("autoSyncEnabled"),
    createOnKogan: formData.has("createOnKogan"),
    zeroStockOnDelete: formData.has("zeroStockOnDelete"),
    importAsActive: formData.has("importAsActive"),
    autoGenerateSkus: formData.has("autoGenerateSkus"),
    orderSyncEnabled: formData.has("orderSyncEnabled"),
    orderSyncMinutes: Number(text("orderSyncMinutes")),
    importDispatchedOrders: formData.has("importDispatchedOrders"),
    dispatchedOrdersFrom: parseDate(text("dispatchedOrdersFrom")),
  };
}

function validate(values) {
  const errors = {};

  if (!values.syncTag) errors.syncTag = "Enter the tag used to mark Kogan products.";
  if (!SUPPORTED_CURRENCIES.includes(values.currency)) errors.currency = "Choose a currency.";
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

  const errors = validate(values);
  if (Object.keys(errors).length > 0) {
    return { intent: "save", ok: false, errors, message: "Please fix the highlighted fields" };
  }

  await saveSettings(session.shop, values);

  // A new stock location is applied to every product already on Kogan.
  if (values.productLocation && values.productLocation !== current.productLocation) {
    await startLocationJob(session.shop);
    return {
      intent: "save",
      ok: true,
      message: `Settings saved. Sending stock location ${values.productLocation} to Kogan for all products`,
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
              <s-stack direction="inline">
                <s-button
                  loading={busyIntent === "test" || undefined}
                  onClick={() => submit("test")}
                >
                  Test connection
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Listing defaults">
            <s-stack gap="base">
              <s-text-field
                name="syncTag"
                label="Sync tag"
                value={settings.syncTag}
                details="Shopify products with this tag are kept in sync with Kogan. Imported products get this tag automatically."
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
