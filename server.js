// ================================================================
// VERTI-DOG PROFESSIONAL KDS SERVER
// ================================================================
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 8080;

// --- STATE MANAGEMENT ---
// In-memory database. In production, this would be Redis or SQL.
const orders = {}; 

// CONFIG: How specific modifiers affect item grouping?
// For KDS, we want every unique variation to be clear.

// --- HELPER FUNCTIONS ---

function generateOrderNumber() {
    // Generates a 4-digit ticket number (e.g., #3921)
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// Broadcast to all connected KDS screens
function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(msg);
    });
}

// Normalize incoming data (whether from Test or Square) into our internal schema
function normalizeItem(item, index) {
    // Generate a stable ID for item-level bumping
    const uniqueId = item.uid || `item_${Date.now()}_${index}`;
    
    // Handle modifiers (Square sends them differently than test data sometimes)
    let cleanModifiers = [];
    if (Array.isArray(item.modifiers)) {
        cleanModifiers = item.modifiers.map(m => {
            return typeof m === 'string' ? m : (m.name || m.catalog_object_name || "Unknown Mod");
        });
    }

    return {
        id: uniqueId,
        name: item.name || "Unknown Item",
        quantity: parseInt(item.quantity) || 1,
        modifiers: cleanModifiers,
        status: item.status || 'pending' // pending | done
    };
}

// --- EXPRESS APP SETUP ---

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname))); 

// 1. WEBHOOK (SQUARE INTEGRATION)
app.post('/webhook', (req, res) => {
    // NOTE: This is a simplified handler for the "Deep Thinking" demo.
    // In a real Square app, you verify the signature here.
    console.log("🔔 Webhook received");
    
    // For this demo, we acknowledge receipt immediately
    res.status(200).send('OK');
});

// 2. TEST ORDER GENERATOR (Simulates Complex POS Data)
app.get('/test-order', (req, res) => {
    const orderId = `ord_${Date.now()}`;
    const orderNumber = generateOrderNumber();
    
    // Create a realistic complex order
    const rawItems = [
        { 
            name: "Classic Vertidog", 
            quantity: 2, 
            modifiers: ["Ketchup", "Mustard", "Grilled Onions"] 
        },
        { 
            name: "Veggie Vertidog", 
            quantity: 1, 
            modifiers: ["No Cheese", "Extra Pickles", "Gluten Free Bun"] 
        },
        { 
            name: "Lrg. Fries", 
            quantity: 1, 
            modifiers: ["Well Done", "Side Ranch"] 
        },
        {
            name: "Chocolate Shake",
            quantity: 1,
            modifiers: []
        }
    ];

    const normalizedItems = rawItems.map((item, idx) => normalizeItem(item, idx));
    const totalItems = normalizedItems.reduce((acc, curr) => acc + curr.quantity, 0);

    const newOrder = {
        id: orderId,
        displayId: orderNumber,
        status: 'new', // new | in-progress | done | cancelled
        createdAt: Date.now(),
        items: normalizedItems,
        itemCount: totalItems,
        source: "POS"
    };

    // Save to memory
    orders[orderId] = newOrder;

    // Broadcast
    console.log(`🚀 Created Order #${orderNumber}`);
    broadcast({ type: 'ORDER_UPDATE', order: newOrder });

    res.json({ success: true, orderId });
});

// --- WEBSOCKET SERVER (REAL-TIME LAYER) ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('⚡ KDS Client Connected');

    // Send full state on connect
    ws.send(JSON.stringify({ type: 'SYNC', orders: orders }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { action, orderId, itemId, payload } = data;
            const order = orders[orderId];

            if (!order) return;

            switch (action) {
                case 'SET_STATUS':
                    // Master Status Lock Logic:
                    // If moving to DONE or CANCELLED, we finalize it.
                    // If moving back to NEW/IN-PROGRESS, we reactivate.
                    order.status = payload.status;
                    if (order.status === 'done') order.completedAt = Date.now();
                    else delete order.completedAt;
                    break;

                case 'TOGGLE_ITEM':
                    // Item-level bumping logic
                    const item = order.items.find(i => i.id === itemId);
                    if (item) {
                        item.status = item.status === 'pending' ? 'done' : 'pending';
                        
                        // Auto-complete order if all items are done? 
                        // Let's leave that manual for now to emulate Square expeditor mode.
                    }
                    break;
            }

            // Persist and Broadcast change to all screens
            orders[orderId] = order;
            broadcast({ type: 'ORDER_UPDATE', order: order });

        } catch (e) {
            console.error("WS Error:", e);
        }
    });
});

// --- START ---
server.listen(PORT, () => {
    console.log(`\n👨‍🍳 KDS SERVER RUNNING`);
    console.log(`👉 UI: http://localhost:${PORT}`);
    console.log(`👉 API: http://localhost:${PORT}/test-order\n`);
});
