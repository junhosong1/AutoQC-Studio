// 테스트용 가짜 ComfyUI(8188) + 가짜 LM Studio(1234)
// GPU 없이 화면과 생성→검수→재생성 흐름을 확인할 때 씁니다:  npm run mock
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { WebSocketServer, WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import fsx from 'node:fs';
import pathx from 'node:path';
const ffmpeg: string = createRequire(import.meta.url)('ffmpeg-static');
function makeVideo(w: number, h: number) {
  const out = pathx.join(os.tmpdir(), `mock_${Date.now()}.mp4`);
  const hue = Math.floor(Math.random() * 360);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=24:duration=3`, '-vf', `hue=h=${hue}`, '-pix_fmt', 'yuv420p', out]);
  const b = fsx.readFileSync(out); fsx.unlinkSync(out); return b;
}

const COMFY_PORT = Number(process.env.MOCK_COMFY_PORT || 8188);
const LLM_PORT = Number(process.env.MOCK_LLM_PORT || 1234);
const FAIL_RATE = Number(process.env.MOCK_FAIL_RATE || 0.45);

const history: Record<string, any> = {};
const images = new Map<string, Buffer>();
const sockets = new Set<WebSocket>();
let n = 0;

function makeImage(w: number, h: number, flat: boolean) {
  const png = new PNG({ width: w, height: h });
  const hue = Math.random() * 360;
  const c1 = hsl(hue, 0.55, 0.62), c2 = hsl((hue + 50) % 360, 0.5, 0.28);
  const blobs = Array.from({ length: 5 }, () => ({ x: Math.random() * w, y: Math.random() * h, r: (0.08 + Math.random() * 0.2) * w, c: hsl((hue + 180 + Math.random() * 60) % 360, 0.6, 0.55) }));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (flat) { png.data[i] = png.data[i + 1] = png.data[i + 2] = 128; png.data[i + 3] = 255; continue; }
    const t = (x / w + y / h) / 2;
    let r = c1[0] * (1 - t) + c2[0] * t, g = c1[1] * (1 - t) + c2[1] * t, b = c1[2] * (1 - t) + c2[2] * t;
    for (const bl of blobs) {
      const d = Math.hypot(x - bl.x, y - bl.y);
      if (d < bl.r) { const k = 1 - d / bl.r; r = r * (1 - k) + bl.c[0] * k; g = g * (1 - k) + bl.c[1] * k; b = b * (1 - k) + bl.c[2] * k; }
    }
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function body(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((ok) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
}
const json = (res: http.ServerResponse, code: number, obj: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const comfy = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const p = url.pathname;
  if (p === '/system_stats') return json(res, 200, { system: { comfyui_version: 'mock' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 3080 : cudaMallocAsync', vram_total: 12884901888, vram_free: 11000000000 }] });
  if (p.startsWith('/object_info/')) {
    const cls = decodeURIComponent(p.split('/').pop()!);
    const info: any = {
      LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: [['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 'qwen-image-2.1-fix-1.0-comfy.safetensors']], strength_model: ['FLOAT', {}] } } },
      KSampler: { input: { required: { sampler_name: [['euler', 'euler_ancestral', 'res_multistep', 'dpmpp_2m', 'seeds_2']], scheduler: [['simple', 'normal', 'karras', 'sgm_uniform', 'beta']] } } },
    }[cls];
    return json(res, 200, info ? { [cls]: info } : {});
  }
  if (p === '/upload/image' && req.method === 'POST') { await body(req); return json(res, 200, { name: 'uploaded_' + (++n) + '.png', subfolder: '', type: 'input' }); }
  if (p === '/free' || p === '/interrupt') { await body(req); return json(res, 200, {}); }
  if (p === '/prompt' && req.method === 'POST') {
    const { prompt, client_id } = JSON.parse((await body(req)).toString());
    const id = randomUUID();
    const isVid = Object.values<any>(prompt).some((x) => /SaveVideo/.test(x.class_type));
    const latent: any = Object.values<any>(prompt).find((x) => /Latent|ImgToVideo/.test(x.class_type));
    const w = Math.min(latent?.inputs?.width ?? 1024, 1600), h = Math.min(latent?.inputs?.height ?? 1024, 1600);
    const flat = Math.random() < 0.1;
    const steps = 8;
    let i = 0;
    const tick = setInterval(() => {
      i++;
      for (const s of sockets) s.send(JSON.stringify({ type: 'progress', data: { value: i, max: steps, prompt_id: id } }));
      if (i >= steps) {
        clearInterval(tick);
        const fn = `mock_${id.slice(0, 8)}.${isVid ? 'mp4' : 'png'}`;
        images.set(fn, isVid ? makeVideo(w, h) : makeImage(w, h, flat));
        history[id] = { prompt: [n++, id, prompt, {}, []], outputs: { '9': isVid ? { images: [{ filename: fn, subfolder: 'video', type: 'output' }], animated: [true] } : { images: [{ filename: fn, subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: Date.now() }]] } };
        for (const s of sockets) s.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: id } }));
      }
    }, 180);
    return json(res, 200, { prompt_id: id, number: n, node_errors: {} });
  }
  if (p.startsWith('/history/')) { const id = p.split('/').pop()!; return json(res, 200, history[id] ? { [id]: history[id] } : {}); }
  if (p === '/history') return json(res, 200, history);
  if (p === '/view') { const f = url.searchParams.get('filename')!; const b = images.get(f); if (!b) return json(res, 404, {}); res.writeHead(200, { 'Content-Type': f.endsWith('.mp4') ? 'video/mp4' : 'image/png' }); return res.end(b); }
  // 다운로드 테스트용 파일 서버
  if (p.startsWith('/files/')) {
    if (p.includes('gated')) { res.writeHead(401); return res.end('unauthorized'); }
    const size = 5 * 1024 * 1024; const buf = Buffer.alloc(size, 7);
    res.writeHead(200, { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    let off = 0; const iv = setInterval(() => { const end = Math.min(size, off + 512 * 1024); res.write(buf.subarray(off, end)); off = end; if (off >= size) { clearInterval(iv); res.end(); } }, 60); return;
  }
  json(res, 404, { error: 'mock: unknown ' + p });
});
const wss = new WebSocketServer({ noServer: true });
comfy.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); }));
comfy.listen(COMFY_PORT, () => console.log(`mock ComfyUI  → http://127.0.0.1:${COMFY_PORT}`));

const REASONS: Record<string, string> = {
  anatomy: '왼손 손가락이 6개로 보여요.',
  text_artifact: '배경 간판의 한글이 실제 글자가 아니에요.',
  product_distortion: '제품 손잡이가 두 개로 겹쳐 보여요.',
  brand_tone: '요청한 따뜻한 톤보다 색이 차갑고 채도가 높아요.',
  composition: '제품 오른쪽 끝이 화면 밖으로 잘렸어요.',
  off_brief: '요청한 장소(카페)가 아니라 실외로 나왔어요.',
};
http.createServer(async (req, res) => {
  const p = new URL(req.url!, 'http://x').pathname;
  if (p === '/v1/models') return json(res, 200, { data: [{ id: 'google/gemma-4-26b-a4b-qat' }, { id: 'qwen/qwen3-vl-8b' }] });
  if (p === '/api/v1/models/unload') { await body(req); return json(res, 200, { instance_id: 'google/gemma-4-26b-a4b-qat' }); }
  if (p === '/v1/chat/completions') {
    const b = JSON.parse((await body(req)).toString());
    const user = b.messages[1].content;
    const hasImage = Array.isArray(user) && user.some((c: any) => c.type === 'image_url');
    await new Promise((r) => setTimeout(r, 500));
    let content: string;
    if (hasImage) {
      const fail = Math.random() < FAIL_RATE;
      const code = Object.keys(REASONS)[Math.floor(Math.random() * 6)];
      content = JSON.stringify(fail ? { score: 3 + Math.floor(Math.random() * 3), defects: [code], reason: REASONS[code] } : { score: 7 + Math.floor(Math.random() * 3), defects: [], reason: '요청과 톤에 맞고 눈에 띄는 결함이 없어요.' });
    } else {
      const text = (Array.isArray(user) ? user[0].text : user) as string;
      const fb = /FEEDBACK/.test(text) ? ' Plain unlabeled surfaces, no visible text.' : '';
      content = '```json\n' + JSON.stringify({ positive: `A premium product photograph based on the brief, soft window light, 50mm lens, shallow depth of field, clean composition.${fb}`, negative: 'blurry, distorted product, garbled text, watermark, extra fingers' }) + '\n```';
    }
    return json(res, 200, { choices: [{ message: { role: 'assistant', content } }] });
  }
  json(res, 404, { error: 'mock llm: ' + p });
}).listen(LLM_PORT, () => console.log(`mock LM Studio → http://127.0.0.1:${LLM_PORT}`));
