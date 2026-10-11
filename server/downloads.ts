// 모델 다운로드 — 앱이 준호님 PC에서 돌기 때문에, ComfyUI models 폴더로 바로 받습니다.
//  - Hugging Face / Civitai / 일반 URL
//  - 라이선스 동의가 필요한(gated) HF 모델은 설정의 HF 토큰으로 받음
//  - 받는 중에는 .part 로 저장했다가 끝나면 이름을 바꿈 (중간에 끊겨도 ComfyUI가 깨진 파일을 읽지 않게)
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSettings, modelsRoot } from './config.js';

export interface Download {
  id: string;
  url: string;
  folder: string;
  filename: string;
  label?: string;
  status: 'queued' | 'downloading' | 'done' | 'error' | 'canceled' | 'exists';
  received: number;
  total: number | null;
  speed: number; // bytes/s
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  license: string;
  gated: boolean;
  files: { url: string; folder: string; label: string; optional?: boolean }[];
}

export const PRESETS: Preset[] = [
  {
    id: 'ltx25',
    name: 'LTX-2.5 (영상 + 오디오)',
    description: 'Lightricks 22B 오픈 모델. 텍스트→영상, 이미지→영상, 첫·끝 프레임→영상. ComfyUI 템플릿 "LTX-2.5 T2V / I2V / FLF2V"에서 쓰는 파일들이에요.',
    license: 'LTX-2 Community License — Hugging Face에서 동의 필요',
    gated: true,
    files: [
      { url: 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', folder: 'diffusion_models', label: '본체 (22B distilled, int8)' },
      { url: 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', folder: 'text_encoders', label: '텍스트 인코더 (Gemma 4 12B, int8)' },
      { url: 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors', folder: 'vae', label: '영상 VAE' },
      { url: 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors', folder: 'vae', label: '오디오 VAE' },
      { url: 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', folder: 'latent_upscale_models', label: '2배 업스케일러 (T2V·I2V용)' },
      { url: 'https://huggingface.co/Comfy-Org/gemma-4/resolve/main/text_encoders/gemma4_e2b_it_int8_convrot.safetensors', folder: 'text_encoders', label: '프롬프트 강화용 (선택)', optional: true },
    ],
  },
  {
    id: 'krea2',
    name: 'Krea 2 Turbo (이미지, int8)',
    description: '사실적인 사진 질감에 강한 8스텝 증류 모델. ComfyUI 템플릿 "Krea-2 Int8: 텍스트 기반 이미지 생성"에서 쓰는 파일들이에요. (텍스트 인코더 qwen3vl_4b_fp8_scaled는 이미 있으면 건너뜀)',
    license: 'Krea 2 모델 라이선스 확인 필요',
    gated: false,
    files: [
      { url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors', folder: 'diffusion_models', label: '본체 (Turbo, int8)' },
      { url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors', folder: 'vae', label: 'VAE' },
      { url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors', folder: 'text_encoders', label: '텍스트 인코더 (Qwen3-VL 4B)', optional: true },
      { url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/loras/krea2_darkbrush.safetensors', folder: 'loras', label: '내장 스타일 LoRA (선택)', optional: true },
    ],
  },
  {
    id: 'ideogram4',
    name: 'Ideogram 4 (이미지 · 글자/레이아웃 최강)',
    description: '9.3B 오픈 가중치. ComfyUI 템플릿 "Ideogram v4"(fp8)에서 쓰는 파일들이에요. 이미 받아 두셨으면 건너뛰어도 돼요.',
    license: 'Ideogram 4 Non-Commercial (가중치)',
    gated: false,
    files: [
      { url: 'https://huggingface.co/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_fp8_scaled.safetensors', folder: 'diffusion_models', label: '본체 (fp8)' },
      { url: 'https://huggingface.co/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors', folder: 'diffusion_models', label: '무조건부 모델 (CFG용, fp8)' },
      { url: 'https://huggingface.co/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_fp8_scaled.safetensors', folder: 'text_encoders', label: '텍스트 인코더 (Qwen3-VL 8B fp8)' },
      { url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors', folder: 'vae', label: 'VAE (FLUX.2)' },
    ],
  },
];

const FOLDERS = ['loras', 'diffusion_models', 'checkpoints', 'text_encoders', 'vae', 'latent_upscale_models', 'upscale_models', 'controlnet', 'clip_vision'];
export const allowedFolders = () => FOLDERS;

const list: Download[] = [];
const listeners = new Set<(d: Download) => void>();
let running = false;
let current: { id: string; ctl: AbortController } | null = null;

export const onDownloadUpdate = (fn: (d: Download) => void) => { listeners.add(fn); return () => listeners.delete(fn); };
let last = 0;
const emit = (d: Download, force = true) => {
  const now = Date.now();
  if (!force && now - last < 500) return;
  last = now;
  for (const l of listeners) l({ ...d });
};
export const listDownloads = () => list.slice().reverse();

/** HF 페이지 주소(blob)를 실제 파일 주소(resolve)로 바꾸고, 토큰 헤더를 붙임 */
function prepare(url: string) {
  const s = getSettings();
  let u = url.trim();
  const headers: Record<string, string> = { 'User-Agent': 'AutoQC-Studio/0.1' };
  if (/huggingface\.co\//.test(u)) {
    u = u.replace('/blob/', '/resolve/');
    if (s.hfToken) headers.Authorization = `Bearer ${s.hfToken}`;
  }
  if (/civitai\.com\//.test(u)) {
    const m = u.match(/civitai\.com\/models\/(\d+).*?modelVersionId=(\d+)/);
    if (m) u = `https://civitai.com/api/download/models/${m[2]}`;
    if (s.civitaiToken) u += (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(s.civitaiToken);
  }
  return { url: u, headers };
}

function guessName(url: string, res?: Response) {
  const cd = res?.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) return decodeURIComponent(m[1]);
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.safetensors');
}

function explain(status: number, url: string) {
  if ((status === 401 || status === 403) && /huggingface/.test(url))
    return getSettings().hfToken
      ? `접근 거부 (${status}): Hugging Face에서 이 모델의 라이선스에 동의했는지 확인해 주세요.`
      : `접근 거부 (${status}): 라이선스 동의가 필요한 모델이에요. HF에서 동의한 뒤 [설정]에 HF 토큰을 넣어 주세요.`;
  if (status === 401 && /civitai/.test(url)) return 'Civitai 로그인이 필요한 파일이에요. [설정]에 Civitai API 키를 넣어 주세요.';
  if (status === 404) return '파일을 찾을 수 없어요 (주소 확인).';
  return `다운로드 실패 (HTTP ${status})`;
}

/** 크기 미리 확인 (HEAD) */
export async function probe(url: string) {
  const p = prepare(url);
  try {
    const r = await fetch(p.url, { method: 'HEAD', headers: p.headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, size: null, error: explain(r.status, url), filename: guessName(p.url) };
    const size = Number(r.headers.get('x-linked-size') || r.headers.get('content-length')) || null;
    return { ok: true, size, filename: guessName(r.url || p.url, r) };
  } catch (e: any) {
    return { ok: false, size: null, error: '연결 실패: ' + e.message, filename: guessName(p.url) };
  }
}

export function addDownload(url: string, folder: string, label?: string, filename?: string): Download {
  if (!FOLDERS.includes(folder)) throw new Error('지원하지 않는 폴더: ' + folder);
  const root = modelsRoot();
  if (!root) throw new Error('ComfyUI models 폴더를 찾지 못했어요. [설정]에서 직접 지정해 주세요.');
  const name = filename || guessName(prepare(url).url);
  const dup = list.find((d) => d.folder === folder && d.filename === name && (d.status === 'queued' || d.status === 'downloading'));
  if (dup) return dup;
  const d: Download = { id: Math.random().toString(36).slice(2, 10), url, folder, filename: name, label, status: 'queued', received: 0, total: null, speed: 0 };
  if (fs.existsSync(path.join(root, folder, name))) {
    d.status = 'exists';
    d.total = d.received = fs.statSync(path.join(root, folder, name)).size;
  }
  list.push(d);
  emit(d);
  void pump();
  return d;
}

export function cancelDownload(id: string) {
  const d = list.find((x) => x.id === id);
  if (!d) return;
  if (d.status === 'queued') { d.status = 'canceled'; emit(d); }
  if (current?.id === id) current.ctl.abort();
}

async function pump() {
  if (running) return;
  running = true;
  try {
    let d: Download | undefined;
    while ((d = list.find((x) => x.status === 'queued'))) await run(d);
  } finally { running = false; }
}

async function run(d: Download) {
  const root = modelsRoot()!;
  const dir = path.join(root, d.folder);
  fs.mkdirSync(dir, { recursive: true });
  const ctl = new AbortController();
  current = { id: d.id, ctl };
  d.status = 'downloading';
  d.startedAt = Date.now();
  emit(d);
  const p = prepare(d.url);
  const part = path.join(dir, d.filename + '.part');
  try {
    // 이어받기: .part가 남아 있으면 그 지점부터
    let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const headers = { ...p.headers, ...(start ? { Range: `bytes=${start}-` } : {}) };
    const r = await fetch(p.url, { headers, redirect: 'follow', signal: ctl.signal });
    if (!r.ok && r.status !== 206) throw new Error(explain(r.status, d.url));
    if (start && r.status !== 206) start = 0; // 서버가 이어받기를 지원 안 함 → 처음부터
    const len = Number(r.headers.get('content-length')) || 0;
    d.total = len ? len + start : null;
    d.received = start;
    let windowStart = Date.now(), windowBytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        d.received += chunk.byteLength;
        windowBytes += chunk.byteLength;
        const now = Date.now();
        if (now - windowStart > 1000) { d.speed = (windowBytes * 1000) / (now - windowStart); windowStart = now; windowBytes = 0; }
        emit(d, false);
        c.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body!.pipeThrough(counter) as any), fs.createWriteStream(part, { flags: start ? 'a' : 'w' }));
    fs.renameSync(part, path.join(dir, d.filename));
    d.status = 'done';
  } catch (e: any) {
    d.status = ctl.signal.aborted ? 'canceled' : 'error';
    if (!ctl.signal.aborted) d.error = e.message;
  }
  d.finishedAt = Date.now();
  d.speed = 0;
  current = null;
  emit(d);
}
