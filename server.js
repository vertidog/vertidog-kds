// ===============================
// VertiDog KDS Backend – with Square Orders API
// ===============================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// For Square Orders API (using placeholders if environment variables aren't set)
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "YOUR_ACCESS_TOKEN";
const SQUARE_ENV = process.env.SQUARE_ENV || "production"; // or "sandbox"
const SQUARE_BASE_URL =
  SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

// In-memory store keyed by orderId
const orders = {};

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

/**
 * Maps Square fulfillment types to a clean display string (DINING OPTIONS).
 */
function getFulfillmentType(fullOrder) {
    if (!fullOrder || !Array.isArray(fullOrder.fulfillments)) {
        return "Dine In"; // Default set to 'Dine In'
    }
    
    for (const fulfillment of fullOrder.fulfillments) {
        const type = (fulfillment.type || '').toUpperCase();
        
        if (type === 'PICKUP') {
            const pickupDetails = fulfillment.pickup_details;
            if (pickupDetails && pickupDetails.curbside_pickup_details) {
                return "CURBSIDE PICKUP";
            }
            return "PICKUP / TO GO"; 
        }

        if (type === 'DELIVERY') {
            return "DELIVERY";
        }
    }
    return "Dine In";
}

/**
 * Extracts the top-level order note from the Square order object (ORDER COMMENTS).
 */
function getOrderNote(fullOrder) {
    if (!fullOrder || !fullOrder.note || fullOrder.note.trim() === '') {
        return null;
    }
    return fullOrder.note.trim(); 
}

// Fetch full order from Square
async function fetchOrderFromSquare(orderId) {
  if (SQUARE_ACCESS_TOKEN === "YOUR_ACCESS_TOKEN") {
    console.log("⚠️ SQUARE_ACCESS_TOKEN is not configured, skipping Orders API fetch.");
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
      console.log("❌ Square Orders API error:", resp.status, resp.statusText);
      const text = await resp.text();
      console.log(text);
      return null;
    }

    const json = await resp.json();
    return json.order || null;
  } catch (err) {
    console.error("❌ Orders API fetch failed:", err);
    return null;
  }
}

// ---------------- HTTP + WebSocket server ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("KDS connected");

  // Handle messages from the client (status changes, drag-and-drop, item completion)
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("Client message received:", data.type);

      if (data.type === "ORDER_READY" && data.orderNumber) {
        const orderToMark = Object.values(orders).find((o) => o.orderNumber === data.orderNumber);

        if (orderToMark) {
          orderToMark.status = "ready";
          orders[orderToMark.orderId] = orderToMark; 
          broadcast({ type: "NEW_ORDER", ...orderToMark });
        }
      } else if (data.type === "ORDER_REACTIVATED" && data.orderNumber) {
        const orderToMark = Object.values(orders).find((o) => o.orderNumber === data.orderNumber);

        if (orderToMark) {
          // If recalling from terminal state, reset to 'new'
          orderToMark.status = "new"; 
          // Reset all item completion statuses on recall
          orderToMark.items = orderToMark.items.map(item => ({ ...item, completed: false }));

          orders[orderToMark.orderId] = orderToMark;
          broadcast({ type: "NEW_ORDER", ...orderToMark });
        }
      } else if (data.type === "ORDER_CANCELLED" && data.orderNumber) {
        const orderToMark = Object.values(orders).find((o) => o.orderNumber === data.orderNumber);

        if (orderToMark) {
          orderToMark.status = "cancelled";
          orders[orderToMark.orderId] = orderToMark;
          broadcast({ type: "NEW_ORDER", ...orderToMark });
        }

      // --- ITEM COMPLETION PERSISTENCE ---
      } else if (data.type === "ITEM_COMPLETED" && data.orderNumber && data.itemIndex !== undefined) {
        const orderToMark = Object.values(orders).find((o) => o.orderNumber === data.orderNumber);

        if (orderToMark && orderToMark.items[data.itemIndex]) {
          // 1. Update item status
          orderToMark.items[data.itemIndex].completed = data.completed;
          
          // 2. Update order status if completing first item (new -> in-progress)
          const previousStatus = orderToMark.status;
          if (data.completed && orderToMark.status === 'new') {
              orderToMark.status = 'in-progress';
          }
          
          // 3. Broadcast the item change confirmation back to all clients
          const allCompleted = orderToMark.items.every(i => i.completed);
          broadcast({
              type: "ITEM_COMPLETED_CONFIRM",
              orderNumber: data.orderNumber,
              itemIndex: data.itemIndex,
              completed: data.completed,
              allCompleted: allCompleted, 
              // Send the whole order object if the status changed (new -> in-progress)
              order: (orderToMark.status !== previousStatus) ? orderToMark : null
          });
        }
      } else if (data.type === "SYNC_REQUEST") {
        // FIX for persistence: Send ALL orders for persistence on refresh
        ws.send(
          JSON.stringify({
            type: "SYNC_STATE",
            // Send ALL orders, including 'ready' and 'cancelled'
            orders: Object.values(orders), 
          })
        );
      }
    } catch (e) {
      console.error("Error processing client message:", e);
    }
  });

  // Initial sync request on connect
  ws.send(
    JSON.stringify({
      type: "SYNC_STATE",
      // FIX for persistence: Send ALL orders, including 'ready' and 'cancelled'
      orders: Object.values(orders),
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

    // ---------- ORDER NUMBER ----------
    let orderNumber = null;
    if (fullOrder) {
      orderNumber = fullOrder.display_id || fullOrder.order_number || orderId.slice(-6).toUpperCase();
    } else {
      orderNumber = orderId.slice(-6).toUpperCase();
    }
    // ---------- END ORDER NUMBER ASSIGNMENT ----------

    const existing = orders[orderId] || {};
    const previousKdsStatus = existing.status; 
    
    // ---------- ITEMS ----------
    let items = [];
    if (fullOrder && Array.isArray(fullOrder.line_items)) {
      items = fullOrder.line_items.map((li, index) => {
        const baseName = li.name || "Item";
        const variationName = li.variation_name ? li.variation_name.trim() : null;
        let displayName = (variationName && variationName.toLowerCase() !== baseName.toLowerCase()) ? `${baseName} - ${variationName}` : baseName;
        
        // Preserve existing completion status for this item if it exists
        const existingItem = existing.items ? existing.items[index] : null;

        return {
          name: displayName, 
          quantity: toNumberQuantity(li.quantity || 1),
          modifiers: Array.isArray(li.modifiers) ? li.modifiers.map((m) => m.name).filter(Boolean) : [],
          completed: existingItem ? existingItem.completed : false, // Preserve status
        };
      });
    } else if (existing.items) {
      items = existing.items;
    }

    const itemCount = items.reduce((sum, it) => sum + toNumberQuantity(it.quantity), 0);
    const stateFromSquare = typeof state === "string" ? state.toLowerCase() : "";

    
    // --- KDS STATUS LOCK LOGIC (THE CRITICAL FIX) ---
    let kdsStatus = previousKdsStatus || "new";
    
    // Rule 1 (Override): Square's CANCELED/CLOSED states always set KDS status to 'cancelled'.
    if (stateFromSquare === "canceled" || stateFromSquare === "closed") {
        kdsStatus = "cancelled";
    }
    // Rule 2 (LOCK): If KDS status is already 'ready' or 'cancelled', lock it unless Rule 1 applies.
    else if (previousKdsStatus === 'ready' || previousKdsStatus === 'cancelled') {
        // Status remains locked (ready or cancelled).
        kdsStatus = previousKdsStatus; 
    }
    // Rule 3 (Transition): If an item is completed and status is 'new', transition to 'in-progress'.
    else if (items.some(i => i.completed) && kdsStatus === 'new') {
        kdsStatus = 'in-progress';
    }
    // Rule 4 (Default): Otherwise, use the previous status or default to 'new'.
    else if (previousKdsStatus) {
        kdsStatus = previousKdsStatus;
    }

    // --- END KDS STATUS LOCK LOGIC ---

    const fulfillmentType = getFulfillmentType(fullOrder);
    const orderNote = getOrderNote(fullOrder); 

    const merged = {
      orderId,
      orderNumber: orderNumber || existing.orderNumber || orderId.slice(-6), 
      status: kdsStatus, 
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare,
      fulfillmentType, 
      orderNote, 
    };

    orders[orderId] = merged;

    // --- Prevent re-broadcasting for locked statuses that didn't change ---
    let shouldBroadcast = true;
    if (previousKdsStatus) { 
        if (merged.status === previousKdsStatus && (merged.status === 'ready' || merged.status === 'cancelled')) {
            // Suppress broadcast if a terminal status didn't change (prevents completed orders from flashing)
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
  const fulfillmentOptions = ["PICKUP / TO GO", "DELIVERY", "Dine In", "CURBSIDE PICKUP"];
  const randomFulfillment = fulfillmentOptions[Math.floor(Math.random() * fulfillmentOptions.length)];

  const order = {
    orderId,
    orderNumber: ticketNum, 
    status: "new",
    createdAt: Date.now(),
    fulfillmentType: randomFulfillment,
    orderNote: "Customer requested extra napkins and cutlery for 4 people. Please ring the bell when order is ready.", 
    items: [
      { name: "VertiDog - Classic", quantity: 4, modifiers: ["Mustard", "Ketchup", "Grilled Onions"], completed: false },
      { name: "Chili Cheese Fries", quantity: 2, modifiers: ["Extra Chili", "Side of Ranch"], completed: false },
      { name: "Large Soda - Coke", quantity: 3, modifiers: ["Two 20oz", "One 32oz"], completed: false },
      { name: "Double Bacon Burger", quantity: 3, modifiers: ["Medium Rare", "Add Avocado"], completed: false },
    ],
  };
  
  order.itemCount = order.items.reduce((sum, it) => sum + toNumberQuantity(it.quantity), 0);
  orders[orderId] = order;

  broadcast({ type: "NEW_ORDER", ...order });

  res.send(`Test order #${ticketNum} sent to KDS (Fulfillment: ${randomFulfillment}, Note: "${order.orderNote}")`);
});

// ---------------- Start server ----------------

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
