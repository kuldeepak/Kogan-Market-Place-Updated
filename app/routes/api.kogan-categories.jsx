import { authenticate } from "../shopify.server";
import { createKoganClient, storeCodeForCurrency } from "../kogan/kogan-client.server";
import { getSettings } from "../kogan/store.server";

const MAX_RESULTS = 30;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const settings = await getSettings(session.shop);
  const currency = url.searchParams.get("currency") || settings.currency;

  if (query.length < 2) {
    return { results: [], error: null };
  }

  try {
    const kogan = createKoganClient(settings);
    const categories = await kogan.getAllCategories(storeCodeForCurrency(currency));
    const terms = query.split(/\s+/);

    const results = categories
      .filter((category) => {
        const haystack = `${category.id} ${category.display || category.title}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => {
        const aExact = a.title.toLowerCase().startsWith(query) ? 0 : 1;
        const bExact = b.title.toLowerCase().startsWith(query) ? 0 : 1;
        return aExact - bExact || a.title.localeCompare(b.title);
      })
      .slice(0, MAX_RESULTS);

    return { results, error: null };
  } catch (error) {
    return { results: [], error: error.message };
  }
};
