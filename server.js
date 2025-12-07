const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
app.use(bodyParser.json());

// -----------------------------------------------------------------------------
// WEBSOCKET SERVER
// -----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(order) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(order));
    }
  });
}

wss.on("connection", (ws) => {
  console.log("KDS connected");
  ws.on("close", () => console.log("KDS disconnected"));
});

// -----------------------------------------------------------------------------
// STATIC FILES
// -----------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

// -----------------------------------------------------------------------------
// WEBHOOK HANDLER
// -----------------------------------------------------------------------------
app.post("/square/webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("🔔 Square Webhook Received:", JSON.stringify(event));

    const type = event.type;
    console.log("Square Event:", type);

    if (type !== "order.created" && type !== "order.updated") {
      return res.status(200).send("Ignored");
    }

    const orderObj = event.data?.object?.order;
    if (!orderObj) {
      console.log("❌ No order object in webhook");
      return res.status(200).send("Missing order");
    }

    // -------------------------------------------------------------------------
    // FIX 1 — Use receipt_number OR short hash fallback
    // -------------------------------------------------------------------------
    const orderNumber =
      orderObj.receipt_number ||
      orderObj.ticket_name ||
      orderObj.id.slice(-6).toUpperCase();

    // -------------------------------------------------------------------------
    // FIX 2 — Extract items properly for real POS orders
    // -------------------------------------------------------------------------
    const items = (orderObj.line_items || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      modifiers: item.modifiers
        ? item.modifiers.map((m) => m.name)
        : [],
    }));

    const parsed = {
      orderNumber,
      status: orderObj.state?.toLowerCase() || "new",
      createdAt: Date.now(),
      itemCount: items.length,
      items,
    };

    console.log("✅ Parsed Webhook Order:", parsed);

    // Broadcast to KDS
    broadcast({
      type: "new_order",
      payload: parsed,
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("Error");
  }
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`VertiDog KDS backend running on port ${PORT}`);
});
