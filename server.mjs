import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createRequestHandler } from "@react-router/express";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST;
const app = express();

// Some managed Node runtimes attach an invalid stdin descriptor. Importing an
// ESM dependency that re-exports `node:process` then asks Node to initialize
// that descriptor and the application fails with `open EEXIST`. This HTTP
// service never reads stdin, so provide a harmless stream before loading the
// React Router server bundle.
try {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  if (typeof stdinDescriptor?.get === "function") {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      enumerable: true,
      value: new PassThrough(),
    });
  }
} catch (error) {
  console.warn("[hostinger-server] Could not normalize stdin", error);
}

app.disable("x-powered-by");
app.use(compression());
app.use(
  "/assets",
  express.static(path.resolve("build/client/assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(express.static(path.resolve("build/client")));
app.use(express.static(path.resolve("public"), { maxAge: "1h" }));
app.use(morgan("tiny"));

let reactRouterHandler;
let startupError;

app.all("*", (request, response, next) => {
  if (startupError) {
    response.status(503).send("Application failed to initialize");
    return;
  }

  if (!reactRouterHandler) {
    response
      .set("Retry-After", "2")
      .status(503)
      .send("Application is starting");
    return;
  }

  reactRouterHandler(request, response, next);
});

const server = host
  ? app.listen(port, host, onListen)
  : app.listen(port, onListen);

function onListen() {
  console.log(`[hostinger-server] Listening on port ${port}`);
  initializeApplication();
}

async function initializeApplication() {
  try {
    const buildUrl = pathToFileURL(path.resolve("build/server/index.js")).href;
    const build = await import(buildUrl);
    reactRouterHandler = createRequestHandler({
      build,
      mode: process.env.NODE_ENV || "production",
    });
    console.log("[hostinger-server] React Router application initialized");
  } catch (error) {
    startupError = error;
    console.error(
      "[hostinger-server] Application initialization failed",
      error,
    );
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close());
}
