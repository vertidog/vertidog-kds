// ===============================
// VertiDog KDS Backend – Robust Square Parsing
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

// In-memory order store so we can merge multiple events
// Shape: { [orderId]: { orderId, orderNumber, status, createdAt, itemCount, items[] } }
const orders = {};

// ---------------- Helpers ----------------

function toNumberQuantity(q) {
  if (q === undefined || q === null) return 0;
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}

// Websocket broadcast helper
function broadcast(msgObj) {
  const data = JSON.stringify(msgObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("KDS connected");

  // On connect, send current state
  ws.send(
    JSON.stringify({
      type: "SYNC",
      orders,
    })
  );

  ws.on("close", () => {
    console.log("KDS disconnected");
  });
});

// ---------------- Static files ----------------

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

app.get("/", (req, res) => {
  res.redirect("/kitchen");
});

// ---------------- Square webhook ----------------

app.post("/square/webhook", (req, res) => {
  try {
    const body = req.body || {};
    console.log("🔔 Square Webhook Received:", JSON.stringify(body));

    const eventType = body.type;
    console.log("Square Event:", eventType);

    const dataObj = body.data || {};
    const objectWrapper = dataObj.object || {};

    // Square sends a few different shapes; support as many as possible:

    // Newer style: data.object.order
    let eventWrapper =
      objectWrapper.order ||
      objectWrapper.order_created ||
      objectWrapper.order_updated ||
      null;

    if (!eventWrapper) {
      console.log("❌ No order wrapper (order / order_created / order_updated).");
      return res.status(200).send("ok");
    }

    // Try to get a full order resource if present
    let fullOrder = eventWrapper.order || null;

    // Extract core metadata whether or not we have fullOrder
    const orderId = (fullOrder && fullOrder.id) || eventWrapper.order_id;
    const state = (fullOrder && fullOrder.state) || eventWrapper.state;

    if (!orderId) {
      console.log("❌ No order_id present in event.");
      return res.status(200).send("ok");
    }

    // ---------- ORDER NUMBER (for bubble label) ----------
    let orderNumber = null;
    if (fullOrder) {
      orderNumber =
        fullOrder.ticket_name ||
        fullOrder.order_number ||
        fullOrder.display_id ||
        fullOrder.receipt_number ||
        (fullOrder.id ? fullOrder.id.slice(-6) : null);
    } else {
      // Minimal event: we only have order_id and maybe state
      orderNumber = orderId.slice(-6);
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
    } else if (orders[orderId] && Array.isArray(orders[orderId].items)) {
      // If this is an update event without items, keep what we already know
      items = orders[orderId].items;
    }

    const itemCount = items.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    );

    // Map Square state into our internal status if you ever want to,
    // but for now let the kitchen taps control status.
    const statusFromSquare =
      typeof state === "string" ? state.toLowerCase() : "new";

    const existing = orders[orderId] || {};
    const merged = {
      orderId,
      orderNumber: orderNumber || existing.orderNumber || orderId.slice(-6),
      status: existing.status || "new", // kitchen drives status
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare: statusFromSquare,
    };

    // Save merged order
    orders[orderId] = merged;

    console.log("✅ Parsed / merged order:", merged);

    // Notify KDS screens about (new or updated) order
    broadcast({
      type: "NEW_ORDER",
      ...merged,
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    // Still acknowledge so Square doesn’t retry spam
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

// ---------------- Health ----------------

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// ---------------- Start server ----------------

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
