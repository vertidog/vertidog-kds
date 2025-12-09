// ===============================
// VertiDog KDS Backend – with Square Orders API
// ===============================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require('fs'); // <--- 1. ADDED: File system module for persistence

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
let orders = {}; // <--- Changed to `let` for re-assignment in loadKDSState

// ---------------- Persistence Functions ----------------
const ORDERS_FILE = path.join(__dirname, "orders.json");

function saveKDSState() {
  try {
    const data = JSON.stringify(orders, null, 2);
    fs.writeFileSync(ORDERS_FILE, data);
    console.log("📝 KDS state saved.");
  } catch (err) {
    console.error("❌ Error saving KDS state:", err);
  }
}

function loadKDSState() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const data = fs.readFileSync(ORDERS_FILE, "utf8");
      orders = JSON.parse(data);
      console.log(`✅ KDS state loaded: ${Object.keys(orders).length} orders.`);
    } else {
      fs.writeFileSync(ORDERS_FILE, JSON.stringify({}));
      console.log("ℹ️ orders.json not found, created empty file and starting with empty state.");
    }
  } catch (err) {
    console.error("❌ Error loading KDS state:", err);
  }
}
// ---------------- End Persistence ----------------

// ---------------- KDS SEQUENTIAL COUNTER (FOR TEST ENDPOINT ONLY) ----------------
let testOrderCounter = 0; 

function getNextTestTicketNumber() {
    testOrderCounter++;
    if (testOrderCounter > 999) {
        testOrderCounter = 1; // Reset to 001 after 999
    }
    return String(testOrderCounter).padStart(3, '0'); 
}
// ---------------- End Test Counter ----------------

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
        "Square-Version": "2024-03-20",
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

loadKDSState(); // <--- 2. CALLED AT STARTUP

wss.on("connection", (ws) => {
  console.log("KDS connected");

  // Handle messages from the client (e.g., status changes)
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("Client message received:", data.type);

      if (data.type === "ORDER_READY" && data.orderNumber) {
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );

        if (orderToMark) {
          orderToMark.status = "ready";
          orders[orderToMark.orderId] = orderToMark; 
          saveKDSState(); // <--- 3. SAVING STATE ON STATUS CHANGE

          broadcast({
            type: "ORDER_READY_CONFIRM",
            orderNumber: orderToMark.orderNumber,
          });
        }
      } else if (data.type === "ORDER_REACTIVATED" && data.orderNumber) {
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );
        if (orderToMark) {
          orderToMark.status = "in-progress";
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); // <--- 3. SAVING STATE ON REACTIVATE
          broadcast({
             type: "NEW_ORDER",
             ...orderToMark,
          });
        }
      } else if (data.type === "ORDER_SKIPPED_DONE" && data.orderNumber) {
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );
        if (orderToMark) {
          orderToMark.status = "done";
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); // <--- 3. SAVING STATE ON SKIPPED DONE
          broadcast({
             type: "NEW_ORDER",
             ...orderToMark,
          });
        }
      } else if (data.type === "SYNC_REQUEST") {
        ws.send(
          JSON.stringify({
            type: "SYNC_STATE",
            orders: Object.values(orders), // <--- 4. FIXED: SEND ALL ORDERS
          })
        );
      }
    } catch (e) {
      console.error("Error processing client message:", e);
    }
  });

  // Initial sync request (send ALL orders)
  ws.send(
    JSON.stringify({
      type: "SYNC_STATE",
      orders: Object.values(orders), // <--- 4. FIXED: SEND ALL ORDERS
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
    const dataObj = body.data || {};
    const objectWrapper = dataObj.object || {};

    let eventWrapper =
      objectWrapper.order ||
      objectWrapper.order_created ||
      objectWrapper.order_updated ||
      null;

    if (!eventWrapper) {
      return res.status(200).send("ok");
    }

    let fullOrder = eventWrapper.order || null;
    const orderId = (fullOrder && fullOrder.id) || eventWrapper.order_id;
    const state = (fullOrder && fullOrder.state) || eventWrapper.state;

    if (!orderId) {
      return res.status(200).send("ok");
    }

    if (!fullOrder || !Array.isArray(fullOrder.line_items)) {
      const fetched = await fetchOrderFromSquare(orderId);
      if (fetched) {
        fullOrder = fetched;
      }
    }

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
      items = orders[orderId].items;
    }

    const itemCount = items.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    );
    const stateFromSquare = typeof state === "string" ? state.toLowerCase() : "";

    const existing = orders[orderId] || {};
    
    // --- KDS STATUS LOGIC ---
    let kdsStatus = existing.status || "new";
    
    // Rule 1: Cancellation is the only update that can override any KDS status.
    if (stateFromSquare === "canceled" || stateFromSquare === "closed") {
        kdsStatus = "cancelled"; // <--- This sends the order to Completed/Cancelled
    }
    
    // Rule 2: Lock the status if the kitchen has already acted (unless cancelled)
    if (existing.status && existing.status !== 'new' && kdsStatus !== 'cancelled') {
        kdsStatus = existing.status;
    }
    // --- END KDS STATUS LOGIC ---

    const merged = {
      orderId,
      orderNumber: orderNumber || existing.orderNumber || orderId.slice(-6),
      status: kdsStatus, // Use the determined status
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare,
    };

    orders[orderId] = merged;

    saveKDSState(); // <--- 3. SAVING STATE ON WEBHOOK RECEIPT

    broadcast({
      type: "NEW_ORDER",
      ...merged,
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.status(200).send("error");
  }
});

// ---------------- Test endpoint ----------------

app.get("/test-order", (req, res) => {
  const ticketNum = getNextTestTicketNumber();
  const orderId = `TEST-${ticketNum}-${Date.now()}`;
  const order = {
    orderId,
    orderNumber: ticketNum,
    status: "new",
    createdAt: Date.now(),
    items: [
      { name: "Hot Dog", quantity: 1, modifiers: ["No Pickle", "Extra Ketchup"] },
      { name: "Coke", quantity: 1, modifiers: [] },
      { name: "Fries", quantity: 2, modifiers: ["Well Done"] },
    ],
  };
  order.itemCount = order.items.reduce((sum, it) => sum + it.quantity, 0);
  orders[orderId] = order;
  saveKDSState(); // <--- 3. SAVING STATE ON TEST ORDER

  broadcast({
    type: "NEW_ORDER",
    ...order,
  });

  res.send(`Test order #${ticketNum} sent to KDS`);
});

// ---------------- Start server ----------------

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
