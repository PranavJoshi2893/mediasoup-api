import type {
  RtpCodecCapability,
  TransportListenInfo,
  WorkerLogTag,
} from "mediasoup/types";

import os from "node:os";

export const config = {
  listenIp: "0.0.0.0",
  listenPort: 3016,

  mediasoup: {
    numWorkers: Object.keys(os.cpus()).length,
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: "debug",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"] as WorkerLogTag[],
    },
    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
        },
      ] as RtpCodecCapability[],
    },
    //   webrtctrasport settings
    webRtcTransport: {
      listenIps: [
        { ip: "0.0.0.0", announcedIp: "192.168.29.20" },
      ] as TransportListenInfo[],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    },
  },
} as const;
