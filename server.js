// ===============================
// VertiDog KDS Backend – with Square Orders API
// ===========================================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require('fs'); // <--- ADDED: File System module for persistence

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_FILE = path.join(__dirname, 'orders.json'); // <--- ADDED: Persistence file path

// For Square Orders API
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENV = process.env.SQUARE_ENV || "production"; 
const SQUARE_BASE_URL =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// In-memory store keyed by orderId
const orders = {};

// ---------------- Persistence Helpers ----------------

function saveKDSState() {
    try {
        // Only save the necessary fields (ID, orderNumber, KDS status, and creation time)
        const simplifiedOrders = Object.values(orders).map(o => ({
            orderId: o.orderId,
            orderNumber: o.orderNumber,
            status: o.status,
            createdAt: o.createdAt
        }));
        fs.writeFileSync(DATA_FILE, JSON.stringify(simplifiedOrders, null, 4), 'utf8');
        console.log('💾 KDS state saved.');
    } catch (e) {
        console.error("❌ Error saving KDS state:", e);
    }
}

function loadKDSState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const simplifiedOrders = JSON.parse(data);
            
            // Merge loaded KDS status into the 'orders' object
            simplifiedOrders.forEach(o => {
                const existingOrder = orders[o.orderId] || {};
                
                // CRITICAL FIX: Prioritize the persistent status from the file
                orders[o.orderId] = {
                    ...existingOrder,       // Keep any other keys (like items/itemCount) if they were loaded first
                    orderId: o.orderId,
                    orderNumber: o.orderNumber,
                    status: o.status,       // <--- PERSISTENT STATUS WINS
                    createdAt: o.createdAt  // Keep the original timestamp
                };
            });
            console.log(`✅ Loaded ${simplifiedOrders.length} orders from disk. Persistent status applied.`);
        }
    } catch (e) {
        console.error("❌ Error loading KDS state:", e);
    }
}

loadKDSState(); // <--- CRITICAL FIX: Load state on server startup

// ---------------- KDS SEQUENTIAL COUNTER (FOR TEST ENDPOINT ONLY) ----------------
let testOrderCounter = 0; 

function getNextTestTicketNumber() {
    testOrderCounter++;
    if (testOrderCounter > 999) {
        testOrderCounter = 1; 
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

wss.on("connection", (ws) => {
  console.log("KDS connected");

  // Handle messages from the client (e.g., status changes)
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("Client message received:", data.type);
      
      let orderToUpdate;
      
      // Determine which key to use (orderId is mandatory for persistence)
      const orderKey = data.orderId || (data.orderNumber && Object.values(orders).find(o => o.orderNumber === data.orderNumber)?.orderId);
      if (!orderKey) {
        if (data.type !== "SYNC_REQUEST") console.log(`⚠️ Cannot process message ${data.type}: orderKey missing.`);
        // Continue to SYNC_REQUEST if no key is found
      } else {
        orderToUpdate = orders[orderKey];
      }
      
      if (data.type === "ORDER_READY" && orderToUpdate) {
        
          orderToUpdate.status = "ready";
          orders[orderKey] = orderToUpdate; 
          saveKDSState(); // <--- FIX: Save status change
          
          broadcast({
            type: "ORDER_READY_CONFIRM",
            orderNumber: orderToUpdate.orderNumber,
          });

      } else if (data.type === "ORDER_REACTIVATED" && orderToUpdate) { // <--- ADDED: Client dragged to active
          
          orderToUpdate.status = 'in-progress'; 
          orders[orderKey] = orderToUpdate; 
          saveKDSState(); // <--- FIX: Save status change

          broadcast({
            type: "NEW_ORDER", // Sends full order to trigger client update
            ...orderToUpdate,
          });

      } else if (data.type === "ORDER_SKIPPED_DONE" && orderToUpdate) { // <--- ADDED: Client dragged to done or force-tapped done
          
          orderToUpdate.status = 'done'; 
          orders[orderKey] = orderToUpdate; 
          saveKDSState(); // <--- FIX: Save status change

          broadcast({
            type: "NEW_ORDER",
            ...orderToUpdate,
          });

      } else if (data.type === "SYNC_REQUEST") {
        // Handle explicit sync request from kitchen.html connect()
        ws.send(
          JSON.stringify({
            type: "SYNC_STATE",
            // CRITICAL FILTER: Only send active/ready/new orders on initial sync (filter out 'done'/'cancelled')
            orders: Object.values(orders).filter(o => o.status !== 'done' && o.status !== 'cancelled'),
          })
        );
      }
    } catch (e) {
      console.error("Error processing client message:", e);
    }
  });

  // Initial sync request (only send active orders)
  ws.send(
    JSON.stringify({
      type: "SYNC_STATE",
      orders: Object.values(orders).filter(o => o.status !== 'done' && o.status !== 'cancelled'),
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
    const state = (fullOrder && fullOrder.state) || eventWrapper.state;

    if (!orderId) {
      console.log("❌ No order_id present in event.");
      return res.status(200).send("ok");
    }

    if (!fullOrder || !Array.isArray(fullOrder.line_items)) {
      const fetched = await fetchOrderFromSquare(orderId);
      if (fetched) {
        fullOrder = fetched;
      }
    }

    // ---------- ORDER NUMBER ----------
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
    // ---------- END ORDER NUMBER ASSIGNMENT ----------

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
      items = orders[orderId].items;
    }

    const itemCount = items.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    );
    const stateFromSquare = typeof state === "string" ? state.toLowerCase() : "";

    const existing = orders[orderId] || {};
    
    // --- ULTIMATE KDS STATUS LOCK FIX ---
    
    let kdsStatus = existing.status || "new";
    
    // Rule 1: Cancellation is the only update that can override any KDS status.
    if (stateFromSquare === "canceled" || stateFromSquare === "closed") {
        kdsStatus = "cancelled";
    }
    
    // Rule 2 (THE CRITICAL PART): If the order already exists in our KDS memory 
    // AND it has been touched (i.e., status is NOT 'new'), we NEVER override 
    // the existing KDS status with a general Square update (like 'OPEN').
    if (existing.status && existing.status !== 'new' && kdsStatus !== 'cancelled') {
        kdsStatus = existing.status;
    }
    
    // --- END ULTIMATE KDS STATUS LOCK FIX ---

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

    saveKDSState(); // <--- FIX: Save state after any Square update

    console.log("✅ Final KDS order object:", merged);

    broadcast({
      type: "NEW_ORDER",
      ...merged,
    });
    
    console.log(`📊 Total orders in memory: ${Object.keys(orders).length}`); 

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

  saveKDSState(); // <--- FIX: Save state after test order

  broadcast({
    type: "NEW_ORDER",
    ...order,
  });

  res.send(`Test order #${ticketNum} sent to KDS`);
  console.log(`📊 Total orders in memory: ${Object.keys(orders).length}`);
});

// ---------------- Start server ----------------

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
