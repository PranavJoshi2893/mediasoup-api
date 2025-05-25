import express from "express";
import * as http from "node:http";
import * as WebSocket from "ws";
import { webSocketConnection } from "./lib/ws";
import { initializeMediasoupWorkers } from "./lib/worker";
import cors from "cors";

async function main() {

    await initializeMediasoupWorkers()

    const app = express();
    app.use("/hls", cors(), express.static("hls"));

    const server = http.createServer(app);

    const websocket = new WebSocket.Server({ server, path: "/ws" });

    webSocketConnection(websocket);

    const PORT = 3001;
    const HOST = "localhost";

    server.listen(PORT, HOST, () => {
        console.log(`ws://${HOST}:${PORT}`);
        console.log(`http://${HOST}:${PORT}/hls/{channelId}/index.m3u8`);
    });
}

export default main;
