import { authenticate } from "../shopify.server";
import { createKoganClient } from "../kogan/kogan-client.server";
import { getSettings, hasKoganCredentials } from "../kogan/store.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);

  if (!hasKoganCredentials(settings)) {
    return { connected: false, configured: false, message: "Kogan credentials are not set." };
  }

  try {
    const kogan = createKoganClient(settings);
    await kogan.ping();
    return {
      connected: true,
      configured: true,
      sellerId: kogan.sellerId,
      apiHost: new URL(kogan.baseUrl).host,
    };
  } catch (error) {
    return { connected: false, configured: true, message: error.message };
  }
};
