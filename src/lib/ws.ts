import type {
    Router,
    WebRtcTransport,
    Producer,
    PlainTransport,
    Consumer,
} from "mediasoup/types";
import { Server, Socket } from "socket.io";
import { createRouter } from "./worker.js";
import { config } from "../config/mediasoup.config.js";
import getPort, { portNumbers } from "get-port";
import { launchFfmpeg, PortPair } from "./launchFfmpeg.js";
import type { ChildProcess } from "child_process";

// --- Type Declarations ---
type TransportKind = "producer" | "consumer";
type ProducerKind = "audio" | "video";
type Room = {
    users: Set<string>;
    router: Router;
    transports: Map<string, WebRtcTransport>;
    producers: Map<string, Map<ProducerKind, Producer>>;
    hlsPlainTransports?: Array<{ audio: PlainTransport; video: PlainTransport }>;
    hlsFfmpegProcess?: ChildProcess;
    hlsDir?: string;
    lastHlsProducersKey?: string;
    __pendingRestart?: boolean;
};
type Rooms = Map<string, Room>;

// --- State ---
const rooms: Rooms = new Map();
const hlsRestarting: Map<string, boolean> = new Map();

// --- Helpers ---
function generateRoomId(): string {
    return "room_" + Math.random().toString(36).slice(2, 8);
}

function transportKey(socketId: string, kind: TransportKind): string {
    return `${socketId}:${kind}`;
}

async function getEvenPort(range: { startPort: number; endPort: number }): Promise<number> {
    while (true) {
        const port = await getPort({ port: portNumbers(range.startPort, range.endPort) });
        if (port % 2 === 0) return port;
    }
}

function emitRoomProducersChanged(roomId: string, io: Server): void {
    io.to(roomId).emit("roomProducersChanged");
}

async function requestKeyFrameWithRetry(
    consumer: Consumer,
    maxRetries = 5,
    intervalMs = 500
): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await consumer.requestKeyFrame();
            console.log(`[HLS] Requested keyframe (attempt ${i + 1}) for consumer ${consumer.id}`);
        } catch (err) {
            console.warn(`[HLS] Keyframe request failed:`, err);
        }
        await new Promise(res => setTimeout(res, intervalMs));
    }
}

// --- HLS Restart Logic (serialized per room) ---
async function safeRestartRoomHls(roomId: string, room: Room) {
    if (hlsRestarting.get(roomId)) {
        room.__pendingRestart = true;
        return;
    }
    hlsRestarting.set(roomId, true);
    try {
        await restartRoomHls(roomId, room);
    } catch (err) {
        console.error(`[safeRestartRoomHls] Error for room ${roomId}:`, err);
    } finally {
        hlsRestarting.delete(roomId);
        if (room.__pendingRestart) {
            room.__pendingRestart = false;
            safeRestartRoomHls(roomId, room);
        }
    }
}

/**
 * Full pipeline: 1. cleanup old, 2. allocate ports, 3. create transports,
 * 4. write SDP, 5. start FFmpeg, 6. connect transports, 7. create consumers, 8. save state.
 */
async function restartRoomHls(roomId: string, room: Room): Promise<void> {
    // --- Step 1: Find all users with BOTH audio+video (full AV pairs)
    const producersArray: Array<{ audio: Producer; video: Producer }> = [];
    for (const [, kindMap] of room.producers.entries()) {
        const audio = kindMap.get("audio");
        const video = kindMap.get("video");
        if (audio && video) producersArray.push({ audio, video });
    }
    // --- Step 2: If no AV, cleanup old, return
    if (!producersArray.length) {
        if (room.hlsFfmpegProcess) { try { room.hlsFfmpegProcess.kill("SIGKILL"); } catch { } }
        if (room.hlsPlainTransports) for (const t of room.hlsPlainTransports) { try { t.audio.close(); } catch { } try { t.video.close(); } catch { } }
        room.hlsFfmpegProcess = undefined;
        room.hlsPlainTransports = undefined;
        room.lastHlsProducersKey = "";
        return;
    }
    // --- Step 3: Skip if no change
    const key = producersArray.map(p => `${p.audio.id},${p.video.id}`).sort().join("|");
    if (room.lastHlsProducersKey === key) return;

    // --- Step 4: Kill old FFmpeg and transports
    if (room.hlsFfmpegProcess) { try { room.hlsFfmpegProcess.kill("SIGKILL"); } catch { } }
    if (room.hlsPlainTransports) for (const t of room.hlsPlainTransports) { try { t.audio.close(); } catch { } try { t.video.close(); } catch { } }
    room.hlsFfmpegProcess = undefined;
    room.hlsPlainTransports = undefined;

    // --- Step 5: Allocate ports and create transports
    const audioPortPairs: PortPair[] = [], videoPortPairs: PortPair[] = [], plainTransports: Array<{ audio: PlainTransport; video: PlainTransport }> = [];
    for (let i = 0; i < producersArray.length; i++) {
        const audioRtp = await getEvenPort({ startPort: 10102, endPort: 10200 });
        const videoRtp = await getEvenPort({ startPort: 10202, endPort: 10300 });
        audioPortPairs.push({ rtp: audioRtp, rtcp: audioRtp + 1 });
        videoPortPairs.push({ rtp: videoRtp, rtcp: videoRtp + 1 });

        const audioTransport = await room.router.createPlainTransport({
            listenIp: "127.0.0.1", rtcpMux: false, comedia: false,
        });
        const videoTransport = await room.router.createPlainTransport({
            listenIp: "127.0.0.1", rtcpMux: false, comedia: false,
        });
        plainTransports.push({ audio: audioTransport, video: videoTransport });
    }

    // --- Step 6: Write SDP, launch FFmpeg (before connecting ports!)
    const { process: ffmpegProcess, hlsDir } = launchFfmpeg(roomId, {
        audioPortPairs,
        videoPortPairs,
    });

    // --- Step 7: Connect transports (AFTER ffmpeg starts)
    for (let i = 0; i < plainTransports.length; i++) {
        await plainTransports[i].audio.connect({
            ip: "127.0.0.1", port: audioPortPairs[i].rtp, rtcpPort: audioPortPairs[i].rtcp,
        });
        await plainTransports[i].video.connect({
            ip: "127.0.0.1", port: videoPortPairs[i].rtp, rtcpPort: videoPortPairs[i].rtcp,
        });
    }

    // --- Step 8: Create consumers and request video keyframes
    const consumerPromises: Promise<any>[] = [];
    for (let i = 0; i < producersArray.length; ++i) {
        const { audio, video } = producersArray[i];
        consumerPromises.push(
            plainTransports[i].audio.consume({
                producerId: audio.id,
                rtpCapabilities: room.router.rtpCapabilities,
                paused: false,
            })
        );
        consumerPromises.push(
            (async () => {
                const videoConsumer = await plainTransports[i].video.consume({
                    producerId: video.id,
                    rtpCapabilities: room.router.rtpCapabilities,
                    paused: false,
                });
                await requestKeyFrameWithRetry(videoConsumer, 5, 500);
            })()
        );
    }
    await Promise.all(consumerPromises);

    // --- Step 9: Save state
    room.hlsPlainTransports = plainTransports;
    room.hlsFfmpegProcess = ffmpegProcess;
    room.hlsDir = hlsDir;
    room.lastHlsProducersKey = key;
}

// --- Main handlers (all included) ---

async function handleCreateRoom(socket: Socket, cb: (result: any) => void): Promise<void> {
    const roomId = generateRoomId();
    const router = await createRouter();
    rooms.set(roomId, {
        users: new Set([socket.id]),
        router,
        transports: new Map(),
        producers: new Map(),
    });
    socket.join(roomId);
    cb({ roomId });
}

function handleJoinRoom(socket: Socket, io: Server, data: { roomId: string }, cb: (result: any) => void): void {
    const room = rooms.get(data.roomId);
    if (!room) return cb({ error: "Room does not exist" });
    room.users.add(socket.id);
    socket.join(data.roomId);
    cb({ roomId: data.roomId });
    emitRoomProducersChanged(data.roomId, io);
}

function handleGetRouterRtpCapabilities(socket: Socket, data: { roomId: string }, cb: (result: any) => void): void {
    const room = rooms.get(data.roomId);
    if (!room) return cb({ error: "Room does not exist" });
    cb({ rtpCapabilities: room.router.rtpCapabilities });
}

async function handleCreateTransport(socket: Socket, data: { roomId: string }, kind: TransportKind, cb: (result: any) => void): Promise<void> {
    const room = rooms.get(data.roomId);
    if (!room) return cb({ error: "Room does not exist" });
    const transport = await room.router.createWebRtcTransport({
        listenIps: config.mediasoup.webRtcTransport.listenIps,
        enableUdp: config.mediasoup.webRtcTransport.enableUdp,
        enableTcp: config.mediasoup.webRtcTransport.enableTcp,
        preferUdp: config.mediasoup.webRtcTransport.preferUdp,
    });
    room.transports.set(transportKey(socket.id, kind), transport);
    cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
    });
}

async function handleConnectTransport(socket: Socket, data: { roomId: string; dtlsParameters: any }, kind: TransportKind, cb: (result: any) => void): Promise<void> {
    const room = rooms.get(data.roomId);
    if (!room) return cb({ error: "Room does not exist" });
    const transport = room.transports.get(transportKey(socket.id, kind));
    if (!transport) return cb({ error: `${kind} transport not found` });
    await transport.connect({ dtlsParameters: data.dtlsParameters });
    cb({ connected: true });
}

async function handleProduce(
    socket: Socket,
    io: Server,
    data: { roomId: string; kind: ProducerKind; rtpParameters: any },
    cb: (result: any) => void
): Promise<void> {
    const room = rooms.get(data.roomId);
    if (!room) return cb({ error: "Room does not exist" });
    const transport = room.transports.get(transportKey(socket.id, "producer"));
    if (!transport) return cb({ error: "Producer transport not found" });

    // Close old producer if present
    let userProducers = room.producers.get(socket.id);
    if (!userProducers) {
        userProducers = new Map();
        room.producers.set(socket.id, userProducers);
    }
    const oldProducer = userProducers.get(data.kind);
    if (oldProducer && !oldProducer.closed) {
        try { oldProducer.close(); } catch { }
    }

    const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
    });

    userProducers.set(data.kind, producer);

    if (!room.producers.has(socket.id)) {
        room.producers.set(socket.id, new Map());
    }
    room.producers.get(socket.id)!.set(data.kind, producer);

    socket.to(data.roomId).emit("newProducer", {
        userId: socket.id,
        producerId: producer.id,
        kind: data.kind,
    });
    cb({ id: producer.id });
    emitRoomProducersChanged(data.roomId, io);

    // Producer close event
    producer.on("@close", () => {
        const userProducers = room.producers.get(socket.id);
        if (userProducers && userProducers.get(data.kind) === producer) {
            userProducers.delete(data.kind);
            if (userProducers.size === 0) {
                room.producers.delete(socket.id);
            }
            emitRoomProducersChanged(data.roomId, io);
            safeRestartRoomHls(data.roomId, room);
        }
    });

    safeRestartRoomHls(data.roomId, room);
}

function handleStopProducing(socket: Socket, data: { roomId: string }, cb?: (result: any) => void): void {
    const room = rooms.get(data.roomId);
    if (!room) return cb && cb({ error: "Room does not exist" });
    const userProducers = room.producers.get(socket.id);
    if (userProducers) {
        for (const [, producer] of userProducers.entries()) {
            if (producer && !producer.closed) producer.close();
        }
        room.producers.delete(socket.id);
        safeRestartRoomHls(data.roomId, room);
    }
    cb && cb({ stopped: true });
}

function handleListProducers(socket: Socket, data: { roomId: string }, cb: (result: any) => void): void {
    const room = rooms.get(data.roomId);
    if (!room) return cb({ error: "Room does not exist" });
    const producers: Array<{ userId: string; producerId: string; kind: ProducerKind }> = [];
    for (const [userId, userProducers] of room.producers) {
        if (userId !== socket.id) {
            for (const [kind, producer] of userProducers.entries()) {
                if (producer && !producer.closed) {
                    producers.push({ userId, producerId: producer.id, kind });
                }
            }
        }
    }
    cb({ producers });
}

async function handleConsume(socket: Socket, data: { roomId: string; producerId: string; rtpCapabilities: any }, cb: (result: any) => void): Promise<void> {
    const room = rooms.get(data.roomId);
    if (!room) return cb({ error: "Room does not exist" });
    const transport = room.transports.get(transportKey(socket.id, "consumer"));
    if (!transport) return cb({ error: "Consumer transport not found" });

    let foundProducer: Producer | undefined;
    for (const userProducers of room.producers.values()) {
        for (const producer of userProducers.values()) {
            if (producer.id === data.producerId) {
                foundProducer = producer;
                break;
            }
        }
        if (foundProducer) break;
    }
    if (!foundProducer) return cb({ error: "Producer not found" });
    if (
        !room.router.canConsume({
            producerId: foundProducer.id,
            rtpCapabilities: data.rtpCapabilities,
        })
    ) {
        return cb({ error: "Cannot consume this producer" });
    }
    const consumer = await transport.consume({
        producerId: foundProducer.id,
        rtpCapabilities: data.rtpCapabilities,
        paused: false,
    });
    cb({
        id: consumer.id,
        producerId: data.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
    });
}

function handleDisconnect(socket: Socket, io: Server): void {
    for (const [roomId, room] of rooms) {
        // Cleanup transports for this user
        for (const kind of ["producer", "consumer"] as TransportKind[]) {
            const key = transportKey(socket.id, kind);
            if (room.transports.has(key)) {
                room.transports.get(key)?.close();
                room.transports.delete(key);
            }
        }
        // Cleanup producers for this user
        const userProducers = room.producers.get(socket.id);
        if (userProducers) {
            for (const producer of userProducers.values()) {
                if (producer && !producer.closed) {
                    producer.close();
                }
            }
            room.producers.delete(socket.id);
            safeRestartRoomHls(roomId, room);
        }
        room.users.delete(socket.id);

        emitRoomProducersChanged(roomId, io);

        // If room is empty, destroy router and room
        if (room.users.size === 0) {
            if (room.hlsFfmpegProcess) { try { room.hlsFfmpegProcess.kill("SIGKILL"); } catch { } }
            if (room.hlsPlainTransports) for (const t of room.hlsPlainTransports) { try { t.audio.close(); } catch { } try { t.video.close(); } catch { } }
            room.hlsFfmpegProcess = undefined;
            room.hlsPlainTransports = undefined;
            room.router.close();
            rooms.delete(roomId);
        }
    }
}

// --- Main Connection Handler ---
export function socketIoConnection(io: Server): void {
    io.on("connection", (socket: Socket) => {
        socket.on("createRoom", (_, cb) => handleCreateRoom(socket, cb));
        socket.on("joinRoom", (data, cb) => handleJoinRoom(socket, io, data, cb));
        socket.on("getRouterRtpCapabilities", (data, cb) => handleGetRouterRtpCapabilities(socket, data, cb));
        socket.on("createProducerTransport", (data, cb) => handleCreateTransport(socket, data, "producer", cb));
        socket.on("connectProducerTransport", (data, cb) => handleConnectTransport(socket, data, "producer", cb));
        socket.on("createConsumerTransport", (data, cb) => handleCreateTransport(socket, data, "consumer", cb));
        socket.on("connectConsumerTransport", (data, cb) => handleConnectTransport(socket, data, "consumer", cb));
        socket.on("produce", (data, cb) => handleProduce(socket, io, data, cb));
        socket.on("stopProducing", (data, cb) => handleStopProducing(socket, data, cb));
        socket.on("listProducers", (data, cb) => handleListProducers(socket, data, cb));
        socket.on("consume", (data, cb) => handleConsume(socket, data, cb));
        socket.on("disconnect", () => handleDisconnect(socket, io));
    });
}
