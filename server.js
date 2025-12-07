// ===============================
// VertiDog KDS Backend – with Square Orders API
// ===============================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// For Square Orders API
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENV = process.env.SQUARE_ENV || "production"; // or "sandbox"
const SQUARE_BASE_URL =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// In-memory store keyed by orderId
const orders = {};

// ---------------- Helpers ----------------

function toNumberQuantity(q) {
  if (q === undefined || q === null) return 0;
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}

function broadcast(msgObj) {
  const data = JSON.stringify(msgObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

// Fetch full order from Square if webhook was minimal
async function fetchOrderFromSquare(orderId) {
  if (!SQUARE_ACCESS_TOKEN) {
    console.log("⚠️ No SQUARE_ACCESS_TOKEN set, skipping Orders API fetch.");
    return null;
  }

  try {
    const resp = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-03-20", // any recent date works
      },
    });

    if (!resp.ok) {
      console.log(
        "❌ Square Orders API error:",
        resp.status,
        resp.statusText
      );
      const text = await resp.text();
      console.log(text);
      return null;
    }

    const json = await resp.json();
    console.log("✅ Orders API fetched order:", JSON.stringify(json));
    return json.order || null;
  } catch (err) {
    console.log("❌ Orders API fetch failed:", err);
    return null;
  }
}

// ---------------- HTTP + WebSocket server ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("KDS connected");

  // send current state on connect
  ws.send(
    JSON.stringify({
      type: "SYNC",
      orders,
    })
  );

  ws.on("close", () => console.log("KDS disconnected"));
});

// ---------------- Middleware + static ----------------

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

app.get("/", (req, res) => res.redirect("/kitchen"));

app.get("/healthz", (req, res) => res.status(200).send("OK"));

// ---------------- Square Webhook ----------------

app.post("/square/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("🔔 Square Webhook Received:", JSON.stringify(body));

    const eventType = body.type;
    console.log("Square Event:", eventType);

    const dataObj = body.data || {};
    const objectWrapper = dataObj.object || {};

    // eventWrapper might be:
    // - { order: { ... } }
    // - { order_created: { order, order_id, state } }
    // - { order_updated: { order, order_id, state } }
    let eventWrapper =
      objectWrapper.order ||
      objectWrapper.order_created ||
      objectWrapper.order_updated ||
      null;

    if (!eventWrapper) {
      console.log(
        "❌ No order wrapper (order / order_created / order_updated)."
      );
      return res.status(200).send("ok");
    }

    // fullOrder only exists if webhook carried the full resource
    let fullOrder = eventWrapper.order || null;

    // orderId / state appear even in minimal events
    const orderId = (fullOrder && fullOrder.id) || eventWrapper.order_id;
    const state = (fullOrder && fullOrder.state) || eventWrapper.state;

    if (!orderId) {
      console.log("❌ No order_id present in event.");
      return res.status(200).send("ok");
    }

    // If we don't have items yet, try Orders API
    if (!fullOrder || !Array.isArray(fullOrder.line_items)) {
      const fetched = await fetchOrderFromSquare(orderId);
      if (fetched) {
        fullOrder = fetched;
      }
    }

    // ---------- ORDER NUMBER (bubble label) ----------
    let orderNumber = null;
    if (fullOrder) {
      orderNumber =
        fullOrder.ticket_name ||
        fullOrder.order_number ||
        fullOrder.display_id ||
        fullOrder.receipt_number ||
        (fullOrder.id ? fullOrder.id.slice(-6).toUpperCase() : null);
    } else {
      orderNumber = orderId.slice(-6).toUpperCase();
    }

    // ---------- ITEMS ----------
    let items = [];
    if (fullOrder && Array.isArray(fullOrder.line_items)) {
      items = fullOrder.line_items.map((li) => ({
        name: li.name || "Item",
        quantity: toNumberQuantity(li.quantity || 1),
        modifiers: Array.isArray(li.modifiers)
          ? li.modifiers.map((m) => m.name).filter(Boolean)
          : [],
      }));
    } else if (orders[orderId]?.items) {
      // reuse items from previous event for same order
      items = orders[orderId].items;
    }

    const itemCount = items.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    );
    const stateFromSquare = typeof state === "string" ? state.toLowerCase() : "";

    const existing = orders[orderId] || {};
    const merged = {
      orderId,
      orderNumber: orderNumber || existing.orderNumber || orderId.slice(-6),
      status: existing.status || "new", // kitchen taps control this
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare,
    };

    orders[orderId] = merged;

    console.log("✅ Final KDS order object:", merged);

    broadcast({
      type: "NEW_ORDER",
      ...merged,
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    // 200 so Square doesn’t spam retries while we debug
    return res.status(200).send("error");
  }
});

// ---------------- Test endpoint ----------------

app.get("/test-order", (req, res) => {
  const num = Math.floor(Math.random() * 900 + 100);
  const orderId = `TEST-${num}`;
  const order = {
    orderId,
    orderNumber: String(num),
    status: "new",
    createdAt: Date.now(),
    items: [
      { name: "Hot Dog", quantity: 1, modifiers: [] },
      { name: "Coke", quantity: 1, modifiers: [] },
    ],
  };
  order.itemCount = order.items.length;
  orders[orderId] = order;

  broadcast({
    type: "NEW_ORDER",
    ...order,
  });

  res.send(`Test order #${num} sent to KDS`);
});

// ---------------- Start server ----------------

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
