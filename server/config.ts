// 설정 파일 (data/settings.json) 읽기/쓰기.
// 화면의 [설정] 탭에서 바꾼 값이 여기에 저장되고, 코드는 이 값만 읽습니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA_DIR = path.join(ROOT, 'data');
export const MODULES_DIR = path.join(ROOT, 'modules');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export interface Tone { id: string; label: string; text: string }

export interface Settings {
  comfyUrl: string;
  llm: {
    backend: 'lmstudio' | 'claude';
    lmstudioUrl: string;
    lmstudioModel: string;
    claudeModel: string;
    anthropicKey: string;
    temperature: number;
  };
  qc: { passScore: number; maxAttempts: number; minStd: number };
  /** 12GB GPU용: LLM과 이미지 모델이 VRAM을 번갈아 쓰도록 매번 내려줌 */
  vramSaver: boolean;
  outputDir: string;
  /** ComfyUI models 폴더 (비우면 ComfyUI Desktop 설정에서 자동으로 찾음) */
  modelsDir: string;
  hfToken: string;
  civitaiToken: string;
  /** Comfy.org API 키 — 유료 API 노드(GPT Image, Seedance 등)를 앱에서 돌릴 때 필요. 크레딧은 Comfy 계정에서 차감 */
  comfyApiKey: string;
  tones: Tone[];
}

export const DEFAULT_SETTINGS: Settings = {
  comfyUrl: 'http://127.0.0.1:8188',
  llm: {
    backend: 'lmstudio',
    lmstudioUrl: 'http://127.0.0.1:1234',
    lmstudioModel: 'google/gemma-4-26b-a4b-qat',
    claudeModel: 'claude-haiku-5-5',
    anthropicKey: '',
    temperature: 0.4,
  },
  qc: { passScore: 7, maxAttempts: 3, minStd: 8 },
  vramSaver: true,
  outputDir: 'outputs',
  modelsDir: '',
  hfToken: '',
  civitaiToken: '',
  comfyApiKey: '',
  tones: [
    { id: 'film', label: '따뜻한 필름', text: 'warm analog film look, soft grain, golden hour light, gentle contrast, nostalgic mood' },
    { id: 'minimal', label: '미니멀 화이트', text: 'clean minimal studio look, bright white and soft grey palette, diffused softbox light, lots of negative space' },
    { id: 'dark', label: '다크 프로덕트', text: 'premium dark product look, deep charcoal background, sharp rim light, glossy reflections, high contrast' },
    { id: 'vivid', label: '비비드 커머스', text: 'vivid commerce look, saturated cheerful colors, crisp daylight, energetic and friendly' },
    { id: 'cine', label: '시네마틱', text: 'cinematic look, anamorphic lens feel, moody teal and orange grade, volumetric light, shallow depth of field' },
  ],
};

let cache: Settings | null = null;

function merge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(base)) return (over ?? base) as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) {
    const b = (base as any)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, over[k]) : over[k];
  }
  return out;
}

export function getSettings(): Settings {
  if (cache) return cache;
  let saved: any = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* 첫 실행 */ }
  cache = merge(DEFAULT_SETTINGS, saved);
  if (!cache.llm.anthropicKey && process.env.ANTHROPIC_API_KEY) cache.llm.anthropicKey = process.env.ANTHROPIC_API_KEY;
  return cache;
}

export function saveSettings(patch: any): Settings {
  const cur = getSettings();
  // 화면에는 키를 가려서 보내므로, 가려진 값이 돌아오면 기존 키를 유지
  if (patch?.llm?.anthropicKey && String(patch.llm.anthropicKey).startsWith('••')) delete patch.llm.anthropicKey;
  for (const k of ['hfToken', 'civitaiToken', 'comfyApiKey']) if (patch?.[k] && String(patch[k]).startsWith('••')) delete patch[k];
  cache = merge(cur, patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

export function publicSettings(): Settings {
  const s = structuredClone(getSettings());
  if (s.llm.anthropicKey) s.llm.anthropicKey = '••••' + s.llm.anthropicKey.slice(-4);
  if (s.hfToken) s.hfToken = '••••' + s.hfToken.slice(-4);
  if (s.civitaiToken) s.civitaiToken = '••••' + s.civitaiToken.slice(-4);
  if (s.comfyApiKey) s.comfyApiKey = '••••' + s.comfyApiKey.slice(-4);
  return s;
}

export function outputRoot(): string {
  const o = getSettings().outputDir;
  return path.isAbsolute(o) ? o : path.join(ROOT, o);
}

/** ComfyUI models 폴더: 설정값 → ComfyUI Desktop 설정(settings.json의 modelsDirs) 순서로 찾음 */
export function modelsRoot(): string | null {
  const m = getSettings().modelsDir;
  if (m) return m;
  const appdata = process.env.APPDATA;
  if (appdata) {
    try {
      const desk = JSON.parse(fs.readFileSync(path.join(appdata, 'Comfy Desktop', 'settings.json'), 'utf8'));
      if (Array.isArray(desk.modelsDirs) && desk.modelsDirs[0]) return desk.modelsDirs[0];
      if (desk.basePath) return path.join(desk.basePath, 'models');
    } catch { /* ComfyUI Desktop이 아니면 설정에서 직접 지정 */ }
  }
  return null;
}
