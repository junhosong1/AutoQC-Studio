// 영상 검수용 프레임 추출 — 첫 / 중간 / 끝 프레임을 한 장(가로 3칸)으로 이어 붙여 LLM에 보냄
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const require = createRequire(import.meta.url);
let ffmpegPath: string | null = null;
try { ffmpegPath = require('ffmpeg-static'); } catch { /* 없으면 영상 검수 생략 */ }

export const isVideoFile = (name: string) => /\.(mp4|webm|mov|mkv|gif)$/i.test(name);

function run(args: string[], binary = false): Promise<{ out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg가 없어요 (npm install 필요)'));
    execFile(ffmpegPath, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (e, stdout, stderr) => {
      const err = stderr.toString();
      if (e && !binary) return resolve({ out: stdout, err });
      if (e && !stdout.length) return reject(new Error('ffmpeg 오류: ' + err.split('\n').slice(-3).join(' ')));
      resolve({ out: stdout, err });
    });
  });
}

export async function videoInfo(file: string) {
  const { err } = await run(['-hide_banner', '-i', file]);
  const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = err.match(/Video: .*?, (\d{2,5})x(\d{2,5})/);
  const fps = err.match(/([\d.]+) fps/);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    width: v ? Number(v[1]) : undefined,
    height: v ? Number(v[2]) : undefined,
    fps: fps ? Number(fps[1]) : undefined,
    hasAudio: /Audio: /.test(err),
  };
}

async function frameAt(file: string, t: number, w = 448) {
  const { out } = await run(['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-f', 'image2pipe', '-vcodec', 'png', '-'], true);
  return PNG.sync.read(out);
}

/** 썸네일용 첫 프레임 JPEG */
export async function posterJpeg(file: string, w = 640) {
  const f = await frameAt(file, 0.05, w);
  return Buffer.from(jpeg.encode({ data: f.data, width: f.width, height: f.height }, 82).data);
}

/** 첫 / 중간 / 끝 프레임을 가로로 이어 붙인 JPEG */
/** 참조 이미지(RGBA)를 높이 h로 맞춤 (최근접 보간) */
function fitHeight(ref: { width: number; height: number; data: Buffer | Uint8Array }, h: number) {
  const w = Math.max(1, Math.round((ref.width * h) / ref.height));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(ref.height - 1, Math.floor((y * ref.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(ref.width - 1, Math.floor((x * ref.width) / w));
      const si = (sy * ref.width + sx) * 4, di = (y * w + x) * 4;
      data[di] = ref.data[si]; data[di + 1] = ref.data[si + 1]; data[di + 2] = ref.data[si + 2]; data[di + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** 검수용 프레임 스트립: [참조(있으면)] | 첫 | 중간 | 마지막 프레임 */
export async function frameStrip(file: string, ref?: { width: number; height: number; data: Buffer | Uint8Array } | null): Promise<{ jpeg: Buffer; info: Awaited<ReturnType<typeof videoInfo>>; withRef: boolean }> {
  const info = await videoInfo(file);
  const dur = info.duration ?? 1;
  const times = [0, dur / 2, Math.max(0, dur - 0.15)];
  const frames: { width: number; height: number; data: Buffer }[] = [];
  for (const t of times) frames.push(await frameAt(file, t));
  if (ref) frames.unshift(fitHeight(ref, frames[0].height) as any);
  const gap = 8;
  const h = Math.max(...frames.map((f) => f.height));
  const w = frames.reduce((s, f) => s + f.width, 0) + gap * (frames.length - 1);
  const out = Buffer.alloc(w * h * 4, 255);
  let x0 = 0;
  for (const f of frames) {
    for (let y = 0; y < f.height; y++) f.data.copy(out, (y * w + x0) * 4, y * f.width * 4, (y + 1) * f.width * 4);
    x0 += f.width + gap;
  }
  return { jpeg: Buffer.from(jpeg.encode({ data: out, width: w, height: h }, 85).data), info, withRef: !!ref };
}
