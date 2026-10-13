// Production server for the app.
//
// It behaves like `react-router-serve`, with two additions needed when the app
// runs behind a reverse proxy (for example Cloudways, Nginx or Apache):
//
// 1. React Router rejects form submissions (actions) with "400 Bad Request"
//    when the browser's Origin header does not match the host the server sees.
//    Behind a proxy the server often sees an internal host such as
//    "localhost:3000", so every Import, Delete or Save would fail. The public
//    app host from SHOPIFY_APP_URL is therefore allowed explicitly at runtime,
//    which keeps React Router's CSRF protection for every other origin.
// 2. "trust proxy" is enabled so the forwarded host and https protocol are used.
//
// Extra hosts can be allowed with ALLOWED_ACTION_ORIGINS="a.com,*.b.com".

import path from "node:path";
import url from "node:url";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";

const BUILD_PATH = path.resolve("build/server/index.js");

function hostOf(value) {
  try {
    return value ? new URL(value).host : null;
  } catch {
    return null;
  }
}

function allowedActionOrigins() {
  const hosts = new Set();

  for (const value of [process.env.SHOPIFY_APP_URL, process.env.APP_URL]) {
    const host = hostOf(value);
    if (host) hosts.add(host);
  }

  for (const value of (process.env.ALLOWED_ACTION_ORIGINS || "").split(",")) {
    const host = value.trim();
    if (host) hosts.add(host);
  }

  return [...hosts];
}

const buildModule = await import(url.pathToFileURL(BUILD_PATH).href);
const origins = allowedActionOrigins();
const build = {
  ...buildModule,
  allowedActionOrigins: [...(buildModule.allowedActionOrigins || []), ...origins],
};

if (origins.length === 0) {
  console.warn(
    "[server] SHOPIFY_APP_URL is not set, so actions are only accepted when the proxy forwards the public host.",
  );
}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(compression());
app.use(
  path.posix.join(build.publicPath, "assets"),
  express.static(path.join(build.assetsBuildDirectory, "assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(build.publicPath, express.static(build.assetsBuildDirectory));
app.use(express.static("public", { maxAge: "1h" }));
app.use(morgan("tiny"));
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

const port = Number(process.env.PORT) || 3000;
const onListen = () => {
  console.log(`[server] listening on port ${port}`);
  if (origins.length > 0) console.log(`[server] accepting actions from: ${origins.join(", ")}`);
};
const server = process.env.HOST
  ? app.listen(port, process.env.HOST, onListen)
  : app.listen(port, onListen);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(console.error));
}
