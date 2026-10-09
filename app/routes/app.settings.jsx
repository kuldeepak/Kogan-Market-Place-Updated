import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { DEFAULT_API_BASE_URL, createKoganClient } from "../kogan/kogan-client.server";
import {
  SUPPORTED_CURRENCIES,
  getSettings,
  hasEnvCredentials,
  saveSettings,
} from "../kogan/store.server";

const STOCK_LOCATIONS = ["AU", "NZ", "CN", "HK", "US", "UK"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);

  return {
    sellerId: settings.sellerId || "",
    hasSavedToken: Boolean(settings.sellerToken),
    apiBaseUrl: settings.apiBaseUrl || "",
    envFallback: hasEnvCredentials(),
    defaultApiBaseUrl: DEFAULT_API_BASE_URL,
    syncTag: settings.syncTag,
    currency: settings.currency,
    defaultCategory: settings.defaultCategory || "",
    handlingDays: settings.handlingDays,
    productLocation: settings.productLocation || "",
    autoSyncEnabled: settings.autoSyncEnabled,
    createOnKogan: settings.createOnKogan,
    zeroStockOnDelete: settings.zeroStockOnDelete,
    importAsActive: settings.importAsActive,
    autoGenerateSkus: settings.autoGenerateSkus,
    orderSyncEnabled: settings.orderSyncEnabled,
    orderSyncMinutes: settings.orderSyncMinutes,
  };
};

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
  };
}

function validate(values) {
  const errors = {};

  if (!values.syncTag) errors.syncTag = "Enter the tag used to mark Kogan products.";
  if (!SUPPORTED_CURRENCIES.includes(values.currency)) errors.currency = "Choose a currency.";
  if (!Number.isInteger(values.handlingDays) || values.handlingDays < 0 || values.handlingDays > 60) {
    errors.handlingDays = "Enter a whole number of days between 0 and 60.";
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

  const errors = validate(values);
  if (Object.keys(errors).length > 0) {
    return { intent: "save", ok: false, errors, message: "Please fix the highlighted fields" };
  }

  await saveSettings(session.shop, values);
  return { intent: "save", ok: true, message: "Settings saved" };
};

function CategoryPicker({ currency, onSelect }) {
  const fetcher = useFetcher();
  const [query, setQuery] = useState("");
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) return undefined;
    timer.current = setTimeout(() => {
      fetcher.load(
        `/api/kogan-categories?q=${encodeURIComponent(query.trim())}&currency=${currency}`,
      );
    }, 350);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, currency]);

  const results = query.trim().length >= 2 ? fetcher.data?.results || [] : [];

  return (
    <s-stack gap="small">
      <s-search-field
        label="Find a Kogan category"
        placeholder="e.g. headphones, phone cases, 46114"
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      {fetcher.state === "loading" && (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-spinner size="base" accessibilityLabel="Loading categories" />
          <s-text color="subdued">
            Searching Kogan categories… the first search can take up to 20 seconds.
          </s-text>
        </s-stack>
      )}
      {fetcher.data?.error && <s-text tone="critical">{fetcher.data.error}</s-text>}
      {fetcher.state === "idle" && query.trim().length >= 2 && results.length === 0 && !fetcher.data?.error && fetcher.data && (
        <s-text color="subdued">No categories match “{query}”.</s-text>
      )}
      {results.length > 0 && (
        <s-box border="base" borderRadius="base" maxBlockSize="320px" overflow="hidden">
          <s-scroll-box maxBlockSize="320px">
            {results.map((category, index) => (
              <s-box
                key={category.id}
                padding="small"
                borderWidth={index === 0 ? undefined : "base none none none"}
              >
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                  <s-stack gap="small-300">
                    <s-text type="strong">{category.title}</s-text>
                    <s-text color="subdued">{category.display} · kogan:{category.id}</s-text>
                  </s-stack>
                  <s-button onClick={() => onSelect(`kogan:${category.id}`, category.display)}>
                    Use
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-scroll-box>
        </s-box>
      )}
    </s-stack>
  );
}

export default function Settings() {
  const settings = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);
  const [currency, setCurrency] = useState(settings.currency);
  const [category, setCategory] = useState(settings.defaultCategory);
  const [categoryLabel, setCategoryLabel] = useState("");
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
              <s-select name="productLocation" label="Stock location">
                <s-option value="" selected={!settings.productLocation || undefined}>
                  Not specified
                </s-option>
                {STOCK_LOCATIONS.map((code) => (
                  <s-option key={code} value={code} selected={settings.productLocation === code || undefined}>
                    {code}
                  </s-option>
                ))}
              </s-select>
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
