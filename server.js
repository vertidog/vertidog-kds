// -----------------------
// VertiDog KDS Backend
// -----------------------

const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);

// WebSocket server on /ws
const wss = new WebSocket.Server({
  server,
  path: "/ws",
});

// In-memory order store
// { "155": { orderNumber, status, createdAt, itemCount, items: [...] } }
const orders = {};

app.use(bodyParser.json());

// -----------------------
// HEALTH CHECK
// -----------------------
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// -----------------------
// STATIC FILES (UI + Sounds)
// -----------------------
app.use(express.static(path.join(__dirname, "public")));

// -----------------------
// SERVE KITCHEN SCREEN
// -----------------------
app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

// -----------------------
// WEBSOCKET HANDLING
// -----------------------
wss.on("connection", (ws) => {
  console.log("KDS connected");

  // Send full current state immediately on connection
  ws.send(
    JSON.stringify({
      type: "SYNC_STATE",
      orders: Object.values(orders),
    })
  );

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // Kitchen → Server: order marked ready
      if (data.type === "ORDER_READY") {
        const orderNumber = data.orderNumber;

        if (orders[orderNumber]) {
          orders[orderNumber].status = "ready";

          // Broadcast to ALL screens
          broadcast({
            type: "ORDER_READY_CONFIRM",
            orderNumber,
          });

          console.log(`Order #${orderNumber} marked READY`);
        }
      }

      // Kitchen → Server: requesting full sync
      if (data.type === "SYNC_REQUEST") {
        ws.send(
          JSON.stringify({
            type: "SYNC_STATE",
            orders: Object.values(orders),
          })
        );
      }
    } catch (err) {
      console.error("WebSocket error:", err);
    }
  });

  ws.on("close", () => console.log("KDS disconnected"));
});

// -----------------------
// BROADCAST FUNCTION
// -----------------------
function broadcast(obj) {
  const msg = JSON.stringify(obj);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// -----------------------
// SQUARE WEBHOOK ENDPOINT
// -----------------------
app.post("/square/webhook", (req, res) => {
  try {
    const event = req.body;

    console.log("Square Event:", event.type);

    // We only care about "order.created" events
    if (event.type === "order.created") {
      const order = event.data.object.order;

      // -----------------------
      //  GET ORDER NUMBER
      // -----------------------
      let orderNumber =
        order.ticket_name || // BEST: user-entered ticket name
        order.display_name || // fallback
        (order.id ? order.id.slice(-4) : "0000"); // LAST RESORT: last 4 chars of order ID

      // Extract NUMBERS ONLY so "Order #155" → "155"
      const matched = orderNumber.match(/\d+/);
      if (matched) orderNumber = matched[0];

      // -----------------------
      //  METADATA
      // -----------------------
      const itemCount = Array.isArray(order.line_items)
        ? order.line_items.length
        : null;

      const createdAt = order.created_at
        ? Date.parse(order.created_at)
        : Date.now();

      // Line item details for side panel
      const items = Array.isArray(order.line_items)
        ? order.line_items.map((li) => ({
            name: li.name,
            quantity: li.quantity,
            note: li.note || null,
          }))
        : [];

      // -----------------------
      //  STORE ORDER IN MEMORY
      // -----------------------
      orders[orderNumber] = {
        orderNumber,
        status: "new",
        createdAt,
        itemCount,
        items,
      };

      // -----------------------
      //  BROADCAST TO KITCHEN
      // -----------------------
      broadcast({
        type: "NEW_ORDER",
        orderNumber,
        createdAt,
        itemCount,
        items,
      });

      console.log(`New order received from Square: #${orderNumber}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.sendStatus(500);
  }
});

// -----------------------
// START SERVER
// -----------------------
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
