const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const wss = new WebSocket.Server({ noServer: true });
const orders = {}; // Central storage for order states

// --- STATUS LOCK & ORDER MANAGEMENT ---

// This set tracks order numbers that have reached a final, confirmed state (done/cancelled)
const FINAL_STATUSES = ['done', 'cancelled'];
const statusLock = new Set(); 

function generateRandomOrderNumber() {
    // Generates a random number between 100 and 999
    return Math.floor(Math.random() * 900) + 100;
}

function getActiveOrders() {
    return Object.values(orders).filter(o => !FINAL_STATUSES.includes(o.status));
}

// Global broadcast function
function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Handles incoming messages from KDS clients
function handleClientMessage(client, message) {
    const msg = JSON.parse(message);
    const orderNumber = msg.orderNumber;

    if (orderNumber && FINAL_STATUSES.includes(orders[orderNumber]?.status)) {
        console.log(`[LOCK] Ignoring status change for finalized order #${orderNumber}`);
        return; 
    }

    switch (msg.type) {
        case 'SYNC_REQUEST':
            // Send all current orders to the newly connected client
            client.send(JSON.stringify({ 
                type: 'SYNC_STATE', 
                orders: Object.values(orders) 
            }));
            break;

        case 'ORDER_READY':
            // Client is asking to move to READY status (triggers announcement)
            if (orders[orderNumber] && orders[orderNumber].status !== 'done' && orders[orderNumber].status !== 'cancelled') {
                orders[orderNumber].status = 'ready';
                console.log(`Order #${orderNumber} set to READY.`);
                // Confirm ready status back to all clients (triggers sound/timer)
                broadcast({ type: 'ORDER_READY_CONFIRM', orderNumber });
            }
            break;

        case 'ORDER_REACTIVATED':
            // Client dragged a 'done' or 'cancelled' order back to active state
            if (orders[orderNumber]) {
                orders[orderNumber].status = 'in-progress';
                console.log(`Order #${orderNumber} reactivated to IN-PROGRESS.`);
                statusLock.delete(orderNumber); // Remove from the lock
                // Broadcast the change
                broadcast({ type: 'NEW_ORDER', ...orders[orderNumber] });
            }
            break;

        case 'ORDER_SKIPPED_DONE':
            // Client manually dragged an order to the done section
            if (orders[orderNumber]) {
                orders[orderNumber].status = 'done';
                console.log(`Order #${orderNumber} manually marked DONE.`);
                // Broadcast the change
                broadcast({ type: 'NEW_ORDER', ...orders[orderNumber] });
            }
            break;

        default:
            console.log('Unknown message type:', msg.type);
    }
}

// --- HTTP SERVER SETUP ---

const server = http.createServer((req, res) => {
    // 1. WebSocket Upgrade handling (Crucial for WebSocket connection)
    if (req.url === '/ws') {
        server.on('upgrade', (req, socket, head) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        });
        return; // WebSocket handled the request
    }

    // 2. Test Order Endpoint
    if (req.url === '/test-order') {
        const newOrderNumber = generateRandomOrderNumber();
        const newOrder = {
            orderNumber: newOrderNumber,
            status: 'new',
            createdAt: Date.now(),
            // --- RICH ITEM DATA STRUCTURE (Simulating POS) ---
            items: [
                { 
                    name: "Classic Vertidog", 
                    quantity: 2, 
                    modifiers: ["Ketchup", "Grilled Onions", "Add Chili"] 
                },
                { 
                    name: "Veggie Vertidog", 
                    quantity: 1, 
                    modifiers: ["No Cheese", "Extra Pickles"] 
                },
                { 
                    name: "Large Soda", 
                    quantity: 3, 
                    modifiers: ["Coke", "Sprite", "Diet Coke"] 
                },
                { 
                    name: "Side Fries", 
                    quantity: 1, 
                    modifiers: [] 
                }
            ],
        };

        // Calculate total item count for the bubble's small display
        newOrder.itemCount = newOrder.items.reduce((sum, item) => sum + item.quantity, 0);
        
        orders[newOrderNumber] = newOrder;

        console.log(`New Test Order Generated: #${newOrderNumber}`);
        broadcast({ 
            type: 'NEW_ORDER', 
            ...newOrder 
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Test order #${newOrderNumber} created.` }));
        return;
    }

    // 3. Static File Serving (KDS HTML and other assets)
    let filePath = path.join(__dirname, req.url === '/' ? 'kitchen.html' : req.url);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.mp3': 'audio/mpeg' // To support the chime sound
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// --- WEBSOCKET CONNECTION HANDLING ---

wss.on('connection', (ws) => {
    console.log('New KDS client connected.');
    ws.on('message', (message) => handleClientMessage(ws, message.toString()));
    ws.on('close', () => console.log('KDS client disconnected.'));
});

// --- START SERVER ---

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Test Order Endpoint: http://localhost:${PORT}/test-order`);
});
