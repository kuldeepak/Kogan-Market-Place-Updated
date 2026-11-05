import { useEffect } from "react";
import { redirect, Form, useLoaderData, useNavigate } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    // Trailing slash on purpose; see the Dashboard link in routes/app.jsx.
    throw redirect(`/app/?${url.searchParams.toString()}`);
  }

  // Inside Shopify admin, the back arrow in the title bar opens the app root
  // without the shop parameter. App Bridge sends its session token with that
  // request, so the merchant is taken to the dashboard instead of the login
  // page.
  if (/^Bearer\s+\S+/i.test(request.headers.get("authorization") || "")) {
    throw redirect("/app/");
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();
  const navigate = useNavigate();

  // Fallback for the same case on the client: inside Shopify admin (App
  // Bridge is loaded), the root page is never meant to be shown.
  useEffect(() => {
    if (window.top !== window.self && window.shopify) navigate("/app/", { replace: true });
  }, [navigate]);

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Kogan Marketplace Sync</h1>
        <p className={styles.text}>
          Import your Kogan catalogue into Shopify and keep every product in sync automatically.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Import from Kogan</strong>. Bring every Kogan product into Shopify with prices, stock, images and categories.
          </li>
          <li>
            <strong>Two-way ready</strong>. Edits made in Shopify are sent to Kogan within seconds, without copying anything by hand.
          </li>
          <li>
            <strong>Clear activity log</strong>. See exactly what was synced, when, and why something failed.
          </li>
        </ul>
      </div>
    </div>
  );
}
