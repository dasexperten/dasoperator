import { Hono } from "hono";

type Bindings = {
  // DB: D1Database;
  // DOCS: R2Bucket;
  // COUNTERS: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => {
  return c.json({
    name: "Das Operator API",
    version: "0.1.0",
    status: "skeleton",
  });
});

app.get("/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

export default app;
