// 서버 API 호출 + 화면에서 쓰는 타입
export async function api<T = any>(path: string, body?: any, method?: string): Promise<T> {
  const r = await fetch(path, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j as T;
}

export const fileUrl = (rel?: string) => (rel ? '/files/' + rel.split('/').map(encodeURIComponent).join('/') : '');

export interface ParamDef { key: string; label: string; node: string; input: string; type: 'int' | 'float' | 'select' | 'text' | 'bool'; min?: number; max?: number; step?: number; options?: string[]; default: any }
export interface ModuleDef {
  id: string; name: string; category: 'image' | 'edit' | 'video' | 'tool'; description: string; license: string; cost: string; vram: string;
  ready: boolean; problems: string[]; notes: string[];
  prompt?: { node: string; input: string }; prompt2?: { node: string; input: string }; seeds: any[]; size?: { node: string; width: number; height: number };
  images: { node: string; input: string; label: string }[];
  lora: { mode: 'existing' | 'inject' | 'none'; node?: string };
  /** LoRA가 들어가는 모델 (계열: qwen / ltx / wan / flux …) */
  loraTarget?: { file: string; family: string | null; label: string; stage: string } | null;
  /** 워크플로우에 원래 들어 있던 LoRA */
  loraDefault?: { name: string; strength: number } | null;
  /** 워크플로우에 내장된(스위치로 켜는) LoRA 파일들 — 자동 선택 제외 */
  builtinLoras?: string[];
  keyframe?: { save: string; source: [string, number]; videoOutputs: string[] };
  params: ParamDef[]; outputs: string[]; nodeCount: number;
}
export interface Tone { id: string; label: string; text: string }
export interface Settings {
  comfyUrl: string;
  llm: { backend: 'lmstudio' | 'claude'; lmstudioUrl: string; lmstudioModel: string; claudeModel: string; anthropicKey: string; temperature: number };
  qc: { passScore: number; maxAttempts: number; minStd: number };
  vramSaver: boolean; outputDir: string; modelsDir: string; hfToken: string; civitaiToken: string; comfyApiKey?: string; tones: Tone[];
}
export interface Status {
  comfy: { ok: boolean; gpu?: string; vramTotal?: number; vramFree?: number; error?: string };
  llm: { ok: boolean; backend: string; model: string; models: string[]; hasModel: boolean; error: string | null };
  url: string;
}
export interface Attempt {
  n: number; seed: number; prompt: string; negative: string; promptSource: string;
  status: 'prompting' | 'generating' | 'reviewing' | 'passed' | 'failed' | 'done' | 'unchecked' | 'error' | 'canceled';
  progress: number; file?: string; width?: number; height?: number; kind?: 'image' | 'video'; poster?: string; duration?: number; fps?: number; hasAudio?: boolean; score?: number; defects?: string[]; reason?: string;
  stage?: 'rule' | 'llm' | 'keyframe'; retryStrategy?: 'prompt+seed' | 'seed' | 'prompt+seed+res'; error?: string;
  phase?: 'keyframe' | 'video'; keyframe?: string; keyframeScore?: number;
  times: { prompt?: number; gen?: number; qc?: number; swap?: number };
  motionPrompt?: string;
}
export interface Item { index: number; status: string; attempts: Attempt[]; final?: number; sortedFile?: string; human?: 'accept' | 'reject'; totalSec?: number }
export interface Job {
  id: string; createdAt: number; finishedAt?: number; moduleId: string; moduleName: string; brief: string; toneId?: string; toneLabel: string; toneText: string;
  enhance: boolean; count: number; width?: number; height?: number; seedMode: string; seed?: number;
  lora?: { name: string; strength: number } | null; images?: (string | null)[]; params?: Record<string, any>;
  qc: { enabled: boolean; passScore: number; maxAttempts: number };
  llmBackend: string; llmModel: string;
  status: 'queued' | 'running' | 'done' | 'canceled' | 'error'; items: Item[]; error?: string;
  credits?: { before?: number; after?: number; spent?: number };
}
export interface Credits { configured: boolean; usd?: number; credits?: number; at?: number; error?: string }
export const fmtCr = (n: number) => n.toLocaleString('ko-KR');

export const DEFECT_LABEL: Record<string, string> = {
  off_brief: '기획 불일치', product_distortion: '제품 변형', anatomy: '인체 파손', text_artifact: '깨진 글자',
  low_quality: '저품질', composition: '구도', brand_tone: '톤앤매너', motion_artifact: '영상 변형',
};

export const isVideo = (file?: string) => !!file && /\.(mp4|webm|mov|mkv|gif)$/i.test(file);

export interface Download {
  id: string; url: string; folder: string; filename: string; label?: string;
  status: 'queued' | 'downloading' | 'done' | 'error' | 'canceled' | 'exists';
  received: number; total: number | null; speed: number; error?: string;
}
export interface Preset { id: string; name: string; description: string; license: string; gated: boolean; files: { url: string; folder: string; label: string; optional?: boolean }[] }
export const fmtBytes = (b?: number | null) => (b === null || b === undefined ? '-' : b >= 1e9 ? (b / 1e9).toFixed(1) + 'GB' : b >= 1e6 ? (b / 1e6).toFixed(0) + 'MB' : (b / 1e3).toFixed(0) + 'KB');

export function itemBadge(job: Job, it: Item): { cls: string; text: string } {
  const last = it.attempts[it.attempts.length - 1];
  const fin = it.final !== undefined ? it.attempts[it.final] : undefined;
  switch (it.status) {
    case 'queued': return { cls: 'gray', text: '대기' };
    case 'passed': return { cls: 'pass', text: `PASS · ${fin?.score ?? '-'}` };
    case 'failed': return { cls: 'fail', text: `FAIL · ${it.attempts.length}회 시도` };
    case 'unchecked': return { cls: 'warn', text: '미검수' };
    case 'done': return { cls: 'gray', text: '완료 · 검수 끔' };
    case 'error': return { cls: 'fail', text: '오류' };
    case 'canceled': return { cls: 'gray', text: '취소' };
  }
  if (!last) return { cls: 'run', text: '준비 중' };
  const retry = last.n > 1 ? `재생성 ${last.n}/${job.qc.maxAttempts} · ` : '';
  if (last.status === 'prompting') return { cls: 'run', text: retry + '프롬프트 작성' };
  if (last.status === 'generating') return { cls: last.n > 1 ? 'warn' : 'run', text: retry + (last.progress > 0 ? `생성 ${Math.round(last.progress * 100)}%` : '생성 준비') };
  if (last.status === 'reviewing') return { cls: last.n > 1 ? 'warn' : 'run', text: retry + '검수 중' };
  return { cls: 'run', text: '진행 중' };
}

export const fmtSec = (s?: number | null) => (s === undefined || s === null ? '-' : s >= 60 ? `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초` : `${s}초`);
export const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : String(Math.round(x * 100)));

/** LoRA 파일 이름으로 어떤 모델용인지 추정 (모르면 null) */
const LORA_FAMILIES: [string, RegExp, string][] = [
  ['qwen', /qwen/i, 'Qwen Image'], ['ltx', /ltx/i, 'LTX'], ['wan', /wan2|wan_|(^|[^a-z])wan/i, 'Wan'], ['flux', /flux/i, 'Flux'],
  ['zimage', /z[-_]?image/i, 'Z-Image'], ['hunyuan', /hunyuan/i, 'HunyuanVideo'], ['sdxl', /sdxl|(^|_)xl_/i, 'SDXL'], ['minimax', /minimax|hailuo/i, 'MiniMax H3'], ['ideogram', /ideogram/i, 'Ideogram 4'], ['krea', /krea/i, 'Krea 2'],
];
export function loraFamily(name: string) { const f = LORA_FAMILIES.find(([, re]) => re.test(name)); return f ? { id: f[0], label: f[2] } : null; }

/** 다음 시도 전략 설명 */
export function retryLabel(a: { retryStrategy?: string; keyframe?: string; stage?: string }, short = false) {
  if (a.retryStrategy === 'prompt+seed+res') return short ? '제품 크게·정면 + 해상도↑ + 새 시드' : '라벨 글자 깨짐 → 제품을 더 크게·정면으로 프롬프트 재작성 + 키프레임 해상도↑ + 새 시드';
  if (a.retryStrategy === 'prompt+seed') return short ? '프롬프트 수정 + 새 시드' : '검수 사유를 넣어 프롬프트 재작성 + 새 시드';
  if (a.keyframe && a.stage !== 'keyframe') return short ? '키프레임 유지 + 영상 새 시드' : '통과한 키프레임은 그대로 두고 영상만 새 시드로';
  return short ? '새 시드' : '같은 프롬프트, 새 시드';
}
