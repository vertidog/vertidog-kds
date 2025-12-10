// ===============================
// VertiDog KDS Backend – with Square Orders API
// ===============================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require('fs'); // File System module for persistence

const app = express();
const PORT = process.env.PORT || 10000;
const STATE_FILE = path.join(__dirname, 'orders.json'); 

// For Square Orders API
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENV = process.env.SQUARE_ENV || "production"; 
const SQUARE_BASE_URL =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// In-memory store keyed by orderId
const orders = {}; 

// ---------------- KDS STATE MANAGEMENT ----------------
function loadKDSState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            if (data.trim().length > 0) {
                const loadedOrders = JSON.parse(data);
                for (const orderId in loadedOrders) {
                    const order = loadedOrders[orderId];
                    if (order.items) {
                        order.items = order.items.map(item => ({
                            ...item,
                            completed: item.completed ?? false
                        }));
                    }
                    order.isPrioritized = order.isPrioritized ?? false;
                }
                Object.assign(orders, loadedOrders); 
                console.log(`Loaded KDS state from ${STATE_FILE}.`);
            }
        }
    } catch (error) {
        console.error('Error loading state file:', error.message);
    }
}

function saveKDSState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(orders, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving state file:', error.message);
    }
}

loadKDSState();
// ---------------- END STATE MANAGEMENT ----------------

// ---------------- KDS SEQUENTIAL COUNTER (FOR TEST ENDPOINT ONLY) ----------------
let testOrderCounter = 0; 
function getNextTestTicketNumber() {
    testOrderCounter++;
    if (testOrderCounter > 999) { testOrderCounter = 1; }
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

async function fetchOrderFromSquare(orderId) {
  if (!SQUARE_ACCESS_TOKEN) return null;
  try {
    const resp = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-03-20", 
      },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.order || null;
  } catch (err) {
    return null;
  }
}

// ---------------- HTTP + WebSocket server ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "ORDER_READY" && data.orderNumber) {
        const orderToMark = Object.values(orders).find((o) => o.orderNumber === data.orderNumber);
        if (orderToMark) {
          orderToMark.status = "ready";
          orders[orderToMark.orderId] = orderToMark; 
          saveKDSState(); 
          broadcast({ type: "ORDER_READY_CONFIRM", orderNumber: orderToMark.orderNumber, });
        }
      } else if (data.type === "ORDER_REACTIVATED" && data.orderNumber) {
        const orderToMark = Object.values(orders).find((o) => o.orderNumber === data.orderNumber);
        if (orderToMark) {
          orderToMark.status = "in-progress";
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); 
          broadcast({ type: "NEW_ORDER", ...orderToMark, });
        }
      } else if (data.type === "ORDER_CANCELLED" && data.orderNumber) {
        const orderToMark = Object.values(orders).find((o) => o.orderNumber === data.orderNumber);
        if (orderToMark) {
          orderToMark.status = "cancelled";
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); 
          broadcast({ type: "NEW_ORDER", ...orderToMark, });
        }
      } else if (data.type === "ORDER_ITEM_TOGGLE" && data.orderNumber) { // Added for completeness
        const order = orders[data.orderId];
        if (order && order.items[data.itemIndex]) {
            order.items[data.itemIndex].completed = data.completed;
            saveKDSState();
            // Send update to clients
            broadcast({ 
                type: 'ORDER_ITEM_TOGGLE', 
                orderNumber: data.orderNumber,
                itemIndex: data.itemIndex,
                completed: data.completed
            });
        }
      } else if (data.type === "SYNC_REQUEST") {
        ws.send(JSON.stringify({ type: "SYNC_STATE", orders: Object.values(orders) }));
      }
    } catch (e) {
      console.error("Error processing client message:", e);
    }
  });

  // Initial sync request on connect
  ws.send(JSON.stringify({ type: "SYNC_STATE", orders: Object.values(orders) }));
});

// ---------------- Middleware + static ----------------

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/kitchen", (req, res) => { res.sendFile(path.join(__dirname, "public", "kitchen.html")); });
app.get("/", (req, res) => res.redirect("/kitchen"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// ---------------- Square Webhook ----------------

app.post("/square/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const objectWrapper = body.data?.object || {};

    let eventWrapper = objectWrapper.order || objectWrapper.order_created || objectWrapper.order_updated || null;
    if (!eventWrapper) return res.status(200).send("ok");

    let fullOrder = eventWrapper.order || null;
    const orderId = (fullOrder && fullOrder.id) || eventWrapper.order_id;
    const state = (fullOrder && fullOrder.state) || eventWrapper.state;
    if (!orderId) return res.status(200).send("ok");

    if (!fullOrder || !Array.isArray(fullOrder.line_items)) {
      const fetched = await fetchOrderFromSquare(orderId);
      if (fetched) fullOrder = fetched;
    }

    const existing = orders[orderId] || {};
    const previousKdsStatus = existing.status; 
    
    // --- STATUS LOCK LOGIC (from previous fix) ---
    let kdsStatus = previousKdsStatus || "new";
    const stateFromSquare = typeof state === "string" ? state.toLowerCase() : "";

    if (stateFromSquare === "canceled" || stateFromSquare === "closed") {
        kdsStatus = "cancelled";
    }
    else if (previousKdsStatus && (previousKdsStatus === 'ready' || previousKdsStatus === 'cancelled')) {
        kdsStatus = previousKdsStatus; 
    }
    // --- END STATUS LOCK LOGIC ---

    // --- NEW DATA EXTRACTION ---
    let orderNumber = fullOrder?.display_id || fullOrder?.order_number || orderId.slice(-6);
    
    // 1. ITEMS (with VARIATION name)
    let items = existing.items || [];
    if (fullOrder && Array.isArray(fullOrder.line_items)) {
        items = fullOrder.line_items.map(li => {
            const baseName = li.name || "Item";
            const variationName = li.variation_name ? li.variation_name.trim() : null;
            // Combines Name and Variation if they are different
            const displayName = variationName && variationName.toLowerCase() !== baseName.toLowerCase()
                ? `${baseName} - ${variationName}`
                : baseName;

            return { 
                name: displayName, 
                quantity: toNumberQuantity(li.quantity || 1), 
                modifiers: li.modifiers?.map(m => m.name).filter(Boolean) || [], 
                completed: false, // Default item completion status for new item
            };
        });
    }

    // 2. SERVICE TYPE (Fulfillment Type)
    // Find the first fulfillment type, default to DINE_IN if none found
    let serviceType = 'DINE IN';
    if (fullOrder && Array.isArray(fullOrder.fulfillments) && fullOrder.fulfillments.length > 0) {
        serviceType = fullOrder.fulfillments[0].type.replace('_', ' '); // E.g., 'PICKUP', 'DELIVERY'
    }

    // 3. ORDER NOTE (Customer Comments)
    const customerNote = fullOrder?.note || null;
    // --- END NEW DATA EXTRACTION ---


    const itemCount = items.reduce((sum, it) => sum + toNumberQuantity(it.quantity), 0);
    
    const merged = {
      orderId,
      orderNumber, 
      status: kdsStatus, 
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare,
      serviceType, // ADDED
      customerNote, // ADDED
    };

    orders[orderId] = merged;
    saveKDSState(); // Persist order state after webhook update

    // Suppress broadcast if status is locked and hasn't changed
    let statusChanged = merged.status !== previousKdsStatus;
    let shouldBroadcast = true;
    
    if (previousKdsStatus) { 
        if (!statusChanged && (merged.status === 'cancelled' || merged.status === 'ready')) {
            shouldBroadcast = false;
        }
    }

    if (shouldBroadcast) {
        broadcast({ type: "NEW_ORDER", ...merged });
    }

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
    itemCount: 9,
    serviceType: "PICKUP", // Test Service Type
    customerNote: "Please make the drinks first.", // Test Comment
    items: [
      { name: "VertiDog - Classic", quantity: 4, modifiers: ["Mustard", "Ketchup"], completed: false },
      { name: "Large Soda - Sprite", quantity: 3, modifiers: ["No Ice"], completed: false },
      { name: "Chili Cheese Fries", quantity: 2, modifiers: ["Extra Chili"], completed: false },
    ],
  };
  orders[orderId] = order;
  saveKDSState();
  broadcast({ type: "NEW_ORDER", ...order });
  res.send(`Test order #${ticketNum} sent to KDS`);
});

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
