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
  if (typeof q === "string") {
    return parseInt(q, 10) || 1;
  }
  return q || 1;
}

// ---------------- WebSocket Broadcasting ----------------

let wss; // Defined later in server startup

function broadcast(data) {
  if (wss && wss.clients) {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }
}

// Determines the KDS status based on the Square order state
function determineKDSStatus(squareState, orderId) {
    const existing = orders[orderId];

    // If the order is already marked ready or cancelled in the KDS, maintain that status
    if (existing && (existing.status === 'ready' || existing.status === 'cancelled')) {
        return existing.status;
    }

    switch (squareState) {
        case "OPEN":
        case "SCHEDULED":
            // Square's "OPEN" maps to KDS "new" or "in-progress"
            return existing?.status === 'in-progress' ? 'in-progress' : 'new';
        case "COMPLETED":
        case "FULFILLED":
            // Square's "COMPLETED" maps to KDS "ready"
            return "ready";
        case "CANCELED":
        case "VOIDED":
        case "DRAFT":
            // Square's "CANCELED" maps to KDS "cancelled"
            return "cancelled";
        default:
            return existing?.status || 'new'; // Default to existing or 'new'
    }
}


// ---------------- KDS STATE MANAGEMENT (ADDED) ----------------

function loadKDSState() {
    try {
        // 1. Check if the file exists before trying to read it
        if (!fs.existsSync(STATE_FILE)) {
            console.log(`State file ${STATE_FILE} not found. Starting with empty state.`);
            return;
        }

        // 2. Read the file content
        const data = fs.readFileSync(STATE_FILE, 'utf8');

        // 3. Check if the file is empty
        if (data.trim().length === 0) {
            console.log(`State file ${STATE_FILE} is empty. Starting with empty state.`);
            return;
        }
        
        // 4. Safely parse and assign state
        const loadedOrders = JSON.parse(data);
        for (const orderId in loadedOrders) {
            const order = loadedOrders[orderId];
            // Ensure essential properties are present to prevent crashes downstream
            order.items = order.items || [];
            order.isPrioritized = order.isPrioritized ?? false;
            // The item completion status should be loaded, but ensure it defaults if corrupted
            if (order.items) {
                order.items = order.items.map(item => ({
                    ...item,
                    completed: item.completed ?? false
                }));
            }
        }
        
        // Use Object.assign to merge the loaded state into the in-memory 'orders' object
        Object.assign(orders, loadedOrders); 
        console.log(`✅ Loaded KDS state from ${STATE_FILE} successfully.`);
        
    } catch (error) {
        // Catches file reading errors (permissions, path issues) OR JSON parsing errors
        console.error('❌ CRITICAL ERROR loading state file. Data may be corrupted or inaccessible:', error.message);
        // We allow the server to proceed with an empty state instead of crashing
    }
}

function saveKDSState() {
    try {
        // Save the entire in-memory state
        fs.writeFileSync(STATE_FILE, JSON.stringify(orders, null, 2), 'utf8');
    } catch (error) {
        // This won't crash the server, but logs the failure
        console.error('Error saving state file:', error.message);
    }
}

// CRITICAL FIX: Load state on server startup
loadKDSState();
// ---------------- END KDS STATE MANAGEMENT ----------------


// ---------------- Middleware & Routes ----------------

// Serve static files (kitchen.html)
app.use(express.static(path.join(__dirname, 'public')));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "kitchen.html"));
});

// Middleware for Square Webhooks (raw body is required for signature verification)
// Use bodyParser.json() for other routes
app.use(bodyParser.json());

// Main Square Webhook Handler
app.post("/square/webhook", async (req, res) => {
  try {
    const orderId = req.body?.data?.object?.order?.id;
    const squareState = req.body?.data?.object?.order?.state;
    
    if (!orderId) {
        // Ignore webhooks without an orderId (e.g., test webhooks)
        return res.status(200).send("ok");
    }

    // 1. Fetch the full order details from Square
    const response = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Square-Version": "2024-06-25",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
        console.error(`Error fetching order ${orderId}: ${response.status} ${response.statusText}`);
        // Respond 200 to Square to prevent retries on an API error
        return res.status(200).send("ok"); 
    }

    const json = await response.json();
    const fullOrder = json.order;
    const existing = orders[orderId] || {};
    const kdsStatus = determineKDSStatus(squareState, orderId);

    // --- NEW DATA EXTRACTION BLOCK ---
    let orderNumber = fullOrder?.display_id || fullOrder?.order_number || orderId.slice(-6);
    
    // 1. ITEMS (with VARIATION name)
    let items = existing.items || [];
    if (fullOrder && Array.isArray(fullOrder.line_items)) {
        items = fullOrder.line_items.map((li, index) => {
            const baseName = li.name || "Item";
            const variationName = li.variation_name ? li.variation_name.trim() : null;
            // Combines Name and Variation if they are different
            const displayName = (variationName && variationName.toLowerCase() !== baseName.toLowerCase())
                ? `${baseName} - ${variationName}`
                : baseName;

            return { 
                name: displayName, 
                quantity: toNumberQuantity(li.quantity || 1), 
                modifiers: li.modifiers?.map(m => m.name).filter(Boolean) || [], 
                // CRITICAL: Preserve item completion status if it exists, otherwise default to false
                completed: existing.items?.[index]?.completed ?? false, 
            };
        });
    }

    // 2. SERVICE TYPE (Fulfillment Type)
    let serviceType = 'DINE IN';
    if (fullOrder && Array.isArray(fullOrder.fulfillments) && fullOrder.fulfillments.length > 0) {
        // Use the type of the first fulfillment, replacing underscore for display
        serviceType = fullOrder.fulfillments[0].type.replace('_', ' '); 
    }

    // 3. ORDER NOTE (Customer Comments)
    const customerNote = fullOrder?.note || null;
    // --- END NEW DATA EXTRACTION BLOCK ---

    const stateFromSquare = squareState;
    const itemCount = items.reduce((sum, it) => sum + toNumberQuantity(it.quantity), 0);

    // Merge/Create the final KDS order object
    const merged = {
      orderId,
      orderNumber, 
      status: kdsStatus, 
      isPrioritized: existing.isPrioritized || false, // Preserve KDS priority status
      createdAt: existing.createdAt || Date.now(),
      itemCount,
      items,
      stateFromSquare,
      serviceType,    // ADDED
      customerNote,   // ADDED
    };

    orders[orderId] = merged;
    saveKDSState(); // Save state after webhook update

    console.log("✅ Final KDS order object:", merged);

    broadcast({
      type: "NEW_ORDER",
      ...merged,
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    // Respond 200 so Square doesn’t spam retries while we debug
    return res.status(200).send("error");
  }
});


// ---------------- Test endpoint (UPDATED) ----------------

app.get("/test-order", (req, res) => {
  const ticketNum = getNextTestTicketNumber(); // <--- Sequential 001, 002... for testing
  const orderId = `TEST-${ticketNum}-${Date.now()}`;
  const order = {
    orderId,
    orderNumber: ticketNum, // <--- Clean 3-digit number
    status: "new",
    createdAt: Date.now(),
    isPrioritized: false, // ADDED: Default priority status
    serviceType: "PICKUP", // ADDED: Example Service Type
    customerNote: "Customer wants extra spicy!", // ADDED: Example Customer Note
    // ADDED: Large, complex order for dynamic sizing test, with descriptive names
    items: [
      { name: "VertiDog - Classic", quantity: 4, modifiers: ["Mustard", "Ketchup", "Grilled Onions", "No Relish"], completed: false }, 
      { name: "Chili Cheese Fries", quantity: 2, modifiers: ["Extra Chili", "Side of Ranch", "No Jalapeños", "Heavy Cheese"], completed: false },
      { name: "Large Soda - Coke", quantity: 3, modifiers: ["Two 20oz", "One 32oz"], completed: false },
      { name: "Large Soda - Sprite", quantity: 3, modifiers: [], completed: false },
      { name: "Double Bacon Burger", quantity: 3, modifiers: [\"Medium Rare\", \"Add Avocado\", \"Extra Crispy Bacon\", \"Side of Mayo\"], completed: false },
      { name: "Onion Rings", quantity: 1, modifiers: [\"Well Done\", \"Large Size\", \"Dipping Sauce: BBQ, Honey Mustard, Sweet Chili\"], completed: false },
      { name: "Water Bottle", quantity: 8, modifiers: [], completed: false },
    ],
  };
  // Use toNumberQuantity for safety
  order.itemCount = order.items.reduce((sum, it) => sum + toNumberQuantity(it.quantity), 0);
  orders[orderId] = order;
  saveKDSState(); // Save state after test order

  broadcast({
    type: "NEW_ORDER",
    ...order,
  });

  res.send(`Test Order #${ticketNum} created successfully.`);
});

// ---------------- WebSocket Logic ----------------

// Handler for KDS client requests (item completion, order completion, sync, priority)
function handleWebSocketMessage(message, ws) {
    try {
        const data = JSON.parse(message);
        const order = orders[data.orderId] || Object.values(orders).find(o => o.orderNumber === data.orderNumber);
        
        if (!order) {
            console.warn("Received message for unknown order:", data);
            return;
        }

        switch (data.type) {
            case 'SYNC_REQUEST':
                // Send the full current state to the newly connected client
                ws.send(JSON.stringify({ type: 'SYNC_STATE', orders: Object.values(orders) }));
                break;
            
            case 'ORDER_READY':
                if (order.status !== 'ready') {
                    order.status = 'ready';
                    saveKDSState();
                    broadcast({ type: 'ORDER_READY_CONFIRM', orderNumber: order.orderNumber, orderId: order.orderId, status: 'ready' });
                    console.log(`Order ${order.orderNumber} marked as READY.`);
                }
                break;
                
            case 'ORDER_REACTIVATED':
                // Recalls from ready/cancelled back to in-progress
                order.status = 'in-progress';
                saveKDSState();
                broadcast({ type: 'ORDER_READY_CONFIRM', orderNumber: order.orderNumber, orderId: order.orderId, status: 'in-progress' });
                console.log(`Order ${order.orderNumber} recalled to ACTIVE.`);
                break;

            case 'ORDER_CANCELLED':
                order.status = 'cancelled';
                saveKDSState();
                broadcast({ type: 'ORDER_READY_CONFIRM', orderNumber: order.orderNumber, orderId: order.orderId, status: 'cancelled' });
                console.log(`Order ${order.orderNumber} marked as CANCELLED.`);
                break;

            case 'ORDER_PRIORITY_TOGGLE':
                order.isPrioritized = data.isPrioritized;
                saveKDSState();
                broadcast({ type: 'ORDER_PRIORITY_TOGGLE', orderNumber: order.orderNumber, isPrioritized: data.isPrioritized });
                console.log(`Order ${order.orderNumber} priority set to ${data.isPrioritized}`);
                break;

            case 'ORDER_ITEM_TOGGLE':
                if (order.items[data.itemIndex]) {
                    order.items[data.itemIndex].completed = data.completed;
                    saveKDSState();
                    // Broadcast to ensure all clients update the item status
                    broadcast({ 
                        type: 'ORDER_ITEM_TOGGLE', 
                        orderNumber: order.orderNumber,
                        orderId: order.orderId,
                        itemIndex: data.itemIndex,
                        completed: data.completed
                    });
                }
                break;
                
            default:
                console.log('Unknown WebSocket message type:', data.type);
        }
    } catch (e) {
        console.error('Error handling WebSocket message:', e);
    }
}


// ---------------- Server Startup ----------------

const server = http.createServer(app);

// Initialize WebSocket Server
wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('A KDS client connected.');

    // Immediately request state sync for the new client
    handleWebSocketMessage(JSON.stringify({ type: 'SYNC_REQUEST' }), ws);

    ws.on('message', (message) => {
        handleWebSocketMessage(message, ws);
    });

    ws.on('close', () => {
        console.log('A KDS client disconnected.');
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

server.listen(PORT, () => {
  console.log(`🚀 VertiDog KDS backend running on port ${PORT}`);
});
