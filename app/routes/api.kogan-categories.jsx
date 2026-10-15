import { authenticate } from "../shopify.server";
import { storeCodeForCurrency } from "../kogan/kogan-client.server";
import {
  categorySourceFor,
  ensureCategories,
  presentCategory,
  searchCategories,
} from "../kogan/categories.server";
import { getSettings } from "../kogan/store.server";

const MAX_RESULTS = 30;

/**
 * Searches Kogan categories for the category pickers. Results come from the
 * stored copy of Kogan's category tree; while that copy is being downloaded
 * for the first time, Kogan is asked directly.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const stored = await getSettings(session.shop);
  const currency = url.searchParams.get("currency") || stored.currency;
  const settings = { ...stored, currency };

  if (query.length < 2) {
    return { results: [], error: null };
  }

  try {
    const { source, sync } = await ensureCategories(settings);

    if (sync?.count > 0) {
      const { items } = await searchCategories(source, { query, pageSize: MAX_RESULTS });
      return { results: items.map(presentCategory), error: null };
    }

    const { kogan } = categorySourceFor(settings);
    const categories = await kogan.getAllCategories(storeCodeForCurrency(currency));
    const terms = query.toLowerCase().split(/\s+/);
    const results = categories
      .filter((category) => {
        const haystack = `${category.id} ${category.display || category.title}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, MAX_RESULTS)
      .map((category) => ({
        id: category.id,
        title: category.title,
        display: category.display,
        path: String(category.display || "").split("»").map((part) => part.trim()),
        departments: [],
        url: null,
        value: `kogan:${category.id}`,
      }));

    return { results, error: null };
  } catch (error) {
    return { results: [], error: error.message };
  }
};
