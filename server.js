// ===============================
// VertiDog KDS Backend – with Square Orders API
// ===============================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");
// NOTE: crypto module needed for signature verification (postponed)
// const crypto = require("crypto"); 
const fs = require('fs'); // <--- ADDED: File System for persistence

const app = express();
const PORT = process.env.PORT || 10000;
const STATE_FILE = path.join(__dirname, 'orders.json'); // <--- ADDED: State file path

// For Square Orders API
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENV = process.env.SQUARE_ENV || "production"; // or "sandbox"
const SQUARE_BASE_URL =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// In-memory store keyed by orderId
const orders = {};

// ---------------- STATE MANAGEMENT (NEW BLOCK) ----------------
function loadKDSState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            if (data.trim().length > 0) {
                // Assign properties to the existing 'orders' const map
                Object.assign(orders, JSON.parse(data)); 
                console.log(`Loaded KDS state from ${STATE_FILE}.`);
            }
        }
    } catch (error) {
        console.error('Error loading state file:', error.message);
        // If file load fails, start with an empty state
    }
}

function saveKDSState() {
    try {
        // Save the entire in-memory state
        fs.writeFileSync(STATE_FILE, JSON.stringify(orders, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving state file:', error.message);
    }
}

// EXECUTE STATE LOAD ON STARTUP
loadKDSState();
// ---------------- END STATE MANAGEMENT ----------------

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

      if (data.type === "ORDER_READY" && data.orderNumber) {
        // Find order by orderNumber (since that's what the client sends)
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );

        if (orderToMark) {
          // Update the in-memory status
          orderToMark.status = "ready";
          // NOTE: We rely on the orderId key here for server-side persistence
          orders[orderToMark.orderId] = orderToMark; 
          saveKDSState(); // <--- ADDED: Persist on KDS action

          // Broadcast confirmation back to ALL clients
          broadcast({
            type: "ORDER_READY_CONFIRM",
            orderNumber: orderToMark.orderNumber,
          });
        }
      } else if (data.type === "ORDER_REACTIVATED" && data.orderNumber) {
        // RECALL: Bring order back from 'done' or 'cancelled' to 'in-progress'
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );

        if (orderToMark) {
          orderToMark.status = "in-progress";
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); // <--- ADDED: Persist on KDS action

          console.log(`Order ${data.orderNumber} RECALLED/REACTIVATED.`);
          
          broadcast({
            type: "NEW_ORDER", // Use NEW_ORDER to trigger a refresh on all screens
            ...orderToMark,
          });
        }
      } else if (data.type === "ORDER_CANCELLED" && data.orderNumber) {
        // CANCEL: Mark an active order as 'cancelled'
        const orderToMark = Object.values(orders).find(
          (o) => o.orderNumber === data.orderNumber
        );

        if (orderToMark) {
          orderToMark.status = "cancelled";
          orders[orderToMark.orderId] = orderToMark;
          saveKDSState(); // <--- ADDED: Persist on KDS action
          
          console.log(`Order ${data.orderNumber} CANCELLED by KDS user.`);

          broadcast({
            type: "NEW_ORDER", // Use NEW_ORDER to trigger a refresh on all screens
            ...orderToMark,
          });
        }
      } else if (data.type === "SYNC_REQUEST") {
        // Handle explicit sync request from kitchen.html connect()
        ws.send(
          JSON.stringify({
            type: "SYNC_STATE",
            // FIX: Send ALL orders on sync request
            orders: Object.values(orders), // Removed filter
          })
        );
      }
    } catch (e) {
      console.error("Error processing client message:", e);
    }
  });

  // Initial sync request
  ws.send(
    JSON.stringify({
      type: "SYNC_STATE",
      // FIX: Send ALL orders on initial connect
      orders: Object.values(orders), // Removed filter
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

    // Capture existing state before processing the webhook
    const existing = orders[orderId] || {};
    const previousKdsStatus = existing.status; 
    
    // ---------- ITEMS ----------
    let items = [];
    if (fullOrder && Array.isArray(fullOrder.line_items)) {
      items = fullOrder.line_items.map((li) => {
        // --- LOGIC: Extract the Variation Name ---
        const baseName = li.name || "Item";
        const variationName = li.variation_name ? li.variation_name.trim() : null;
        
        let displayName = baseName;
        
        if (variationName && variationName.toLowerCase() !== baseName.toLowerCase()) {
            displayName = `${baseName} - ${variationName}`;
        }
        
        return {
          name: displayName, 
          quantity: toNumberQuantity(li.quantity || 1),
          modifiers: Array.isArray(li.modifiers)
            ? li.modifiers.map((m) => m.name).filter(Boolean)
            : [],
        };
      });
    } else if (existing.items) {
      // reuse items from previous event for same order
      items = existing.items;
    }

    const itemCount = items.reduce(
      (sum, it) => sum + toNumberQuantity(it.quantity),
      0
    );
    const stateFromSquare = typeof state === "string" ? state.toLowerCase() : "";

    
    // --- ULTIMATE KDS STATUS LOCK FIX (Ensures KDS-set status is sticky) ---
    
    let kdsStatus = previousKdsStatus || "new";
    
    // Rule 1: Square's CANCELED/CLOSED states always override, setting the KDS status to 'cancelled'.
    if (stateFromSquare === "canceled" || stateFromSquare === "closed") {
        kdsStatus = "cancelled";
    }
    
    // Rule 2: If the order was NOT previously cancelled, and Square says it's OPEN, 
    // but the KDS has marked it 'ready', we stick to 'ready'.
    // NOTE: This prevents a completed KDS ticket from being reset by a generic 'OPEN' webhook.
    else if (previousKdsStatus && previousKdsStatus !== 'new' && previousKdsStatus !== 'in-progress') {
        kdsStatus = previousKdsStatus; // Stick to the existing KDS status (ready/cancelled)
    }
    
    // --- END ULTIMATE KDS STATUS LOCK FIX ---

    const merged = {
      orderId,
      orderNumber: orderNumber || existing.orderNumber || orderId.slice(-6), 
      status: kdsStatus, // Use the determined locked status
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare,
    };

    orders[orderId] = merged;
    saveKDSState(); // <--- ADDED: Persist order state after webhook update

    console.log("✅ Final KDS order object:", merged);

    // --- FIX: Prevent re-broadcasting orders that are already marked done/cancelled ---
    let statusChanged = merged.status !== previousKdsStatus;
    let shouldBroadcast = true;
    
    // If we have an existing record (not a brand new order):
    if (previousKdsStatus) { 
        // If the status hasn't changed, AND the status is terminal (ready/cancelled), suppress the broadcast.
        if (!statusChanged && (merged.status === 'cancelled' || merged.status === 'ready')) {
            console.log(`❌ Suppressing webhook update for order ${merged.orderNumber}: Status locked to ${merged.status}.`);
            shouldBroadcast = false;
        }
    }
    // New orders (previousKdsStatus=undefined) or orders whose status changed (e.g., in-progress -> ready) will still broadcast.

    if (shouldBroadcast) {
        broadcast({
          type: "NEW_ORDER",
          ...merged,
        });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    // 200 so Square doesn’t spam retries while we debug
    return res.status(200).send("error");
  }
});

// ---------------- Test endpoint ----------------

app.get("/test-order", (req, res) => {
  const ticketNum = getNextTestTicketNumber(); // <--- Sequential 001, 002... for testing
  const orderId = `TEST-${ticketNum}-${Date.now()}`;
  const order = {
    orderId,
    orderNumber: ticketNum, // <--- Clean 3-digit number
    status: "new",
    createdAt: Date.now(),
    // ADDED: Large, complex order for dynamic sizing test, with descriptive names
    items: [
      { name: "VertiDog - Classic", quantity: 4, modifiers: ["Mustard", "Ketchup", "Grilled Onions", "No Relish"] },
      { name: "Chili Cheese Fries", quantity: 2, modifiers: ["Extra Chili", "Side of Ranch", "No Jalapeños", "Heavy Cheese"] },
      { name: "Large Soda - Coke", quantity: 3, modifiers: ["Two 20oz", "One 32oz"] },
      { name: "Large Soda - Sprite", quantity: 3, modifiers: [] },
      { name: "Double Bacon Burger", quantity: 3, modifiers: ["Medium Rare", "Add Avocado", "Extra Crispy Bacon", "Side of Mayo"] },
      { name: "Onion Rings", quantity: 1, modifiers: ["Well Done", "Large Size", "Dipping Sauce: BBQ, Honey Mustard, Sweet Chili"] },
      { name: "Water Bottle", quantity: 8, modifiers: [] },
      { name: "Kids Meal - Hot Dog", quantity: 2, modifiers: ["Toy: Dinosaur"] },
      { name: "Milkshake (Chocolate)", quantity: 2, modifiers: ["Extra Thick", "Whipped Cream", "Cherry"] },
    ],
  };
  // Use toNumberQuantity for safety
  order.itemCount = order.items.reduce((sum, it) => sum + toNumberQuantity(it.quantity), 0);
  orders[orderId] = order;
  saveKDSState(); // <--- ADDED: Persist test order

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
