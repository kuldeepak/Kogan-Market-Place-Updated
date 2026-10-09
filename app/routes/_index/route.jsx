import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

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
