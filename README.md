## Documentation: Mediasoup SFU Signaling Backend

### Overview

This module implements a scalable and robust SFU (Selective Forwarding Unit) backend using **Mediasoup** and **Socket.IO**.
It provides all the signaling and media routing logic needed to create, join, and manage real-time audio/video rooms with support for HLS (HTTP Live Streaming) output.
The design focuses on **strong type-safety (TypeScript)** and a **strict execution pipeline** for all real-time media and HLS pipeline events.

---

### Request/Response Signaling Cycle

The following events form the backbone of the client-server protocol:

| Event                      | Direction       | Description                                                               | Typical Response             |
| -------------------------- | --------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `createRoom`               | Client → Server | Create a new media room.                                                  | `{ roomId }`                 |
| `joinRoom`                 | Client → Server | Join an existing media room.                                              | `{ roomId }` or error        |
| `getRouterRtpCapabilities` | Client → Server | Query router RTP capabilities (needed for transport/producers/consumers). | `{ rtpCapabilities }`        |
| `createProducerTransport`  | Client → Server | Request a new transport for sending media.                                | `{ id, iceParameters, ... }` |
| `connectProducerTransport` | Client → Server | DTLS handshake for producer transport.                                    | `{ connected: true }`        |
| `produce`                  | Client → Server | Start sending a media track (audio/video).                                | `{ id: producerId }`         |
| `stopProducing`            | Client → Server | Stop all sending tracks (audio/video) for this user.                      | `{ stopped: true }`          |
| `listProducers`            | Client → Server | List all remote producers in this room (for new consumers).               | `{ producers: [...] }`       |
| `createConsumerTransport`  | Client → Server | Request a transport for receiving media.                                  | `{ id, iceParameters, ... }` |
| `connectConsumerTransport` | Client → Server | DTLS handshake for consumer transport.                                    | `{ connected: true }`        |
| `consume`                  | Client → Server | Create a consumer for a remote producer.                                  | Consumer data                |
| `roomProducersChanged`     | Server → Client | Notify all clients when producers join/leave or tracks change.            | *Event only (no response)*   |
| `disconnect`               | Client → Server | Client disconnects (clean up).                                            | *Handled internally*         |

#### Example Client Flow

1. Client emits `createRoom` or `joinRoom`.
2. Client requests `getRouterRtpCapabilities`.
3. Client emits `createProducerTransport`, gets transport parameters, performs DTLS handshake via `connectProducerTransport`.
4. Client emits `produce` with its media track.
5. Client may emit `listProducers` and then `createConsumerTransport`, `connectConsumerTransport`, and `consume` for each remote producer.
6. If media state changes (producers leave/join), all users receive a `roomProducersChanged` event and may update their consumers.

---

### Why Maintain Execution Order (Pipeline)?

**The correct execution order is critical for a robust SFU-HLS pipeline**.
For media and HLS output to work without glitches, resource leaks, or race conditions, each step must be performed in a strict sequence:

#### HLS Pipeline Steps

1. **Cleanup Old State**
   *Terminate any old FFmpeg processes and close old Mediasoup PlainTransports before allocating new resources. This avoids port conflicts, stale consumers, and resource leaks.*

2. **Allocate Ports**
   *Assign unique UDP/RTP/RTCP ports for every audio/video pair to guarantee correct stream routing (especially with `rtcpMux: false`).*

3. **Create PlainTransports**
   *Build new Mediasoup PlainTransports for each AV pair, but do not connect them yet.*

4. **Write SDP File**
   *Generate and write the new SDP file that FFmpeg will use to understand the new port configuration and stream layout.*

5. **Launch FFmpeg**
   *Start FFmpeg, pointed at the new SDP file, so it is ready to listen on the assigned ports.*

6. **Connect Transports**
   *Now, connect each PlainTransport to its assigned RTP/RTCP port. If you connect before FFmpeg is listening, packets may be lost, resulting in muted or missing streams.*

7. **Create Consumers**
   *For each producer, create a consumer on the corresponding PlainTransport and request a keyframe (see below).*

8. **Save State**
   *Update internal state with all current pipeline details, so further changes are atomic and robust.*

> **If these steps are skipped or reordered, you may experience:**
>
> * Stuck FFmpeg processes (unable to bind to ports).
> * Media not flowing (due to unconnected transports or missing SDP).
> * Stale consumers or zombie Mediasoup transports.
> * Incomplete HLS output (audio or video missing).

---

### Robustness: The Retry Mechanism for Video Keyframes

**Why do we request keyframes, and why retry?**

* When starting a new video consumer, FFmpeg (and HLS clients) need an *intra-frame* (keyframe) to decode video.
* If a consumer starts mid-stream, it may wait seconds for the next keyframe, causing visible delay or "black video".
* Therefore, immediately after consumer creation, the backend requests keyframes via `consumer.requestKeyFrame()`.
* To ensure delivery, especially in unreliable network conditions, this request is **retried several times** (with short delays) until a keyframe is received.

> **This ensures HLS output starts fast and reliably, with minimal user-perceived latency.**

---

### Summary: Why This Pipeline is Robust

* **Strict resource cleanup** prevents leaks and port conflicts.
* **Atomic state changes** avoid race conditions, even with concurrent join/leave or produce/stop events.
* **Strict port allocation and SDP writing order** ensures FFmpeg and Mediasoup always agree on stream layout.
* **Keyframe request retries** guarantee immediate, glitch-free HLS startup.
* **All signaling events** are request/response and type-safe, minimizing protocol drift and client/server desync.

---

## Example: Execution Order in Code

```typescript
// In restartRoomHls():
1. Kill old ffmpeg/transports if present.
2. Allocate RTP/RTCP ports for all full AV users.
3. Create PlainTransports for each AV pair.
4. Write new SDP file for these ports.
5. Launch ffmpeg with that SDP file.
6. Connect each PlainTransport to its assigned port (AFTER ffmpeg starts).
7. Create consumers for each track and request video keyframe with retry.
8. Save new state.
```
