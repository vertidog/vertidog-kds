const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const STATE_FILE = path.join(__dirname, 'orders.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let orders = {};
let wss; // WebSocket Server instance

// --- File Handling and State Management ---

// Function to load the KDS state from the JSON file
function loadKDSState() {
    try {
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        
        // FIX: Handle empty or whitespace-only file content gracefully
        if (data.trim().length === 0) { 
            orders = {};
            console.log(`State file ${STATE_FILE} is empty. Starting with empty state.`);
            return;
        }
        
        orders = JSON.parse(data);
        console.log(`Loaded KDS state from ${STATE_FILE}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            orders = {};
            console.log(`State file ${STATE_FILE} not found. Starting with empty state.`);
        } else if (error instanceof SyntaxError) {
             // FIX: Specific catch for the "Unexpected end of JSON input" error
            console.error(`Error: The state file ${STATE_FILE} contains incomplete or corrupt JSON. Resetting state.`);
            orders = {};
        } else {
            console.error('Error loading KDS state:', error.message);
            orders = {};
        }
    }
}

// Function to save the current KDS state to the JSON file
function saveKDSState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(orders, null, 2), 'utf8');
        console.log(`KDS state saved to ${STATE_FILE}`);
    } catch (error) {
        console.error('Error saving KDS state:', error.message);
    }
}

// Load state when server starts
loadKDSState();

// --- HTTP Server Setup (Serving HTML and Static Files) ---

const server = http.createServer((req, res) => {
    let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'kitchen.html' : req.url);
    const extname = path.extname(filePath);
    let contentType = 'text/html';

    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.json':
            contentType = 'application/json';
            break;
        case '.png':
            contentType = 'image/png';
            break;
        case '.mp3':
            contentType = 'audio/mpeg';
            break;
        default:
            if (req.url === '/') {
                filePath = path.join(PUBLIC_DIR, 'kitchen.html');
                contentType = 'text/html';
            }
            break;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Internal Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// --- WebSocket Server Setup ---

wss = new WebSocket.Server({ server });

function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', ws => {
    console.log('KDS client connected.');

    // 1. Send current state upon connection
    ws.send(JSON.stringify({
        type: 'SYNC_STATE',
        orders: Object.values(orders),
    }));

    ws.on('message', message => {
        try {
            const msg = JSON.parse(message);
            console.log('Client message received:', msg.type);

            switch (msg.type) {
                case 'SYNC_REQUEST':
                    ws.send(JSON.stringify({
                        type: 'SYNC_STATE',
                        orders: Object.values(orders),
                    }));
                    break;

                case 'ORDER_READY':
                    if (orders[msg.orderNumber]) {
                        orders[msg.orderNumber].status = 'ready';
                        saveKDSState();
                        broadcast({
                            type: 'ORDER_READY_CONFIRM',
                            orderNumber: msg.orderNumber
                        });
                    }
                    break;

                case 'ORDER_CANCELLED':
                    if (orders[msg.orderNumber]) {
                        orders[msg.orderNumber].status = 'cancelled';
                        saveKDSState();
                        broadcast({
                            type: 'ORDER_STATUS_UPDATE',
                            orderNumber: msg.orderNumber,
                            status: 'cancelled'
                        });
                    }
                    break;
                
                case 'ORDER_REACTIVATED':
                    if (orders[msg.orderNumber] && 
                       (orders[msg.orderNumber].status === 'done' || orders[msg.orderNumber].status === 'cancelled')) {
                        orders[msg.orderNumber].status = 'in-progress';
                        saveKDSState();
                        broadcast({
                            type: 'ORDER_STATUS_UPDATE',
                            orderNumber: msg.orderNumber,
                            status: 'in-progress'
                        });
                    }
                    break;

                // --- Simulation: Receive a new order ---
                case 'SIMULATE_NEW_ORDER':
                    const orderNumber = String(Math.floor(Math.random() * 900) + 100);
                    const newOrder = {
                        orderNumber: orderNumber,
                        status: 'new',
                        createdAt: Date.now(),
                        itemCount: 4,
                        items: [
                            { name: 'Hot Dog', quantity: 1, modifiers: ['No Pickle', 'Extra Ketchup'] },
                            { name: 'Coke', quantity: 1, modifiers: [] },
                            { name: 'Fries', quantity: 2, modifiers: ['Well Done'] },
                        ]
                    };
                    orders[orderNumber] = newOrder;
                    saveKDSState();
                    broadcast({
                        type: 'NEW_ORDER',
                        ...newOrder
                    });
                    break;

                default:
                    console.log('Unknown message type:', msg.type);
            }
        } catch (e) {
            console.error('Error processing client message:', e);
        }
    });

    ws.on('close', () => {
        console.log('KDS disconnected');
    });
});

// --- Start the Server ---

server.listen(PORT, () => {
    console.log(`VertiDog KDS backend running on port ${PORT}`);
    console.log(`Access the KDS at http://localhost:${PORT}/`);
    console.log(`To simulate a new order, send a message type 'SIMULATE_NEW_ORDER'`);
});
