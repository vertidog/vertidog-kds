const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const wss = new WebSocket.Server({ noServer: true });
const orders = {}; 

function generateRandomOrderNumber() {
    return Math.floor(Math.random() * 900) + 100;
}

function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function handleClientMessage(client, message) {
    const msg = JSON.parse(message);
    const orderNumber = msg.orderNumber;
    const FINAL_STATUSES = ['done', 'cancelled'];
    
    if (orderNumber && FINAL_STATUSES.includes(orders[orderNumber]?.status)) {
        console.log(`[LOCK] Ignoring status change for finalized order #${orderNumber}`);
        return; 
    }

    switch (msg.type) {
        case 'SYNC_REQUEST':
            client.send(JSON.stringify({ 
                type: 'SYNC_STATE', 
                orders: Object.values(orders) 
            }));
            break;

        case 'ORDER_READY':
            if (orders[orderNumber] && orders[orderNumber].status !== 'done' && orders[orderNumber].status !== 'cancelled') {
                orders[orderNumber].status = 'ready';
                console.log(`Order #${orderNumber} set to READY.`);
                broadcast({ type: 'ORDER_READY_CONFIRM', orderNumber });
            }
            break;

        case 'ORDER_REACTIVATED':
            if (orders[orderNumber]) {
                orders[orderNumber].status = 'in-progress';
                console.log(`Order #${orderNumber} reactivated to IN-PROGRESS.`);
                broadcast({ type: 'NEW_ORDER', ...orders[orderNumber] });
            }
            break;

        case 'ORDER_SKIPPED_DONE':
            if (orders[orderNumber]) {
                orders[orderNumber].status = 'done';
                console.log(`Order #${orderNumber} manually marked DONE.`);
                broadcast({ type: 'NEW_ORDER', ...orders[orderNumber] });
            }
            break;
    }
}

// --- HTTP SERVER SETUP ---

const server = http.createServer((req, res) => {
    if (req.url === '/ws') {
        server.on('upgrade', (req, socket, head) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        });
        return;
    }

    if (req.url === '/test-order') {
        const newOrderNumber = generateRandomOrderNumber();
        const newOrder = {
            orderNumber: newOrderNumber,
            status: 'new',
            createdAt: Date.now(),
            items: [
                { name: "Classic Vertidog", quantity: 2, modifiers: ["Ketchup", "Grilled Onions", "Add Chili"] },
                { name: "Veggie Vertidog", quantity: 1, modifiers: ["No Cheese", "Extra Pickles"] },
                { name: "Large Soda", quantity: 3, modifiers: ["Coke", "Sprite", "Diet Coke"] },
                { name: "Side Fries", quantity: 1, modifiers: [] }
            ],
        };
        newOrder.itemCount = newOrder.items.reduce((sum, item) => sum + item.quantity, 0);
        orders[newOrderNumber] = newOrder;

        console.log(`New Test Order Generated: #${newOrderNumber}`);
        broadcast({ type: 'NEW_ORDER', ...newOrder });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Test order #${newOrderNumber} created.` }));
        return;
    }

    // --- STATIC FILE SERVING ---
    // Ensure we default to kitchen.html if the URL is just '/'
    let filePath = path.join(__dirname, req.url === '/' ? 'kitchen.html' : req.url);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';
    
    // Safety check for the root file if requested without extension
    if (!extname && req.url === '/') {
        filePath = path.join(__dirname, 'kitchen.html');
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            // Log the error locally so you can see why it failed to load
            console.error(`[404 ERROR] Failed to load file: ${filePath}. Error code: ${error.code}`);
            
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end(`404 Not Found. File: ${req.url}`);
            } else {
                res.writeHead(500);
                res.end('Sorry, check the server console for error details.\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

wss.on('connection', (ws) => {
    console.log('New KDS client connected.');
    ws.on('message', (message) => handleClientMessage(ws, message.toString()));
    ws.on('close', () => console.log('KDS client disconnected.'));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Test Order Endpoint: http://localhost:${PORT}/test-order`);
});
