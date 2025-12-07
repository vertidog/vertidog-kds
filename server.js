// ===============================
// VertiDog KDS Backend – FULL
// ===============================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------- HTTP + WebSocket server ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- Middleware ----------------

app.use(bodyParser.json());

// Serve static assets from ./public (kitchen.html, sounds, etc.)
app.use(express.static(path.join(__dirname, "public")));

// ---------------- In-memory order store ----------------

// Shape: { [orderNumber]: { orderNumber, status, createdAt, itemCount, items[] } }
let orders = {};

// ---------------- WebSocket handling ----------------

wss.on("connection", (ws) => {
  console.log("KDS connected");

  ws.on("close", () => {
    console.log("KDS disconnected");
  });

  // On connect, send full state so the screen can sync
  ws.send(
    JSON.stringify({
      type: "SYNC",
      orders,
    })
  );
});

// Broadcast helper
function broadcast(msgObj) {
  const data = JSON.stringify(msgObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

// Small helper to safely read quantity as number
function toQty(q) {
  if (q === undefined || q === null) return 0;
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}

// ---------------- Square Webhook ----------------

/**
 * Accepts Square webhook events and turns them into NEW_ORDER messages
 * that the kitchen UI understands.
 *
 * Supports common shapes:
 * - New style: data.object.order
 * - order_created: data.object.order_created.order
 * - order_updated: data.object.order_updated.order
 * - Test event: data.object.order_created.order_id (no full order object)
 */
app.post("/square/webhook", (req, res) => {
  try {
    const body = req.body || {};
    console.log("🔔 Square Webhook Received:", JSON.stringify(body));

    const eventType = body.type;
    console.log("Square Event:", eventType);

    const data = body.data || {};
    const obj = data.object || {};

    let order = null;

    // 1) Newer style: { data: { object: { order: { ... } } } }
    if (obj.order) {
      order = obj.order;
    }

    // 2) Common webhooks: order_created / order_updated with nested order
    if (!order && obj.order_created && obj.order_created.order) {
      order = obj.order_created.order;
    }
    if (!order && obj.order_updated && obj.order_updated.order) {
      order = obj.order_updated.order;
    }

    // 3) Test payload: order_created only has order_id
    if (!order && obj.order_created && obj.order_created.order_id) {
      order = {
        id: obj.order_created.order_id,
        ticket_name: obj.order_created.order_id,
        line_items: [],
      };
    }

    if (!order) {
      console.log("❌ No order object found in webhook payload.");
      return res.status(200).send("no order");
    }

    // ---------- ORDER NUMBER ----------
    const orderNumber =
      order.ticket_name || // kitchen/“ticket” name if configured
      order.order_number || // true order number if present
      order.display_id || // sometimes used by Square
      order.id || // fallback to internal id
      "NO#";

    // ---------- ITEMS ----------
    const lineItems = Array.isArray(order.line_items)
      ? order.line_items
      : [];

    const items = lineItems.map((li) => ({
      name: li.name || "Item",
      quantity: toQty(li.quantity || 1),
      modifiers: Array.isArray(li.modifiers)
        ? li.modifiers.map((m) => m.name).filter(Boolean)
        : [],
    }));

    const itemCount = items.reduce(
      (sum, it) => sum + toQty(it.quantity),
      0
    );

    const newOrder = {
      orderNumber: String(orderNumber),
      status: "new",
      createdAt: Date.now(),
      itemCount,
      items,
    };

    console.log("✅ Parsed Webhook Order:", newOrder);

    // Store / update in memory
    orders[newOrder.orderNumber] = newOrder;

    // Notify all KDS screens
    broadcast({
      type: "NEW_ORDER",
      ...newOrder,
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    // Still respond 200 so Square doesn’t spam retries while we debug
    return res.status(200).send("error");
  }
});

// ---------------- Test endpoint (manual order injection) ----------------

app.get("/test-order", (req, res) => {
  const num = Math.floor(Math.random() * 900 + 100);
  const newOrder = {
    orderNumber: String(num),
    status: "new",
    createdAt: Date.now(),
    itemCount: 2,
    items: [
      { name: "Hot Dog", quantity: 1, modifiers: [] },
      { name: "Coca-Cola", quantity: 1, modifiers: [] },
    ],
  };

  orders[newOrder.orderNumber] = newOrder;
  broadcast({ type: "NEW_ORDER", ...newOrder });

  res.send(`Test order #${num} sent to KDS`);
});

// ---------------- Routes for health and UI ----------------

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// Redirect root to /kitchen
app.get("/", (req, res) => {
  res.redirect("/kitchen");
});

// Serve kitchen screen at /kitchen
app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

// ---------------- Start server ----------------

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
