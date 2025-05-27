// launchFfmpeg.ts
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

function generateSdp(opts: { audioPort: number; videoPort: number; audioCodec?: string; videoCodec?: string }) {
    const { audioPort, videoPort, audioCodec = "opus", videoCodec = "VP8" } = opts;
    return `
v=0
o=- 0 0 IN IP4 127.0.0.1
s=No Name
c=IN IP4 127.0.0.1
t=0 0
m=audio ${audioPort} RTP/AVP 100
a=rtpmap:100 ${audioCodec}/48000/2
m=video ${videoPort} RTP/AVP 101
a=rtpmap:101 ${videoCodec}/90000
`.trim();
}

export function launchFfmpeg(
    channelId: string,
    opts: { audioPort: number; videoPort: number }
): { process: ChildProcess, hlsDir: string } {
    const { audioPort, videoPort } = opts;
    const hlsDir = path.join(process.cwd(), "hls", channelId);
    fs.mkdirSync(hlsDir, { recursive: true });

    const sdp = generateSdp({ audioPort, videoPort });
    const sdpPath = path.join(hlsDir, "input.sdp");
    fs.writeFileSync(sdpPath, sdp);

    const ffmpegArgs = [
        "-protocol_whitelist", "file,udp,rtp",
        "-i", sdpPath,
        "-vf", "fps=15,scale=480:360",        // 15fps, 320x240
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-g", "15",                           // 1 keyframe per segment (15fps * 1s)
        "-keyint_min", "15",
        "-sc_threshold", "0",
        "-c:a", "aac",
        "-ar", "48000",
        "-b:a", "128k",
        "-f", "hls",
        "-hls_time", "1",                     // segment duration (try "0.5" for even lower latency)
        "-hls_list_size", "3",                // only 3 segments in playlist
        "-hls_flags", "delete_segments+append_list+program_date_time",
        path.join(hlsDir, "index.m3u8"),
    ];
    // const ffmpegArgs = [
    //     "-protocol_whitelist", "file,udp,rtp",
    //     "-i", sdpPath,
    //     "-vf", "fps=15,scale=320:240",
    //     "-c:v", "libx264",
    //     "-preset", "ultrafast",
    //     "-tune", "zerolatency",
    //     "-g", "48",                  // Keyframe interval
    //     "-keyint_min", "48",
    //     "-sc_threshold", "0",
    //     "-c:a", "aac",
    //     "-f", "hls",
    //     "-hls_time", "4",
    //     "-hls_list_size", "5",
    //     "-hls_flags", "delete_segments+append_list",
    //     path.join(hlsDir, "index.m3u8"),
    // ];

    // const ffmpegArgs = [
    //     "-protocol_whitelist", "file,udp,rtp",
    //     "-i", sdpPath,
    //     "-vf", "scale=640:360",            // Downscale for smaller file size (optional)
    //     "-c:v", "libx264",
    //     "-preset", "ultrafast",
    //     "-tune", "zerolatency",
    //     "-g", "48",
    //     "-keyint_min", "48",
    //     "-sc_threshold", "0",
    //     "-b:v", "900k",
    //     "-maxrate", "1200k",
    //     "-bufsize", "1800k",
    //     "-c:a", "aac",
    //     "-ar", "48000",
    //     "-b:a", "128k",
    //     "-f", "hls",
    //     "-hls_time", "4",
    //     "-hls_list_size", "5",
    //     "-hls_flags", "delete_segments+append_list",
    //     path.join(hlsDir, "index.m3u8"),
    // ];




    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stdout.on("data", (data) => console.log(`[ffmpeg] ${data.toString()}`));
    ffmpeg.stderr.on("data", (data) => console.error(`[ffmpeg] ${data.toString()}`));
    ffmpeg.on("exit", (code, signal) => {
        console.log(`[ffmpeg] exited with code ${code} (${signal})`);
    });

    return { process: ffmpeg, hlsDir };
}
