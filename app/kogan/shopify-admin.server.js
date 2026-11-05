import { unauthenticated } from "../shopify.server";

const loading = new Map();

/**
 * Loads the shop's offline session. With expiring offline access tokens the
 * token is only valid for about an hour, and the library refreshes it while
 * loading the session. Concurrent loads for one shop share a single request,
 * so one refresh token is never used twice at the same time.
 */
function loadAdmin(shop) {
  let pending = loading.get(shop);
  if (!pending) {
    pending = unauthenticated.admin(shop).finally(() => loading.delete(shop));
    loading.set(shop, pending);
  }
  return pending;
}

/**
 * Checks that the shop still has a usable offline session (refreshing an
 * expiring token), so background work fails early when it does not.
 */
export async function ensureBackgroundSession(shop) {
  await loadAdmin(shop);
}

function isUnauthorized(error) {
  return error?.response?.code === 401 || error?.status === 401;
}

/**
 * Admin API client for background work (webhooks, jobs, the poller). Jobs
 * such as "Update from Kogan" can run for more than an hour, so instead of
 * keeping one client (and one token) for the whole job, every request uses
 * the current, refreshed session. A 401 is retried once with the newest
 * session, in case another request refreshed the token in the meantime.
 */
export function backgroundAdmin(shop) {
  return {
    async graphql(query, options) {
      const { admin } = await loadAdmin(shop);
      try {
        return await admin.graphql(query, options);
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
        const { admin: current } = await loadAdmin(shop);
        return current.graphql(query, options);
      }
    },
  };
}
