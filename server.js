// ======================================
// VertiDog KDS Backend
// - Express + WebSocket
// - Square Webhook + Orders API
// - Umbrella item + variation + modifiers
// ======================================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");

// ------------------ Config ------------------

const app = express();
const PORT = process.env.PORT || 10000;

// Square credentials via env vars (Render)
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "production";

const SQUARE_BASE_URL =
  SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// In-memory order store, keyed by orderId
// { [orderId]: { orderId, orderNumber, status, createdAt, itemCount, items[], stateFromSquare } }
const orders = {};

// ------------------ Helpers ------------------

function toNumberQuantity(q) {
  if (q === undefined || q === null) return 0;
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}

// Build display items from Square line_items
// - Uses variation_name + umbrella name
// - Includes modifiers by name
function buildItemsFromLineItems(lineItems, previousItems = []) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    // if we don't have anything new, keep what we had
    return previousItems;
  }

  return lineItems.map((li) => {
    const qty = toNumberQuantity(li.quantity || 1);

    const umbrella = li.name || ""; // e.g. "VertiDog", "Soda"
    const variation = li.variation_name || ""; // e.g. "Classic", "Coca-Cola"

    let displayName;

    if (
      variation &&
      umbrella &&
      variation.toLowerCase() !== umbrella.toLowerCase()
    ) {
      // Show variation + umbrella: "Classic (VertiDog)"
      displayName = `${variation} (${umbrella})`;
    } else {
      // Fall back to whatever we have
      displayName = variation || umbrella || "Item";
    }

    const modifiers = Array.isArray(li.modifiers)
      ? li.modifiers.map((m) => m.name).filter(Boolean)
      : [];

    return {
      name: displayName,
      quantity: qty || 1,
      modifiers,
    };
  });
}

function broadcast(msgObj) {
  const data = JSON.stringify(msgObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

// Fetch full order details from Square Orders API
async function fetchOrderFromSquare(orderId) {
  if (!SQUARE_ACCESS_TOKEN) {
    console.log("⚠️ SQUARE_ACCESS_TOKEN not set; cannot call Orders API.");
    return null;
  }

  try {
    const resp = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-03-20",
      },
    });

    if (!resp.ok) {
      console.log(
        "❌ Orders API error:",
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

// ------------------ HTTP + WebSocket ------------------

const server = http.createServer(app);

// WebSocket on /ws for kitchen screens
const wss = new WebSocketServer({
  server,
  path: "/ws",
});

wss.on("connection", (ws) => {
  console.log("KDS connected");

  // Send current state immediately
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

// ------------------ Middleware & Static ------------------

app.use(bodyParser.json());

// Serve static files (kitchen.html, sounds, etc.)
app.use(express.static(path.join(__dirname, "public")));

// Kitchen screen
app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kitchen.html"));
});

// Convenience root -> /kitchen
app.get("/", (req, res) => {
  res.redirect("/kitchen");
});

// Health check
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// ------------------ Square Webhook ------------------

app.post("/square/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("🔔 Square Webhook Received:", JSON.stringify(body));

    const eventType = body.type;
    console.log("Square Event:", eventType);

    const dataObj = body.data || {};
    const objectWrapper = dataObj.object || {};

    // Webhook variations:
    // { order: { ... } }
    // { order_created: { order, order_id, state } }
    // { order_updated: { order, order_id, state } }
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

    let fullOrder = eventWrapper.order || null;
    const orderId = (fullOrder && fullOrder.id) || eventWrapper.order_id;

    if (!orderId) {
      console.log("❌ No order_id present in webhook payload.");
      return res.status(200).send("ok");
    }

    const state =
      (fullOrder && fullOrder.state) || eventWrapper.state || "OPEN";

    // If webhook didn't include full order (no line_items), call Orders API
    if (!fullOrder || !Array.isArray(fullOrder.line_items)) {
      const fetched = await fetchOrderFromSquare(orderId);
      if (fetched) {
        fullOrder = fetched;
      }
    }

    // ---------- Determine order number for bubble ----------
    let orderNumber = null;
    if (fullOrder) {
      orderNumber =
        fullOrder.ticket_name ||
        fullOrder.order_number ||
        fullOrder.display_id ||
        fullOrder.receipt_number ||
        (fullOrder.id ? fullOrder.id.slice(-6).toUpperCase() : null);
    }
    if (!orderNumber) {
      orderNumber = orderId.slice(-6).toUpperCase();
    }

    // ---------- Build items with variations + modifiers ----------
    const existing = orders[orderId] || {};
    let items = [];

    if (fullOrder && Array.isArray(fullOrder.line_items)) {
      items = buildItemsFromLineItems(fullOrder.line_items, existing.items);
    } else if (existing.items) {
      items = existing.items;
    }

    const itemCount = items.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    );

    const stateFromSquare =
      typeof state === "string" ? state.toLowerCase() : "";

    const orderObj = {
      orderId,
      orderNumber,
      status: existing.status || "new", // Kitchen controls this via taps
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare,
    };

    orders[orderId] = orderObj;

    console.log("✅ Final KDS order object:", orderObj);

    broadcast({
      type: "NEW_ORDER",
      ...orderObj,
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    // Return 200 so Square does not spam retries while we debug
    return res.status(200).send("error");
  }
});

// ------------------ Test Endpoint (manual simulation) ------------------

app.get("/test-order", (req, res) => {
  const num = Math.floor(Math.random() * 900 + 100);
  const orderId = `TEST-${num}`;

  const items = [
    {
      name: "Classic (VertiDog)",
      quantity: 1,
      modifiers: ["Garlic White VertiSauce", "Ketchup"],
    },
    {
      name: "Coca-Cola (Soda)",
      quantity: 1,
      modifiers: [],
    },
  ];

  const orderObj = {
    orderId,
    orderNumber: String(num),
    status: "new",
    createdAt: Date.now(),
    items,
    itemCount: items.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    ),
    stateFromSquare: "open",
  };

  orders[orderId] = orderObj;

  broadcast({
    type: "NEW_ORDER",
    ...orderObj,
  });

  res.send(`Test order #${num} sent to KDS`);
});

// ------------------ Start server ------------------

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
