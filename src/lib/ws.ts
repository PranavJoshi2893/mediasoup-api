import { Server } from "socket.io";
import { createRouter } from "./worker.js";
import { config } from "../config/mediasoup.config.js";
import { launchFfmpeg } from "./launchFfmpeg.js";
import type { ChildProcess } from "child_process";
import type {
  WebRtcTransport,
  Router,
  Producer,
  PlainTransport,
  Consumer,
} from "mediasoup/types";
import getPort, { portNumbers } from "get-port";

type MediaKind = "audio" | "video";

// Data structures
const transports = new Map<string, WebRtcTransport>();
const channelRouters = new Map<string, Router>();
const producers = new Map<string, { audio?: Producer; video?: Producer }>();
const plainTransports = new Map<
  string,
  { audio: PlainTransport; video: PlainTransport }
>();
const ffmpegConsumers = new Map<string, { audio: Consumer; video: Consumer }>();
const ffmpegProcesses = new Map<string, ChildProcess>();

function cleanupChannel(channelId: string) {
  // 0. FFmpeg process (kill FIRST to free up ports for RTP)
  if (ffmpegProcesses.has(channelId)) {
    const proc = ffmpegProcesses.get(channelId)!;
    try {
      proc.kill("SIGKILL");
    } catch (err) {
      console.warn(
        `[cleanup] Failed to kill FFmpeg process for channelId: ${channelId}`,
        err
      );
    }
    ffmpegProcesses.delete(channelId);
    console.log(`[cleanup] FFmpeg process killed for channelId: ${channelId}`);
  }

  // 1. FFmpeg consumers
  if (ffmpegConsumers.has(channelId)) {
    const fc = ffmpegConsumers.get(channelId)!;
    try {
      fc.audio.close();
    } catch {}
    try {
      fc.video.close();
    } catch {}
    ffmpegConsumers.delete(channelId);
    console.log(
      `[cleanup] FFmpeg consumers closed for channelId: ${channelId}`
    );
  }

  // 2. Plain transports
  if (plainTransports.has(channelId)) {
    const pt = plainTransports.get(channelId)!;
    try {
      pt.audio.close();
    } catch {}
    try {
      pt.video.close();
    } catch {}
    plainTransports.delete(channelId);
    console.log(
      `[cleanup] Plain transports closed for channelId: ${channelId}`
    );
  }

  // 3. Producers
  if (producers.has(channelId)) {
    const prodMap = producers.get(channelId)!;
    if (prodMap.audio)
      try {
        prodMap.audio.close();
      } catch {}
    if (prodMap.video)
      try {
        prodMap.video.close();
      } catch {}
    producers.delete(channelId);
    console.log(`[cleanup] Producers closed for channelId: ${channelId}`);
  }

  // 4. Router
  if (channelRouters.has(channelId)) {
    try {
      channelRouters.get(channelId)?.close();
    } catch {}
    channelRouters.delete(channelId);
    console.log(`[cleanup] Router closed for channelId: ${channelId}`);
  }
}

function cleanupTransportsForSocket(socketId: string) {
  for (const [key, transport] of transports) {
    if (key.startsWith(socketId)) {
      try {
        transport.close();
      } catch {}
      transports.delete(key);
      console.log(`[cleanup] Transport closed for key: ${key}`);
    }
  }
}

function socketIoConnection(io: Server) {
  io.on("connection", (socket) => {
    let channelIdForThisConnection: string | null = null;

    socket.on("joinRoom", ({ channelId }) => {
      socket.join(channelId);
      channelIdForThisConnection = channelId;
      socket.emit("joinedRoom", { channelId, socketId: socket.id });
    });

    socket.on("getRouterRtpCapabilities", async ({ channelId }) => {
      let router = channelRouters.get(channelId);
      if (!router) {
        router = await createRouter();
        channelRouters.set(channelId, router);
      }
      socket.emit("routerCapabilities", { data: router.rtpCapabilities });
    });

    socket.on("createProducerTransport", async ({ channelId }) => {
      const router = channelRouters.get(channelId);
      if (!router) {
        socket.emit("error", { data: "No router for channel" });
        return;
      }
      const key = `${socket.id}:${channelId}`;
      const transport = await router.createWebRtcTransport({
        listenIps: config.mediasoup.webRtcTransport.listenIps,
        enableUdp: config.mediasoup.webRtcTransport.enableUdp,
        enableTcp: config.mediasoup.webRtcTransport.enableTcp,
        preferUdp: config.mediasoup.webRtcTransport.preferUdp,
      });
      transports.set(key, transport);
      socket.emit("producerTransportCreated", {
        data: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    });

    socket.on("connectProducerTransport", async (data) => {
      const channelId = data.channelId;
      const key = `${socket.id}:${channelId}`;
      const transport = transports.get(key);
      if (!transport) {
        socket.emit("error", { data: "Transport not found" });
        return;
      }

      try {
        await transport.connect({ dtlsParameters: data.dtlsParameters });
        socket.emit("producerConnected");
      } catch (err) {
        socket.emit("error", { data: "connect_transport_failed" });
      }
    });

    socket.on(
      "produce",
      async (data: {
        channelId: string;
        kind: MediaKind;
        rtpParameters: any;
      }) => {
        const channelId = data.channelId;
        const key = `${socket.id}:${channelId}`;
        const router = channelRouters.get(channelId);
        const transport = transports.get(key);

        if (!router) {
          socket.emit("error", { data: "No router for channel" });
          return;
        }
        if (!transport) {
          socket.emit("error", { data: "Transport not found" });
          return;
        }

        try {
          let prodMap = producers.get(channelId);
          if (!prodMap) {
            prodMap = {};
            producers.set(channelId, prodMap);
          }

          const producer = await transport.produce({
            kind: data.kind,
            rtpParameters: data.rtpParameters,
          });

          prodMap[data.kind] = producer; // Now this line is safe!

          socket.emit("produced", { id: producer.id });
          await setupPlainTransportsAndSenders(channelId);
        } catch (err) {
          socket.emit("error", { data: "produce_failed" });
        }
      }
    );

    socket.on("stopStream", () => {
      if (channelIdForThisConnection)
        cleanupChannel(channelIdForThisConnection);
      cleanupTransportsForSocket(socket.id);
    });

    socket.on("disconnect", () => {
      if (channelIdForThisConnection)
        cleanupChannel(channelIdForThisConnection);
      cleanupTransportsForSocket(socket.id);
    });

    socket.on("error", (err) => {
      console.error("Socket.IO error:", err);
    });
  });
}

async function setupPlainTransportsAndSenders(channelId: string) {
  // Only set up if not already set up for this channel
  if (
    plainTransports.has(channelId) &&
    ffmpegConsumers.has(channelId) &&
    ffmpegProcesses.has(channelId)
  ) {
    // Already set up
    return;
  }

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

  ffmpegConsumers.set(channelId, {
    audio: audioConsumer,
    video: videoConsumer,
  });
  plainTransports.set(channelId, {
    audio: audioTransport,
    video: videoTransport,
  });

  audioTransport.on("@close", () => {
    console.log(
      `[mediasoup] PlainTransport (audio) closed for channel ${channelId}`
    );
  });
  videoTransport.on("@close", () => {
    console.log(
      `[mediasoup] PlainTransport (video) closed for channel ${channelId}`
    );
  });

  console.log(
    `[backend] Plain transports, consumers, and FFmpeg process ready for channelId: ${channelId}`
  );
}

export { socketIoConnection };
