import WebSocket from "ws";
import { randomUUID } from "crypto";
import { createRouter } from "./worker";
import { config } from "../config/mediasoup.config";
import { launchFfmpeg } from "./launchFfmpeg";
import type { ChildProcess } from "child_process";
import type { WebRtcTransport, Router, Producer, PlainTransport, Consumer } from "mediasoup/node/lib/types";
import getPort, { portNumbers } from "get-port";

// Data structures
const transports = new Map<string, WebRtcTransport>(); // key: ws.id:channelId
const channelRouters = new Map<string, Router>(); // key: channelId
const producers = new Map<string, { audio?: Producer; video?: Producer }>(); // key: channelId
const plainTransports = new Map<string, { audio: PlainTransport, video: PlainTransport }>();
const ffmpegConsumers = new Map<string, { audio: Consumer, video: Consumer }>();
const ffmpegProcesses = new Map<string, ChildProcess>();

function cleanupChannel(channelId: string) {
    // 0. FFmpeg process (kill FIRST to free up ports for RTP)
    if (ffmpegProcesses.has(channelId)) {
        const proc = ffmpegProcesses.get(channelId)!;
        try { proc.kill("SIGKILL"); } catch (err) {
            console.warn(`[cleanup] Failed to kill FFmpeg process for channelId: ${channelId}`, err);
        }
        ffmpegProcesses.delete(channelId);
        console.log(`[cleanup] FFmpeg process killed for channelId: ${channelId}`);
    }

    // 1. FFmpeg consumers
    if (ffmpegConsumers.has(channelId)) {
        const fc = ffmpegConsumers.get(channelId)!;
        try { fc.audio.close(); } catch { }
        try { fc.video.close(); } catch { }
        ffmpegConsumers.delete(channelId);
        console.log(`[cleanup] FFmpeg consumers closed for channelId: ${channelId}`);
    }

    // 2. Plain transports
    if (plainTransports.has(channelId)) {
        const pt = plainTransports.get(channelId)!;
        try { pt.audio.close(); } catch { }
        try { pt.video.close(); } catch { }
        plainTransports.delete(channelId);
        console.log(`[cleanup] Plain transports closed for channelId: ${channelId}`);
    }

    // 3. Producers
    if (producers.has(channelId)) {
        const prodMap = producers.get(channelId)!;
        if (prodMap.audio) try { prodMap.audio.close(); } catch { }
        if (prodMap.video) try { prodMap.video.close(); } catch { }
        producers.delete(channelId);
        console.log(`[cleanup] Producers closed for channelId: ${channelId}`);
    }

    // 4. Router
    if (channelRouters.has(channelId)) {
        try { channelRouters.get(channelId)?.close(); } catch { }
        channelRouters.delete(channelId);
        console.log(`[cleanup] Router closed for channelId: ${channelId}`);
    }
}


function cleanupTransportsForWs(wsId: string) {
    for (const [key, transport] of transports) {
        if (key.startsWith(wsId)) {
            try { transport.close(); } catch { }
            transports.delete(key);
            console.log(`[cleanup] Transport closed for key: ${key}`);
        }
    }
}

function webSocketConnection(server: WebSocket.Server) {
    server.on("connection", (ws) => {
        (ws as any).id = randomUUID();
        let channelIdForThisConnection: string | null = null;

        ws.on("message", async (msg) => {
            console.log("[backend] received:", msg.toString());
            let event: { type: string, data?: any };
            try {
                event = JSON.parse(msg.toString());
            } catch (err) {
                console.error(`Invalid JSON:`, err);
                return;
            }
            const channelId = event.data?.channelId;
            if (!channelId) {
                ws.send(JSON.stringify({ type: "error", data: "Missing channelId" }));
                return;
            }
            // Store which channel this connection handles (for cleanup)
            if (!channelIdForThisConnection) {
                channelIdForThisConnection = channelId;
            }

            switch (event.type) {
                case "getRouterRtpCapabilities":
                    await handleRouterCapabilities(ws, channelId);
                    break;
                case "createProducerTransport":
                    await createProducerTransport(ws, channelId);
                    break;
                case "connectProducerTransport":
                    await connectProducerTransport(ws, event.data);
                    break;
                case "produce":
                    await handleProduce(ws, event.data, channelId);
                    break;
                case "stopStream":
                    // Optionally support explicit stop
                    cleanupChannel(channelId);
                    cleanupTransportsForWs((ws as any).id);
                    break;
                default:
                    console.warn("Unknown message type:", event.type);
                    break;
            }
        });

        ws.on("close", () => {
            // Cleanup everything related to this ws and its channel!
            if (channelIdForThisConnection) cleanupChannel(channelIdForThisConnection);
            cleanupTransportsForWs((ws as any).id);
        });

        ws.on("error", (err) => {
            console.error("WebSocket error:", err);
        });
    });
}

async function handleRouterCapabilities(ws: WebSocket, channelId: string) {
    let router = channelRouters.get(channelId);
    if (!router) {
        router = await createRouter();
        channelRouters.set(channelId, router);
    }
    ws.send(
        JSON.stringify({
            type: "routerCapabilities",
            data: router.rtpCapabilities,
        })
    );
    console.log(`Sent router RTP capabilities for channelId: ${channelId}`);
}

async function createProducerTransport(ws: WebSocket, channelId: string) {
    const router = channelRouters.get(channelId);
    if (!router) {
        ws.send(JSON.stringify({ type: "error", data: "No router for channel" }));
        return;
    }
    const key = `${(ws as any).id}:${channelId}`;
    const transport = await router.createWebRtcTransport({
        listenIps: config.mediasoup.webRtcTransport.listenIps,
        enableUdp: config.mediasoup.webRtcTransport.enableUdp,
        enableTcp: config.mediasoup.webRtcTransport.enableTcp,
        preferUdp: config.mediasoup.webRtcTransport.preferUdp,
    });
    transports.set(key, transport);

    ws.send(
        JSON.stringify({
            type: "producerTransportCreated",
            data: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            },
        })
    );
    console.log(`Producer transport created for key: ${key}`);
}

async function connectProducerTransport(ws: WebSocket, data: any) {
    const channelId = data.channelId;
    const key = `${(ws as any).id}:${channelId}`;
    const transport = transports.get(key);
    if (!transport) {
        ws.send(JSON.stringify({ type: "error", data: "Transport not found" }));
        return;
    }

    try {
        await transport.connect({ dtlsParameters: data.dtlsParameters });
        console.log(`Producer transport connected for key: ${key}`);
        ws.send(JSON.stringify({ type: "producerConnected" }));
    } catch (err) {
        console.error("Failed to connect transport:", err);
        ws.send(JSON.stringify({ type: "error", data: "connect_transport_failed" }));
    }
}

async function handleProduce(ws: WebSocket, data: any, channelId: string) {
    const key = `${(ws as any).id}:${channelId}`;
    const router = channelRouters.get(channelId);
    const transport = transports.get(key);

    if (!router) {
        ws.send(JSON.stringify({ type: "error", data: "No router for channel" }));
        return;
    }
    if (!transport) {
        ws.send(JSON.stringify({ type: "error", data: "Transport not found" }));
        return;
    }

    try {
        const producer = await transport.produce({
            kind: data.kind,
            rtpParameters: data.rtpParameters,
        });
        // Store producer by kind under the channelId
        if (!producers.has(channelId)) producers.set(channelId, {});
        producers.get(channelId)![producer.kind] = producer;

        ws.send(JSON.stringify({
            type: "produced",
            data: { id: producer.id }
        }));

        console.log(`Producer created: ${producer.id} (${producer.kind}) (channelId: ${channelId})`);
        // When both exist, set up PlainTransport and FFmpeg
        await setupPlainTransportsAndSenders(channelId);
    } catch (err) {
        ws.send(JSON.stringify({ type: "error", data: "produce_failed" }));
        console.error("Failed to create producer:", err);
    }
}

function cloneRtpParameters(original: any) {
    // Deep clone object (safe for rtpParameters)
    return JSON.parse(JSON.stringify(original));
}

function randomSsrc() {
    // SSRC must be a 32-bit unsigned integer
    return Math.floor(Math.random() * 0xffffffff);
}


async function setupPlainTransportsAndSenders(channelId: string) {
    const prodMap = producers.get(channelId);
    if (!prodMap?.audio || !prodMap?.video) return;
    const router = channelRouters.get(channelId);
    if (!router) return;

    // 1. Pick two free ports for FFmpeg to listen on:
    const audioPort = await getPort({ port: portNumbers(20000, 30000) });
    const videoPort = await getPort({ port: portNumbers(30001, 40000) });

    // 2. Start FFmpeg, it will listen on those ports
    const { process: ffmpegProcess, hlsDir } = launchFfmpeg(channelId, {
        audioPort,
        videoPort,
    });
    ffmpegProcesses.set(channelId, ffmpegProcess);

    // 3. Create PlainTransports for audio and video
    const audioTransport = await router.createPlainTransport({
        listenIp: "127.0.0.1",
        rtcpMux: true,
        comedia: false,
    });
    const videoTransport = await router.createPlainTransport({
        listenIp: "127.0.0.1",
        rtcpMux: true,
        comedia: false,
    });

    // 4. Connect Mediasoup transports to FFmpeg's listening ports
    await audioTransport.connect({ ip: "127.0.0.1", port: audioPort });
    await videoTransport.connect({ ip: "127.0.0.1", port: videoPort });

    // 5. **CONSUME** from the existing producers onto the plain transports!
    const audioConsumer = await audioTransport.consume({
        producerId: prodMap.audio.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
    });
    const videoConsumer = await videoTransport.consume({
        producerId: prodMap.video.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
    });

    ffmpegConsumers.set(channelId, { audio: audioConsumer, video: videoConsumer });
    plainTransports.set(channelId, { audio: audioTransport, video: videoTransport });

    // ...optional: log transport closure
    audioTransport.on("@close", () => {
        console.log(`[mediasoup] PlainTransport (audio) closed for channel ${channelId}`);
    });
    videoTransport.on("@close", () => {
        console.log(`[mediasoup] PlainTransport (video) closed for channel ${channelId}`);
    });

    console.log(`[backend] Plain transports, consumers, and FFmpeg process ready for channelId: ${channelId}`);
}




export { webSocketConnection };
