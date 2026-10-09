import { authenticate } from "../shopify.server";
import { LOG_FILTERS, deleteLogs } from "../kogan/store.server";

/**
 * Deletes sync activity entries for the current shop. Used by the Activity
 * page and the dashboard's recent activity list.
 */
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  let count = 0;

  if (intent === "delete-one") {
    const id = String(formData.get("id") || "");
    if (!id) return { ok: false, message: "Nothing to delete" };
    count = await deleteLogs(session.shop, { ids: [id] });
  } else if (intent === "delete-older") {
    const days = Math.max(1, Number(formData.get("days")) || 30);
    count = await deleteLogs(session.shop, { olderThanDays: days });
  } else if (intent === "delete-filter") {
    const filter = String(formData.get("filter") || "all");
    count = await deleteLogs(session.shop, { filter: LOG_FILTERS[filter] ? filter : "all" });
  } else {
    return { ok: false, message: "Unknown action" };
  }

  return {
    ok: true,
    message: count === 1 ? "1 entry deleted" : `${count} entries deleted`,
  };
};
