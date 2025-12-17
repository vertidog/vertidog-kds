// ===============================
// VertiDog KDS Backend – with Square Orders API
// ===============================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require('fs'); // ADDED: File System module for persistence

// NOTE: crypto module needed for signature verification (postponed)
// const crypto = require("crypto"); 

const app = express();
const PORT = process.env.PORT || 10000;
const STATE_FILE = path.join(__dirname, 'orders.json'); // ADDED: Path for state file

// For Square Orders API
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENV = process.env.SQUARE_ENV || "production"; // or "sandbox"
const SQUARE_BASE_URL =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// In-memory store keyed by orderId
const orders = {};

// ---------------- KDS STATE MANAGEMENT (ADDED) ----------------

function loadKDSState() {
    try {
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        
        if (data.trim().length === 0) { 
            console.log(`State file ${STATE_FILE} is empty. Starting with empty state.`);
            return;
        }
        
        // When loading, ensure all necessary fields exist for stability
        const loadedOrders = JSON.parse(data);
        for (const orderId in loadedOrders) {
            const order = loadedOrders[orderId];
            order.status = normalizeStatus(order.status);
            if (order.items) {
                order.items = order.items.map(item => ({
                    ...item,
                    completed: item.completed ?? false
                }));
            }
            order.isPrioritized = order.isPrioritized ?? false;
            const readyTs = Number(order.readyAt);
            order.readyAt = Number.isFinite(readyTs) ? readyTs : null;
        }
        Object.assign(orders, loadedOrders);
        console.log(`Loaded KDS state from ${STATE_FILE}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`State file ${STATE_FILE} not found. Starting with empty state.`);
        } else if (error instanceof SyntaxError) {
            console.error(`Error: The state file ${STATE_FILE} contains incomplete or corrupt JSON. Resetting state.`);
        } else {
            console.error('Error loading KDS state:', error.message);
        }
    }
}

function saveKDSState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(orders, null, 2), 'utf8');
        // console.log(`KDS state saved to ${STATE_FILE}`); // Commented out to reduce log noise
    } catch (error) {
        console.error('Error saving KDS state:', error.message);
    }
}

loadKDSState(); // Call on startup

// ---------------- KDS SEQUENTIAL COUNTER (FOR TEST ENDPOINT ONLY) ----------------
// This counter is only used by the /test-order endpoint to simulate clean Square numbers
let testOrderCounter = 0; 

function getNextTestTicketNumber() {
    testOrderCounter++;
    if (testOrderCounter > 999) {
        testOrderCounter = 1; // Reset to 001 after 999
    }
    // Format to 3 digits (e.g., 1 -> "001")
    return String(testOrderCounter).padStart(3, '0'); 
}
// ---------------- End Test Counter ----------------

// ---------------- Helpers ----------------

function toNumberQuantity(q) {
  if (q === undefined || q === null) return 0;
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}

function normalizeStatus(status) {
  if (!status) return status;
  const lower = String(status).toLowerCase();
  if (lower === "cancelled" || lower === "canceled" || lower === "completed") {
    return "done";
  }
  return lower;
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

// Utility to locate orders by either internal ID or display number
function findOrderByIdentifier(idOrNumber) {
  if (!idOrNumber) return null;
  if (orders[idOrNumber]) return orders[idOrNumber];
  return (
    Object.values(orders).find((o) => o.orderNumber === idOrNumber) || null
  );
}

function markOrderReady(order) {
  if (!order) return null;
  order.status = "ready";
  order.readyAt = Date.now();
  if (Array.isArray(order.items)) {
    order.items = order.items.map((item) => ({ ...item, completed: true }));
  }
  orders[order.orderId] = order;
  saveKDSState();

  const payload = {
    type: "ORDER_READY_CONFIRM",
    orderNumber: order.orderNumber,
  };
  broadcast(payload);
  return order;
}

// ---------------- HTTP + WebSocket server ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("KDS connected");

  // Initial sync: Send ALL known orders
  ws.send(
    JSON.stringify({
      type: "SYNC_STATE",
      orders: Object.values(orders),
    })
  );

  // Handle messages from the client (e.g., status changes)
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("Client message received:", data.type);

      if (data.type === "SYNC_REQUEST") {
        // Handle explicit sync request from kitchen.html connect()
        ws.send(
          JSON.stringify({
            type: "SYNC_STATE",
            // Send ALL orders for client-side filtering/counts
            orders: Object.values(orders),
          })
        );
      } 
      
      // KDS FEATURE: Toggle Item Completion (triggers status change)
      else if (data.type === 'ITEM_COMPLETED' && data.orderNumber !== undefined && data.itemIndex !== undefined) {
          const orderToMark = Object.values(orders).find(o => o.orderNumber === data.orderNumber);
          if (orderToMark && orderToMark.items[data.itemIndex]) {
              const order = orderToMark;
              const item = order.items[data.itemIndex];
              item.completed = data.completed;

              // Automatically set status to in-progress if starting completion
              if (order.status === 'new' && data.completed) {
                  order.status = 'in-progress';
              }
              
              // If all items are complete, transition the order status to ready
              if (data.allCompleted) {
                  markOrderReady(order);
              } else {
                  saveKDSState();
                  broadcast({
                      type: 'ITEM_COMPLETED_CONFIRM',
                      orderNumber: data.orderNumber,
                      itemIndex: data.itemIndex,
                      completed: data.completed,
                      allCompleted: data.allCompleted
                  });
                  
                  // Broadcast general status update if it went from 'new' to 'in-progress'
                  if (order.status !== 'ready') {
                      broadcast({ 
                          type: 'ORDER_STATUS_UPDATE', 
                          orderNumber: data.orderNumber, 
                          status: order.status 
                      });
                  }
              }
          }
      }
      
      // KDS FEATURE: Toggle Priority
      else if (data.type === 'ORDER_PRIORITY_TOGGLE' && data.orderNumber) {
          const orderToMark = Object.values(orders).find(o => o.orderNumber === data.orderNumber);
          if (orderToMark) {
              orderToMark.isPrioritized = data.isPrioritized;
              orders[orderToMark.orderId] = orderToMark;
              saveKDSState();
              broadcast({
                  type: 'ORDER_PRIORITY_TOGGLE',
                  orderNumber: orderToMark.orderNumber,
                  isPrioritized: data.isPrioritized
              });
          }
      } 
      
      // KDS FEATURE: Order marked Ready (e.g., from cycleStatus on client)
      else if (data.type === "ORDER_READY" && data.orderNumber) {
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );

        if (orderToMark) {
          markOrderReady(orderToMark);
        }
      }
      
      // KDS FEATURE: Order marked Completed (done)
      else if (data.type === "ORDER_COMPLETED" && data.orderNumber) {
          const orderToMark = Object.values(orders).find(o => o.orderNumber === data.orderNumber);
          if (orderToMark) {
              orderToMark.status = 'done';
              orders[orderToMark.orderId] = orderToMark;
              saveKDSState(); // Save state
              broadcast({
                  type: "ORDER_STATUS_UPDATE",
                  orderNumber: orderToMark.orderNumber,
                  status: 'done'
              });
          }
      }
      
      // KDS FEATURE: Recall/Reactivate
      else if (data.type === "ORDER_REACTIVATED" && data.orderNumber) {
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );

        if (orderToMark) {
          orderToMark.status = "in-progress";
          orderToMark.items.forEach(item => item.completed = false); // Reset item completion
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); // Save state

          console.log(`Order ${data.orderNumber} RECALLED/REACTIVATED.`);
          
          broadcast({
            type: "NEW_ORDER", 
            ...orderToMark,
          });
        }
      } 
      
      // KDS FEATURE: Cancel Order
      else if (data.type === "ORDER_CANCELLED" && data.orderNumber) {
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );

        if (orderToMark) {
          orderToMark.status = "done";
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); // Save state

          console.log(`Order ${data.orderNumber} CANCELLED by KDS user.`);

          broadcast({
            type: "NEW_ORDER",
            ...orderToMark,
          });
        }
      }
    } catch (e) {
      console.error("Error processing client message:", e);
    }
  });

  ws.on("close", () => console.log("KDS disconnected"));
});

// ---------------- Middleware + static ----------------

app.use(bodyParser.json());
// Serve static assets from the repo's public directory (works even if the server is started elsewhere)
const PUBLIC_DIR = path.join(process.cwd(), "public");
app.use(express.static(PUBLIC_DIR));

app.get("/kitchen", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "kitchen.html"));
});

app.get("/cds", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "cds.html"));
});

app.get("/", (req, res) => res.redirect("/kitchen"));

app.get("/healthz", (req, res) => res.status(200).send("OK"));

// ---------------- API Routes ----------------

app.get("/api/orders", (req, res) => {
  const list = Object.values(orders)
    .map((o) => ({ ...o, status: normalizeStatus(o.status) }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  res.json({ orders: list });
});

app.post("/api/orders/:id/ready", (req, res) => {
  const order = findOrderByIdentifier(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  const updated = markOrderReady(order);
  res.json({ success: true, order: updated });
});

// ---------------- Square Webhook ----------------

async function handleSquareWebhook(req, res) {
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

    // If we don't have items yet, try Orders API
    if (!fullOrder || !Array.isArray(fullOrder.line_items)) {
      const fetched = await fetchOrderFromSquare(orderId);
      if (fetched) {
        fullOrder = fetched;
      }
    }

    // ---------- ORDER NUMBER (Pulls Square's Display ID) ----------
    let orderNumber = null;
    if (fullOrder) {
      // Prioritize Square's display fields (ticket_name, display_id, etc.)
      orderNumber =
        fullOrder.ticket_name ||
        fullOrder.order_number ||
        fullOrder.display_id || // <--- This is the key display number
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
        variationName: li.variation_name || null,
        note: li.note || "",
        modifiers: Array.isArray(li.modifiers)
          ? li.modifiers.map((m) => m.name).filter(Boolean)
          : [],
      }));
    } else if (orders[orderId]?.items) {
      // reuse items from previous event for same order
      items = orders[orderId].items;
    }
    
    // Get existing state for merge
    const existing = orders[orderId] || {};
    if (existing.status) existing.status = normalizeStatus(existing.status);

    // --- ITEM COMPLETION & PRIORITY PERSISTENCE ---
    // 1. Map new items to existing completion status if available
    let finalItems = items.map((newItem, index) => {
        let completed = false;
        if (existing.items && existing.items[index]) {
            completed = existing.items[index].completed ?? false;
        }
        return {
            ...newItem,
            completed: completed
        };
    });
    
    // 2. Preserve priority status
    const isPrioritized = existing.isPrioritized ?? false;
    
    // 3. Recalculate item count based on final items
    const itemCount = finalItems.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    );

    const fulfillment = Array.isArray(fullOrder?.fulfillments) ? fullOrder.fulfillments[0] : null;
    const diningOption =
      (fullOrder?.dining_option && fullOrder.dining_option.name) ||
      (fulfillment?.type || null) ||
      existing.diningOption ||
      null;

    const notes = typeof fullOrder?.note === "string" ? fullOrder.note : "";
    const stateFromSquare = typeof state === "string" ? state.toLowerCase() : "";
    const eventTypeLower = typeof eventType === "string" ? eventType.toLowerCase() : "";

    // --- ULTIMATE KDS STATUS LOCK FIX ---
    let kdsStatus = normalizeStatus(existing.status) || "new";
    
    // Rule 1: Cancellation is the only update that can override any KDS status.
    if (stateFromSquare === "canceled" || stateFromSquare === "cancelled" || stateFromSquare === "closed" || eventTypeLower.includes("cancel")) {
        kdsStatus = "done";
    }

    // Rule 2 (THE CRITICAL PART): If the order already exists in our KDS memory
    // AND it has been touched (i.e., status is NOT 'new'), we NEVER override
    // the existing KDS status with a general Square update (like 'OPEN').
    if (existing.status && existing.status !== 'new' && kdsStatus !== 'done') {
        kdsStatus = normalizeStatus(existing.status);
    }
    // --- END ULTIMATE KDS STATUS LOCK FIX ---

    const merged = {
      orderId,
      orderNumber: orderNumber || existing.orderNumber || orderId.slice(-6), // Final selection, preferring Square's
      status: normalizeStatus(kdsStatus), // Use the determined status
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items: finalItems,
      isPrioritized, // Include priority
      stateFromSquare,
      diningOption,
      notes,
    };

    orders[orderId] = merged;
    saveKDSState(); // Save state after Square webhook update

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
}

app.post("/square/webhook", handleSquareWebhook); // Legacy route
app.post("/webhooks/square", handleSquareWebhook);

// ---------------- Test endpoint ----------------

app.get("/test-order", (req, res) => {
  const ticketNum = getNextTestTicketNumber(); // <--- Sequential 001, 002... for testing
  const orderId = `TEST-${ticketNum}-${Date.now()}`;
  const order = {
    orderId,
    orderNumber: ticketNum, // <--- Clean 3-digit number
    status: "new",
    createdAt: Date.now(),
    isPrioritized: false, // ADDED: Default priority status
    diningOption: "For Here",
    notes: "Extra napkins, light ice.",
    items: [
      { name: "Hot Dog", quantity: 1, modifiers: ["No Pickle", "Extra Ketchup"], completed: false }, // ADDED: Item completion status
      { name: "Coke", quantity: 1, modifiers: [], completed: false },
      { name: "Fries", quantity: 2, modifiers: ["Well Done"], completed: false },
    ],
  };
  order.itemCount = order.items.reduce((sum, it) => sum + it.quantity, 0);
  orders[orderId] = order;
  saveKDSState(); // Save state after test order

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
