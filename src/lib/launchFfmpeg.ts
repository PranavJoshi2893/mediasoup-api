import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

export interface PortPair { rtp: number; rtcp: number; }

export interface LaunchFfmpegOptions {
    audioPortPairs: PortPair[];
    videoPortPairs: PortPair[];
    audioCodec?: string;
    videoCodec?: string;
}

/**
 * Generates an SDP file for non-muxed RTP/RTCP (rtcpMux: false).
 * FFmpeg will read this SDP to know where to receive audio/video.
 */
function generateSdp(opts: LaunchFfmpegOptions): string {
    const { audioPortPairs, videoPortPairs, audioCodec = "opus", videoCodec = "VP8" } = opts;
    let sdp = `
v=0
o=- 0 0 IN IP4 127.0.0.1
s=Multi RTP
c=IN IP4 127.0.0.1
t=0 0
`.trim();

    audioPortPairs.forEach(pair => {
        sdp += `
m=audio ${pair.rtp} RTP/AVP 100
a=rtpmap:100 ${audioCodec}/48000/2
a=rtcp:${pair.rtcp} IN IP4 127.0.0.1
`;
    });
    videoPortPairs.forEach(pair => {
        sdp += `
m=video ${pair.rtp} RTP/AVP 101
a=rtpmap:101 ${videoCodec}/90000
a=rtcp:${pair.rtcp} IN IP4 127.0.0.1
`;
    });

    return sdp.trim();
}

export function launchFfmpeg(
    roomId: string,
    opts: LaunchFfmpegOptions
): { process: ChildProcess, hlsDir: string } {
    const { audioPortPairs, videoPortPairs } = opts;
    const hlsDir = path.join(process.cwd(), "hls", roomId);
    fs.mkdirSync(hlsDir, { recursive: true });

    const sdp = generateSdp(opts);
    const sdpPath = path.join(hlsDir, "input.sdp");
    fs.writeFileSync(sdpPath, sdp);

    // Audio filter: amix for mixing N audio streams
    let amixFilter = '';
    if (audioPortPairs.length === 1) {
        amixFilter = '[0:a:0]anull[aout]';
    } else if (audioPortPairs.length > 1) {
        amixFilter = audioPortPairs.map((_, i) => `[0:a:${i}]`).join('') +
            `amix=inputs=${audioPortPairs.length}:duration=longest[aout]`;
    }

    // Video filter: scale/stack/grid
    const scaleWidth = 320, scaleHeight = 240;
    let videoFilterSteps: string[] = [], videoInputs: string[] = [];
    for (let i = 0; i < videoPortPairs.length; i++) {
        videoFilterSteps.push(`[0:v:${i}]scale=${scaleWidth}:${scaleHeight}[v${i}]`);
        videoInputs.push(`[v${i}]`);
    }
    let vfilter = '';
    if (videoPortPairs.length === 1) {
        vfilter = `[0:v:0]scale=${scaleWidth}:${scaleHeight},fps=60[vout]`;
    } else if (videoPortPairs.length === 2) {
        vfilter = `${videoFilterSteps.join(';')};${videoInputs.join('')}hstack=inputs=2,fps=60[vout]`;
    } else if (videoPortPairs.length > 2) {
        const layout = videoInputs.map((_, idx) => `${idx * scaleWidth}_0`).join('|');
        vfilter = `${videoFilterSteps.join(';')};${videoInputs.join('')}xstack=inputs=${videoInputs.length}:layout=${layout},fps=60[vout]`;
    }

    const filterComplex = [vfilter, amixFilter].filter(Boolean).join(";");

    const ffmpegArgs = [
        "-protocol_whitelist", "file,udp,rtp",
        "-i", sdpPath,
        "-filter_complex", filterComplex,
        "-map", "[vout]",
        "-map", "[aout]",
        "-r", "60",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-b:v", "2500k", 
        "-maxrate", "3000k", 
        "-bufsize", "4000k",
        "-g", "60",
        "-keyint_min", "60",
        "-sc_threshold", "0",
        "-c:a", "aac",
        "-ar", "48000",
        "-b:a", "128k",
        "-f", "hls",
        "-hls_time", "1",
        "-hls_list_size", "3",
        "-hls_flags", "delete_segments+append_list+program_date_time",
        path.join(hlsDir, "index.m3u8"),
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stdout.on("data", (data: Buffer) => console.log(`[ffmpeg] ${data}`));
    ffmpeg.stderr.on("data", (data: Buffer) => console.error(`[ffmpeg] ${data}`));
    ffmpeg.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        console.log(`[ffmpeg] exited with code ${code} (${signal})`);
    });

    return { process: ffmpeg, hlsDir };
}
