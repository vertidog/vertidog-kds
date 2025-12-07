// ===============================
// VertiDog KDS Backend (Full)
// ===============================

const express = require("express");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");
const app = express();

// Render requires this — do NOT hardcode the port
const PORT = process.env.PORT || 10000;

// Parse JSON webhook bodies
app.use(bodyParser.json());

// Serve public folder (kitchen.html, sounds, etc.)
app.use(express.static(path.join(__dirname, "public")));

// In-memory store of orders
let orders = {};

// ======================================================
//  WebSocket server for live KDS screens
// ======================================================
const server = app.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("KDS connected");

  ws.on("close", () => {
    console.log("KDS disconnected");
  });

  // Send full state on connect
  ws.send(
    JSON.stringify({
      type: "SYNC",
      orders,
    })
  );
});

// Helper: broadcast to all KDS screens
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

// ======================================================
//  Square Webhook Receiver
// ======================================================
app.post("/square/webhook", (req, res) => {
  try {
    console.log("🔔 Square Webhook Received:", JSON.stringify(req.body));

    const eventType = req.body?.type;
    console.log("Square Event:", eventType);

    // Extract order object safely
    const payloadObj = req.body?.data?.object || {};
    const order = payloadObj.order || payloadObj;

    if (!order) {
      console.log("❗ No order object found in webhook payload.");
      return res.status(200).send(); // always ACK Square
    }

    // Build order number safely with fallbacks
    const orderNumber =
      order.ticket_name ||
      order.display_id ||
      (order.id ? order.id.slice(-4) : "TEST");

    // Extract line items safely
    const lineItems = Array.isArray(order.line_items)
      ? order.line_items
      : [];

    const items = lineItems.map((li) => ({
      name: li.name || "Item",
      quantity: Number(li.quantity || 1),
    }));

    const itemCount = items.reduce((sum, it) => sum + it.quantity, 0);

    // Construct final clean order
    const newOrder = {
      orderNumber: String(orderNumber),
      status: "new",
      createdAt: Date.now(),
      itemCount,
      items,
    };

    console.log("✅ Parsed Webhook Order:", newOrder);

    // Save to memory
    orders[newOrder.orderNumber] = newOrder;

    // Broadcast NEW ORDER to all kitchen screens
    broadcast({
      type: "NEW_ORDER",
      ...newOrder,
    });

    return res.status(200).send(); // always return 200 to Square
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.status(200).send(); // still ACK, avoid retries
  }
});

// ======================================================
//  Optional: endpoint to manually test orders
// ======================================================
app.get("/test-order", (req, res) => {
  const testNum = Math.floor(Math.random() * 900 + 100);
  const newOrder = {
    orderNumber: String(testNum),
    status: "new",
    createdAt: Date.now(),
    itemCount: 2,
    items: [
      { name: "Hot Dog", quantity: 1 },
      { name: "Coke", quantity: 1 },
    ],
  };

  orders[newOrder.orderNumber] = newOrder;
  broadcast({ type: "NEW_ORDER", ...newOrder });

  res.send("Test order sent to KDS!");
});

// ======================================================
//  Default Route
// ======================================================
app.get("/", (req, res) => {
  res.send("VertiDog KDS backend running.");
});
