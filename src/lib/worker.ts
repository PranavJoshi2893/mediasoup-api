import * as mediasoup from "mediasoup";
import { config } from "../config/mediasoup.config";
import { Worker, Router } from "mediasoup/node/lib/types";

// Each worker can have multiple routers (for multiple rooms/shards)
type MediasoupWorker = {
    worker: Worker;
    routers: Router[];
};

const workers: MediasoupWorker[] = [];
let nextWorkerIdx = 0;

// Initialize multiple mediasoup workers for scalability
export async function initializeMediasoupWorkers() {
    for (let i = 0; i < config.mediasoup.numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
        });

        worker.on("died", () => {
            console.error(
                "Mediasoup worker died [pid:%d], exiting in 2 seconds...",
                worker.pid
            );
            setTimeout(() => process.exit(1), 2000);
        });

        workers.push({ worker, routers: [] });
    }
    console.log(`Initialized ${workers.length} Mediasoup workers.`);
}

// Create a new router (for a room or a group of users), assign to a worker in round-robin
export async function createRouter(): Promise<Router> {
    const worker = workers[nextWorkerIdx];
    nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;

    const router = await worker.worker.createRouter({
        mediaCodecs: config.mediasoup.router.mediaCodecs,
    });
    worker.routers.push(router);

    return router;
}
