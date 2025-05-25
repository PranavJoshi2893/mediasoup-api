# Application Architecture

## Overview

This application is a **multi-channel live streaming system** powered by Mediasoup and FFmpeg, supporting multiple publishers and many viewers per stream.
Each publisher (producer) gets a dedicated Mediasoup router and channel; each viewer (consumer) connects to the relevant channel for real-time or HLS-based playback.

---

## System Diagram

```plaintext
User1 (Producer)  ->  Router 1  ----->  Consumer 1
                                   └-->  Consumer 2
                                   └-->  Consumer 3

                                 [Router 1 belongs to Worker 1]

User2 (Producer)  ->  Router 2  ----->  Consumer 4
                                   └-->  Consumer 5
                                   └-->  Consumer 6

                                 [Router 2 belongs to Worker 1, or another Worker]

(Each Worker manages many Routers;
 Each Router: 1 Producer, Many Consumers)
```

---

## Key Components

### 1. **Workers**

* **Purpose:**
  The "brain" of the architecture. Each worker is a Mediasoup process that handles RTP (Real Time Protocol) packet processing and manages multiple routers.
* **Scaling:**
  On startup, the system creates as many workers as there are CPU cores available. This ensures efficient load distribution.
* **Router Pool:**
  Each worker may own many routers (channels/rooms).

---

### 2. **Routers**

* **Purpose:**
  A Mediasoup router is responsible for a single channel/stream.
* **1 Producer, Many Consumers:**

  * Each router can have only one producer (the broadcaster).
  * Multiple consumers (viewers) can subscribe to a router.
  * No two producers can share the same router.
* **Unique Identification:**

  * Each router has a unique ID (`channelId`) for precise tracking and routing.
  * Viewers use this `channelId` to join or watch a specific channel.
* **Lifecycle:**

  * When the producer leaves (quits the stream), the router and all associated transports/consumers are cleaned up automatically.

---

### 3. **Transports**

* **Producer Transport:**

  * Created by the producer to send media to the router.
* **Plain Transports:**

  * Created by the backend to forward media to FFmpeg for HLS output.
* **Consumer Transport:**

  * Created for each viewer (if using direct Mediasoup consuming).

---

### 4. **FFmpeg Integration**

* When a router has both audio and video producers, the backend:

  * Creates two PlainTransports (audio, video) and assigns them random UDP ports.
  * Writes an SDP file describing these RTP endpoints.
  * Spawns an FFmpeg process to consume the stream and create HLS segments.
  * HLS output is made available via HTTP for viewers.

---

## **How Streaming Works (Publisher to Viewer)**

1. **Publisher connects and requests a new channel (router) via WebSocket.**
2. **Publisher sends audio/video tracks via Mediasoup transport.**
3. **Backend creates PlainTransports and consumers for FFmpeg.**
4. **FFmpeg receives RTP, generates `.m3u8` and `.ts` files in a folder named after `channelId`.**
5. **Viewers fetch and play the stream using HLS (`/hls/{channelId}/index.m3u8`).**

---

## **Request-Response Cycle (WebSocket API)**

| Step | Client Sends               | Server Responds            | Description                   |
| ---- | -------------------------- | -------------------------- | ----------------------------- |
| 1    | `getRouterRtpCapabilities` | `routerCapabilities`       | Initiate Mediasoup handshake  |
| 2    | `createProducerTransport`  | `producerTransportCreated` | Receive transport credentials |
| 3    | `connectProducerTransport` | `producerConnected`        | Complete DTLS handshake       |
| 4    | `produce`                  | `produced`                 | Create audio/video producer   |

---

## **Channel/Router Lifecycle**

* **Create Router:**
  On publisher join, new router and channelId are created and stored in the chosen worker.
* **Cleanup:**
  On publisher leave or disconnect, the router, its transports, all consumers, and the FFmpeg process are destroyed, freeing all resources and ports.

---

## **Scalability**

* Each worker can handle many routers.
* Each router supports a single producer and many consumers.
* System can scale horizontally by running multiple backend instances and using a load balancer or cloud-native orchestration.

---

## **Summary**

* Each **Producer** gets a **dedicated channel/router**.
* Each **Router** supports many **Consumers** (viewers).
* **Workers** optimize performance across CPU cores.
* **FFmpeg** integration allows for efficient HLS streaming.
* Simple HTTP endpoint for viewers using `channelId`.

---
