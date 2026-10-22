// 모듈 로더 — modules/<폴더>/workflow.json (+ manifest.json) 을 읽어 화면 메뉴로 만듭니다.
//
// 핵심 아이디어: 워크플로우만 넣어도 동작하게 "자동 인식"을 먼저 하고,
// manifest.json에 적은 값이 있으면 그 값으로 덮어씁니다.
//   - 프롬프트 칸 : 문자열 안에 PROMPT_HERE 가 있는 입력 (없으면 텍스트 인코더의 text 입력)
//   - 네거티브     : NEGATIVE_HERE
//   - 시드         : seed / noise_seed 입력 전부
//   - 해상도       : Empty...Latent 노드의 width / height
//   - 참조 이미지  : LoadImage 노드
//   - LoRA        : 기존 LoRA 노드가 있으면 그 값을 바꾸고, 없으면 모델 로더 뒤에 자동으로 끼워 넣음
//   - 고급 설정    : 샘플러 steps/cfg/sampler/scheduler/denoise, shift, guidance
import fs from 'node:fs';
import path from 'node:path';
import { MODULES_DIR } from './config.js';
import { ApiWorkflow, Comfy, isLink } from './comfy.js';

export interface Binding { node: string; input: string }
export interface ParamDef {
  key: string; label: string; node: string; input: string;
  type: 'int' | 'float' | 'select' | 'text' | 'bool';
  min?: number; max?: number; step?: number; options?: string[]; default: any;
}
export type LoraMode =
  | { mode: 'existing'; node: string }
  | { mode: 'inject'; node: string; output: number }
  | { mode: 'none' };

export interface ModuleDef {
  id: string;
  name: string;
  category: 'image' | 'edit' | 'video' | 'tool';
  description: string;
  license: string;
  cost: 'local' | 'paid';
  vram: string;
  ready: boolean;
  problems: string[];
  notes: string[];
  prompt?: Binding;
  prompt2?: Binding;
  negative?: Binding;
  seeds: Binding[];
  size?: { node: string; width: number; height: number };
  images: (Binding & { label: string })[];
  lora: LoraMode;
  params: ParamDef[];
  outputs: string[];
  /** 영상 워크플로우 안의 중간 이미지(키프레임) 저장 노드 — 있으면 키프레임을 먼저 검수 */
  keyframe?: { save: string; source: [string, number]; videoOutputs: string[] };
  /** 프롬프트 작성 방식: ref-video = 레퍼런스→영상 (MiniMax R2V 등), refToken = 참조 이미지 지칭 방식 */
  promptStyle?: 'ref-video';
  refToken?: string;
  /** 유료 API 노드: 시드 상한, 크기 제한(배수·화소 범위) */
  seedMax?: number;
  clamp?: { node: string; w: string; h: string; minPx?: number; maxPx?: number; maxEdge?: number; mult?: number };
  nodeCount: number;
  workflow: ApiWorkflow | null;
}

const TEXT_INPUTS = ['text', 'prompt', 'text_g', 'positive', 'value', 'string'];
const MODEL_LOADER = /^(UNETLoader|UnetLoaderGGUF|CheckpointLoaderSimple|DiffusionModelLoader.*|CheckpointLoader.*)$/;
const LORA_NODE = /^(LoraLoaderModelOnly|LoraLoader)$/;
const LLM_NODE = /LLM|Ollama|LMStudio|^GeminiNode$|OpenAIChat|Claude|Anthropic|Reviewer/i;

const PARAM_RULES: { cls: RegExp; inputs: Record<string, Omit<ParamDef, 'key' | 'node' | 'input' | 'default'>> }[] = [
  {
    cls: /^(KSampler|KSamplerAdvanced)$/,
    inputs: {
      steps: { label: 'Steps', type: 'int', min: 1, max: 150, step: 1 },
      cfg: { label: 'CFG', type: 'float', min: 0, max: 30, step: 0.1 },
      sampler_name: { label: 'Sampler', type: 'select' },
      scheduler: { label: 'Scheduler', type: 'select' },
      denoise: { label: 'Denoise', type: 'float', min: 0, max: 1, step: 0.01 },
    },
  },
  { cls: /^ModelSampling(AuraFlow|SD3|Flux)$/, inputs: { shift: { label: 'Shift', type: 'float', min: 0, max: 20, step: 0.05 } } },
  { cls: /^BasicScheduler$/, inputs: { steps: { label: 'Steps', type: 'int', min: 1, max: 150, step: 1 }, scheduler: { label: 'Scheduler', type: 'select' }, denoise: { label: 'Denoise', type: 'float', min: 0, max: 1, step: 0.01 } } },
  { cls: /^KSamplerSelect$/, inputs: { sampler_name: { label: 'Sampler', type: 'select' } } },
  { cls: /^CFGGuider$/, inputs: { cfg: { label: 'CFG', type: 'float', min: 0, max: 30, step: 0.1 } } },
  { cls: /ResolutionSelector|AspectRatio/i, inputs: { aspect_ratio: { label: '비율', type: 'select' }, megapixels: { label: '메가픽셀', type: 'float', min: 0.25, max: 4, step: 0.05 } } },
  { cls: /.*/, inputs: { length: { label: '프레임 수', type: 'int', min: 1, max: 1000, step: 1 }, num_frames: { label: '프레임 수', type: 'int', min: 1, max: 1000, step: 1 }, frame_rate: { label: 'FPS', type: 'float', min: 1, max: 60, step: 1 }, fps: { label: 'FPS', type: 'float', min: 1, max: 60, step: 1 } } },
  { cls: /^LTXVImgToVideoInplace$/, inputs: { strength: { label: '첫 프레임 고정 강도', type: 'float', min: 0, max: 1, step: 0.05 } } },
  { cls: /^LTXVAddGuide$/, inputs: { strength: { label: '프레임 가이드 강도', type: 'float', min: 0, max: 1, step: 0.05 } } },
  { cls: /^LTXVPreprocess$/, inputs: { img_compression: { label: '입력 이미지 압축', type: 'int', min: 0, max: 100, step: 1 } } },
  { cls: /^FluxGuidance$/, inputs: { guidance: { label: 'Guidance', type: 'float', min: 0, max: 30, step: 0.1 } } },
];

const title = (wf: ApiWorkflow, id: string) => wf[id]?._meta?.title || wf[id]?.class_type || id;

export function isUiFormat(obj: any) {
  return obj && Array.isArray(obj.nodes) && Array.isArray(obj.links);
}

const PASS_KEYS = ['text', 'prompt', 'string', 'value', 'source', 'input', 'text_a', 'on_false', 'on_true'];

/** 텍스트 인코더의 프롬프트 입력을 거슬러 올라가 실제로 쓰이는 문자열 칸을 찾음 (Switch는 현재 분기만 따라감) */
function traceText(wf: ApiWorkflow, nodeId: string, input: string, depth = 0): (Binding & { value: string }) | null {
  const v = wf[nodeId]?.inputs?.[input];
  if (typeof v === 'string') return { node: nodeId, input, value: v };
  if (!isLink(v) || depth > 12) return null;
  const src = String(v[0]);
  const n = wf[src];
  if (!n) return null;
  const ins = n.inputs ?? {};
  if ('switch' in ins && ('on_true' in ins || 'on_false' in ins) && typeof ins.switch === 'boolean') return traceText(wf, src, ins.switch ? 'on_true' : 'on_false', depth + 1);
  for (const k of PASS_KEYS) if (k in ins) { const r = traceText(wf, src, k, depth + 1); if (r) return r; }
  return null;
}

/** 출력이 negative 입력으로만 들어가는 인코더 = 네거티브 프롬프트 */
/** 텍스트를 받아 조건(conditioning)을 만드는 노드: 일반 인코더 + 프롬프트를 직접 받는 영상 노드(MiniMaxH3ImageToVideo 등) */
function isEncoderLike(wf: ApiWorkflow, id: string) {
  const n = wf[id];
  if (/Encode/i.test(n.class_type)) return true;
  // 텍스트 생성(LLM) 노드도 clip+prompt를 받으므로 제외
  if (/Generate|LLM|Ollama|Gemini|OpenAI|Claude|Enhanc/i.test(n.class_type)) return false;
  return isLink(n.inputs?.clip) && ['prompt', 'text'].some((k) => k in (n.inputs ?? {}));
}

function isNegativeEncoder(wf: ApiWorkflow, id: string) {
  if (/neg/i.test(wf[id]._meta?.title ?? '')) return true;
  let pos = 0, neg = 0;
  for (const n of Object.values(wf)) for (const [k, v] of Object.entries(n.inputs ?? {})) {
    if (isLink(v) && String(v[0]) === id && v[1] === 0) /neg/i.test(k) ? neg++ : pos++;
  }
  return neg > 0 && pos === 0;
}

/** 실제로 쓰이는 프롬프트 칸 전부 (이미지 편집용 인코더 → 영상용 인코더 순서) */
export function findPromptInputs(wf: ApiWorkflow): (Binding & { value: string; encoder: string })[] {
  const enc = Object.keys(wf)
    .filter((id) => isEncoderLike(wf, id) && !isNegativeEncoder(wf, id))
    .sort((a, b) => Number(/Qwen|Image|Edit|Flux|SD3|Lumina/i.test(wf[b].class_type)) - Number(/Qwen|Image|Edit|Flux|SD3|Lumina/i.test(wf[a].class_type)));
  const out: (Binding & { value: string; encoder: string })[] = [];
  for (const id of enc) for (const k of ['text', 'prompt', 'text_g', 'positive']) {
    if (!(k in (wf[id].inputs ?? {}))) continue;
    const r = traceText(wf, id, k);
    if (r && !out.some((o) => o.node === r.node && o.input === r.input)) out.push({ ...r, encoder: id });
    if (r) break;
  }
  return out;
}

export function findPromptInput(wf: ApiWorkflow): (Binding & { value: string }) | null {
  return findPromptInputs(wf)[0] ?? null;
}

export function detect(wf: ApiWorkflow) {
  const ids = Object.keys(wf);
  const notes: string[] = [];
  const problems: string[] = [];
  const strInputs: { id: string; input: string; value: string }[] = [];
  for (const id of ids) for (const [k, v] of Object.entries(wf[id].inputs ?? {})) if (typeof v === 'string') strInputs.push({ id, input: k, value: v });

  // 프롬프트
  let prompt: Binding | undefined;
  const ph = strInputs.find((s) => s.value.includes('PROMPT_HERE'));
  if (ph) { prompt = { node: ph.id, input: ph.input }; notes.push(`프롬프트: PROMPT_HERE → ${title(wf, ph.id)}`); }
  else {
    const tr = findPromptInput(wf);
    if (tr) { prompt = { node: tr.node, input: tr.input }; notes.push(`프롬프트: PROMPT_HERE가 없어 "${title(wf, tr.node)}"의 ${tr.input} 칸을 사용`); }
  }
  if (!prompt) {
    const linked = ids.some((id) => isEncoderLike(wf, id) && TEXT_INPUTS.some((k) => isLink(wf[id].inputs?.[k])));
    problems.push(linked
      ? '프롬프트 칸이 다른 노드(LLM 등)에 연결돼 있어요. 그 연결을 빼고 텍스트 칸에 PROMPT_HERE를 넣어 주세요.'
      : '프롬프트를 넣을 칸을 찾지 못했어요. 텍스트 칸에 PROMPT_HERE를 넣고 다시 Export (API) 해주세요.');
  }

  // 두 번째 프롬프트 (예: 키프레임용 + 영상 움직임용)
  let prompt2: Binding | undefined;
  const ph2 = strInputs.find((s) => s.value.includes('PROMPT2_HERE'));
  if (ph2) prompt2 = { node: ph2.id, input: ph2.input };
  else {
    const all = findPromptInputs(wf).filter((p) => !(prompt && p.node === prompt.node && p.input === prompt.input));
    if (all[0]) prompt2 = { node: all[0].node, input: all[0].input };
  }
  if (prompt2) notes.push(`두 번째 프롬프트: "${title(wf, prompt2.node)}" (영상 움직임·카메라용)`);

  // 네거티브
  const nh = strInputs.find((s) => s.value.includes('NEGATIVE_HERE'))
    ?? strInputs.find((s) => s.input === 'negative_prompt' && /Encode/i.test(wf[s.id].class_type));
  const negative = nh ? { node: nh.id, input: nh.input } : undefined;

  // 시드
  const seeds: Binding[] = [];
  for (const id of ids) for (const k of ['seed', 'noise_seed']) if (typeof wf[id].inputs?.[k] === 'number') seeds.push({ node: id, input: k });
  notes.push(seeds.length ? `시드: ${seeds.length}곳` : '시드 입력 없음 (매번 같은 결과가 나올 수 있어요)');

  // 해상도
  let size: ModuleDef['size'];
  for (const id of ids) {
    const n = wf[id];
    if (/Empty.*Latent|LatentImage$|LatentVideo|ImgToVideo|ImageToVideo/i.test(n.class_type) && typeof n.inputs?.width === 'number' && typeof n.inputs?.height === 'number') {
      size = { node: id, width: n.inputs.width, height: n.inputs.height };
      notes.push(`해상도: ${n.inputs.width}×${n.inputs.height} (${title(wf, id)})`);
      break;
    }
  }

  // 참조 이미지
  const images = ids
    .filter((id) => /^LoadImage/.test(wf[id].class_type) && typeof wf[id].inputs?.image === 'string')
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((id, i) => ({ node: id, input: 'image', label: wf[id]._meta?.title && wf[id]._meta!.title !== 'Load Image' ? wf[id]._meta!.title! : `참조 이미지 ${i + 1}` }));
  if (images.length) notes.push(`참조 이미지 입력: ${images.length}개`);

  // LoRA
  let lora: LoraMode = { mode: 'none' };
  // 스위치로 켜고 끄는 내장 LoRA(예: MiniMax H3의 Lightning 속도 LoRA)는 사용자 LoRA 자리로 쓰지 않음 → 그 경우 모델 로더 뒤에 따로 삽입
  const gated = (id: string) => ids.some((o) => /Switch/i.test(wf[o].class_type) && ['on_true', 'on_false'].some((k) => isLink(wf[o].inputs?.[k]) && String(wf[o].inputs[k][0]) === id));
  const existing = ids.find((id) => LORA_NODE.test(wf[id].class_type) && !gated(id));
  if (existing) { lora = { mode: 'existing', node: existing }; notes.push('LoRA: 워크플로우에 있는 LoRA 노드 사용'); }
  else {
    const loader = ids.find((id) => MODEL_LOADER.test(wf[id].class_type) && ids.some((o) => Object.values(wf[o].inputs ?? {}).some((v) => isLink(v) && String(v[0]) === id && v[1] === 0)));
    if (loader) { lora = { mode: 'inject', node: loader, output: 0 }; notes.push(`LoRA: 필요할 때 "${title(wf, loader)}" 뒤에 자동 삽입`); }
  }

  // 고급 설정
  const params: ParamDef[] = [];
  const samplerCount = ids.filter((id) => /KSampler/.test(wf[id].class_type)).length;
  for (const id of ids) {
    const n = wf[id];
    for (const rule of PARAM_RULES) {
      if (!rule.cls.test(n.class_type)) continue;
      for (const [inp, def] of Object.entries(rule.inputs)) {
        const v = n.inputs?.[inp];
        if (v === undefined || isLink(v)) continue;
        const prefix = samplerCount > 1 || !/KSampler/.test(n.class_type) ? `${title(wf, id)} · ` : '';
        params.push({ ...def, key: `${id}.${inp}`, node: id, input: inp, default: v, label: prefix + def.label });
      }
    }
  }

  // 프리셋 콤보 (예: Ideogram 4의 Quality / Default / Turbo)
  for (const id of ids) {
    const n = wf[id];
    if (n.class_type !== 'CustomCombo' || typeof n.inputs?.choice !== 'string') continue;
    const options = Object.entries<any>(n.inputs).filter(([k, v]) => /^option\d+$/.test(k) && typeof v === 'string' && v).map(([, v]) => v);
    if (options.length < 2) continue;
    params.unshift({ key: `${id}.choice`, node: id, input: 'choice', label: /quality|turbo/i.test(options.join(' ')) ? '품질 프리셋' : title(wf, id), type: 'select', options, default: n.inputs.choice });
  }

  // 값 노드 (Int / Float 상수: Duration, Frame Rate, Width 같은 제목의 노드) → 제목 그대로 고급 설정에 노출
  for (const id of ids) {
    const n = wf[id];
    const ins = n.inputs ?? {};
    const keys = Object.keys(ins).filter((k) => k !== 'control_after_generate');
    if (keys.length !== 1 || !['value', 'int', 'float', 'number'].includes(keys[0])) continue;
    const v = ins[keys[0]];
    if (typeof v === 'boolean') {
      // 켜고 끄는 값 노드 (예: Enable Lightning LoRA). 앱이 대신하는 기능(프롬프트 확장)·모듈 성격을 바꾸는 스위치는 숨김
      const t = title(wf, id);
      if (/prompt enhance|refine prompt|text to video|switch to/i.test(t)) continue;
      params.unshift({ key: `${id}.${keys[0]}`, node: id, input: keys[0], label: /lightning|turbo/i.test(t) ? '빠른 모드 (Lightning LoRA)' : t.replace(/^Boolean\s*\(?|\)$/g, ''), type: 'bool', default: v });
      continue;
    }
    if (typeof v !== 'number' || /seed/i.test(title(wf, id))) continue;
    if (params.some((p) => p.key === `${id}.${keys[0]}`)) continue;
    const isInt = Number.isInteger(v) && !/float/i.test(n.class_type);
    params.unshift({ key: `${id}.${keys[0]}`, node: id, input: keys[0], label: title(wf, id), type: isInt ? 'int' : 'float', step: isInt ? 1 : 0.1, default: v });
  }

  const outputs = ids.filter((id) => /SaveImage|PreviewImage|SaveVideo|VHS_VideoCombine|SaveAnimated|SaveWEBM|CreateVideo/.test(wf[id].class_type));
  const isVideo = ids.some((id) => /SaveVideo|VHS_VideoCombine|SaveAnimated|SaveWEBM|CreateVideo|LTXV|WanImageToVideo|Wan22|HunyuanVideo/i.test(wf[id].class_type));
  if (isVideo) notes.push('영상 워크플로우로 인식');
  if (!outputs.length) problems.push('결과를 저장하는 노드(Save Image)가 없어요.');
  const llmNodes = ids.filter((id) => LLM_NODE.test(wf[id].class_type));
  if (llmNodes.length) notes.push(`주의: LLM 계열 노드 ${llmNodes.length}개 포함 (${[...new Set(llmNodes.map((i) => wf[i].class_type))].join(', ')}) — 앱이 프롬프트/검수를 하므로 빼는 것을 권장`);

  // 키프레임: 영상 워크플로우 안에 이미지 저장 노드가 있으면 (예: Elements의 "키프레임 저장")
  let keyframe: { save: string; source: [string, number]; videoOutputs: string[] } | undefined;
  if (isVideo) {
    const videoOutputs = ids.filter((id) => /SaveVideo|VHS_VideoCombine|SaveAnimated|SaveWEBM/i.test(wf[id].class_type));
    const save = ids.find((id) => /^SaveImage/.test(wf[id].class_type) && isLink(wf[id].inputs?.images));
    if (save && videoOutputs.length) {
      const src = wf[save].inputs.images;
      keyframe = { save, source: [String(src[0]), Number(src[1])], videoOutputs };
      notes.push('키프레임 먼저 검수 → 통과한 키프레임으로만 영상 생성');
    }
  }
  return { prompt, prompt2, negative, seeds, size, images, lora, params, outputs, notes, problems, isVideo, keyframe };
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

let modules: ModuleDef[] = [];
let filesSig = '';

/** modules 폴더 안 workflow.json / manifest.json 의 수정 시각 묶음 — 바뀌면 다시 읽음 */
function modulesSignature() {
  if (!fs.existsSync(MODULES_DIR)) return '';
  const parts: string[] = [];
  for (const dir of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of ['workflow.json', 'manifest.json']) {
      try { const st = fs.statSync(path.join(MODULES_DIR, dir.name, f)); parts.push(`${dir.name}/${f}:${st.mtimeMs}:${st.size}`); } catch { parts.push(`${dir.name}/${f}:-`); }
    }
  }
  return parts.join('|');
}

/** 앱을 켜 둔 채로 모듈 파일을 옮기거나 고쳐도 바로 반영 (재시작 불필요) */
export function refreshModulesIfChanged() {
  try { if (modulesSignature() !== filesSig) loadModules(); } catch { /* */ }
}

export function loadModules(): ModuleDef[] {
  const list: ModuleDef[] = [];
  filesSig = modulesSignature();
  if (!fs.existsSync(MODULES_DIR)) fs.mkdirSync(MODULES_DIR, { recursive: true });
  for (const dir of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('_') || dir.name.startsWith('.')) continue;
    const base = path.join(MODULES_DIR, dir.name);
    let manifest: any = {};
    const problems: string[] = [];
    try { if (fs.existsSync(path.join(base, 'manifest.json'))) manifest = readJson(path.join(base, 'manifest.json')); }
    catch (e: any) { problems.push('manifest.json 형식 오류: ' + e.message); }

    let workflow: ApiWorkflow | null = null;
    const wfFile = path.join(base, manifest.workflow || 'workflow.json');
    if (!fs.existsSync(wfFile)) problems.push('workflow.json이 아직 없어요. [모듈 가져오기]로 ComfyUI 최근 실행에서 가져오거나, Export (API) 파일을 이 폴더에 넣어 주세요.');
    else {
      try {
        const raw = readJson(wfFile);
        if (isUiFormat(raw)) problems.push('일반 저장 형식이에요. ComfyUI에서 Workflow → Export (API)로 다시 저장해 주세요.');
        else workflow = raw;
      } catch (e: any) { problems.push('workflow.json 형식 오류: ' + e.message); }
    }

    const d = workflow ? detect(workflow) : null;
    const m: ModuleDef = {
      id: dir.name,
      name: manifest.name || dir.name,
      // 영상 출력 워크플로우는 manifest 값과 상관없이 항상 [영상 생성] 탭에 (예전 manifest가 남아 있어도)
      category: d?.isVideo ? 'video' : (manifest.category && manifest.category !== 'video' ? manifest.category : (d?.images.length ? 'edit' : 'image')),
      description: manifest.description || '',
      license: manifest.license || '',
      cost: manifest.cost || 'local',
      vram: manifest.vram || '',
      problems: [...problems, ...(d?.problems ?? [])],
      notes: [...(d?.notes ?? []), ...(manifest.notes ?? [])],
      prompt: manifest.prompt || d?.prompt,
      prompt2: manifest.prompt2 || d?.prompt2,
      negative: manifest.negative || d?.negative,
      seeds: manifest.seeds || d?.seeds || [],
      size: manifest.size || d?.size,
      images: (manifest.images || d?.images || []).map((im: any, i: number) => ({ ...(d?.images[i] ?? {}), ...im })),
      lora: manifest.lora || d?.lora || { mode: 'none' },
      params: d?.params ?? [],
      outputs: d?.outputs ?? [],
      keyframe: d?.keyframe,
      promptStyle: manifest.promptStyle ?? (workflow && Object.values<any>(workflow).some((n) => /ReferenceToVideo/.test(n.class_type)) ? 'ref-video' : undefined),
      refToken: manifest.refToken ?? (workflow && Object.values<any>(workflow).some((n) => /^MiniMax/.test(n.class_type)) ? '<Picture {n}>' : undefined),
      seedMax: manifest.seedMax, clamp: manifest.clamp,
      nodeCount: workflow ? Object.keys(workflow).length : 0,
      workflow,
      ready: false,
    };
    // manifest.params: 라벨/범위 덮어쓰기, hide 로 숨기기
    if (Array.isArray(manifest.params)) {
      for (const p of manifest.params) {
        const i = m.params.findIndex((x) => x.key === p.key);
        if (p.hide) { if (i >= 0) m.params.splice(i, 1); continue; }
        if (i >= 0) m.params[i] = { ...m.params[i], ...p };
        else if (workflow && workflow[p.node]) m.params.push({ type: 'text', default: workflow[p.node].inputs?.[p.input], label: p.input, ...p, key: `${p.node}.${p.input}` });
      }
    }
    m.ready = !!workflow && m.problems.length === 0;
    list.push(m);
  }
  modules = list.sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));
  return modules;
}

export const getModules = () => modules;
export const getModule = (id: string) => { refreshModulesIfChanged(); return modules.find((m) => m.id === id); };

/** 화면용: 워크플로우 원본은 빼고, select 옵션은 ComfyUI에서 채워서 */
/** 모델 파일 이름 → 모델 계열 (LoRA 호환 판단용) */
export const FAMILIES: [string, RegExp, string][] = [
  ['minimax', /minimax/i, 'MiniMax H3'],
  ['ideogram', /ideogram/i, 'Ideogram 4'],
  ['krea', /krea/i, 'Krea 2'],
  ['qwen', /qwen/i, 'Qwen Image'],
  ['ltx', /ltx/i, 'LTX'],
  ['wan', /wan2|wan_|\bwan/i, 'Wan'],
  ['flux', /flux/i, 'Flux'],
  ['zimage', /z[-_]?image/i, 'Z-Image'],
  ['hunyuan', /hunyuan/i, 'HunyuanVideo'],
  ['sdxl', /sdxl|xl_/i, 'SDXL'],
];
export const familyOf = (name?: string) => (name ? FAMILIES.find(([, re]) => re.test(name))?.[0] ?? null : null);

/** LoRA가 실제로 들어가는 모델 (기존 LoRA 노드면 그 모델 입력을 따라가서 로더를 찾음) */
export function loraTarget(m: ModuleDef) {
  const wf = m.workflow;
  if (!wf || m.lora.mode === 'none') return null;
  let id: string | undefined = m.lora.node;
  for (let i = 0; i < 6 && id && wf[id]; i++) {
    const n: any = wf[id];
    const file = n.inputs?.unet_name || n.inputs?.ckpt_name;
    if (typeof file === 'string') {
      const fam = familyOf(file);
      const label = FAMILIES.find(([f]) => f === fam)?.[2] ?? file.replace(/\.(safetensors|gguf)$/, '');
      // 여러 모델이 섞인 모듈이면 어느 단계에 들어가는지도 표시 (Elements: 키프레임)
      const stage = m.category === 'video' && fam && !['ltx', 'wan', 'hunyuan'].includes(fam) ? '키프레임 이미지 단계' : '';
      return { file, family: fam, label, stage };
    }
    const link: any = n.inputs?.model;
    id = Array.isArray(link) ? String(link[0]) : undefined;
  }
  return null;
}

export async function publicModules(comfy: Comfy) {
  refreshModulesIfChanged();
  const out = [];
  for (const m of modules) {
    const params = [];
    for (const p of m.params) {
      let options = p.options;
      if (p.type === 'select' && !options && m.workflow) {
        options = (await comfy.inputOptions(m.workflow[p.node].class_type, p.input).catch(() => null)) ?? undefined;
      }
      params.push({ ...p, options });
    }
    const { workflow, ...rest } = m;
    // 워크플로우 안에 이미 LoRA 노드가 있으면 그 LoRA·강도를 기본값으로
    const ln = m.lora.mode === 'existing' && workflow ? workflow[m.lora.node]?.inputs : null;
    const loraDefault = ln && typeof ln.lora_name === 'string' ? { name: ln.lora_name, strength: typeof ln.strength_model === 'number' ? ln.strength_model : 0.8 } : null;
    // 워크플로우에 스위치로 들어 있는 내장 LoRA(속도·스타일용) 파일 — 자동 선택에서 제외
    const builtinLoras = workflow ? Object.values<any>(workflow).filter((n) => /^LoraLoader/.test(n.class_type) && typeof n.inputs?.lora_name === 'string' && !(m.lora.mode === 'existing' && workflow[m.lora.node] === n)).map((n) => n.inputs.lora_name) : [];
    out.push({ ...rest, params, loraTarget: loraTarget(m), loraDefault, builtinLoras });
  }
  return out;
}

export interface ApplyOptions {
  prompt: string;
  prompt2?: string;
  negative?: string;
  seed: number;
  width?: number;
  height?: number;
  lora?: { name: string; strength: number } | null;
  images?: (string | null)[];
  params?: Record<string, any>;
}

/** 모듈 워크플로우 사본에 이번 실행 값을 넣어 ComfyUI로 보낼 형태로 만듭니다 */
export function applyToWorkflow(m: ModuleDef, opts: ApplyOptions): ApiWorkflow {
  if (!m.workflow) throw new Error('워크플로우가 없는 모듈이에요');
  const wf: ApiWorkflow = structuredClone(m.workflow);
  const setText = (b: Binding | undefined, text: string, ph: string) => {
    if (!b || !wf[b.node]) return;
    const cur = wf[b.node].inputs[b.input];
    wf[b.node].inputs[b.input] = typeof cur === 'string' && cur.includes(ph) ? cur.replaceAll(ph, text) : text;
  };
  setText(m.prompt, opts.prompt, 'PROMPT_HERE');
  if (m.prompt2 && opts.prompt2?.trim()) setText(m.prompt2, opts.prompt2, 'PROMPT2_HERE');
  if (m.negative) setText(m.negative, opts.negative ?? '', 'NEGATIVE_HERE');
  for (const s of m.seeds) if (wf[s.node]) wf[s.node].inputs[s.input] = m.seedMax ? opts.seed % m.seedMax : opts.seed;
  if (m.size && wf[m.size.node] && opts.width && opts.height) {
    wf[m.size.node].inputs.width = opts.width;
    wf[m.size.node].inputs.height = opts.height;
    // 크기 노드가 스위치의 한쪽 가지면 그쪽을 켬 (Qwen Edit: 꺼져 있으면 참조 이미지 크기를 따라가서 요청 해상도가 무시됨)
    for (const n of Object.values<any>(wf)) {
      if (!/Switch/i.test(n.class_type) || typeof n.inputs?.switch !== 'boolean') continue;
      const hit = (k: string) => isLink(n.inputs[k]) && String(n.inputs[k][0]) === m.size!.node;
      if (hit('on_true')) n.inputs.switch = true;
      else if (hit('on_false')) n.inputs.switch = false;
    }
  }
  m.images.forEach((b, i) => {
    const img = opts.images?.[i];
    if (!wf[b.node]) return;
    if (img) { wf[b.node].inputs[b.input] = img; return; }
    if (i === 0 || m.images.length < 2) return; // 첫 칸은 필수
    delete wf[b.node];
    for (const n of Object.values(wf)) for (const [k, v] of Object.entries(n.inputs ?? {})) if (isLink(v) && String(v[0]) === b.node) delete n.inputs[k];
  });
  for (const [key, val] of Object.entries(opts.params ?? {})) {
    // 노드 id에는 점이 없고, 입력 이름에는 점이 있을 수 있음 (API 노드: model.size, model.duration)
    const dot = key.indexOf('.');
    const node = key.slice(0, dot), input = key.slice(dot + 1);
    if (wf[node] && val !== undefined && val !== null && val !== '') wf[node].inputs[input] = val;
  }

  // 유료 API 노드의 크기 제한 (예: GPT Image 2 = 16의 배수, 긴 변 ≤3840, 65만~829만 화소)
  const c = m.clamp;
  if (c && wf[c.node] && typeof wf[c.node].inputs[c.w] === 'number' && typeof wf[c.node].inputs[c.h] === 'number') {
    let w = wf[c.node].inputs[c.w], h = wf[c.node].inputs[c.h];
    const mult = c.mult ?? 16;
    if (c.maxEdge && Math.max(w, h) > c.maxEdge) { const k = c.maxEdge / Math.max(w, h); w *= k; h *= k; }
    if (c.maxPx && w * h > c.maxPx) { const k = Math.sqrt(c.maxPx / (w * h)); w *= k; h *= k; }
    if (c.minPx && w * h < c.minPx) { const k = Math.sqrt(c.minPx / (w * h)); w *= k; h *= k; }
    const fl = (x: number) => Math.max(mult, Math.floor(x / mult) * mult), ce = (x: number) => Math.ceil(x / mult) * mult;
    let W = fl(w), H = fl(h);
    if (c.minPx && W * H < c.minPx) { W = ce(w); H = ce(h); }
    wf[c.node].inputs[c.w] = W; wf[c.node].inputs[c.h] = H;
  }

  // LoRA
  const rewire = (from: [string, number], to: [string, number], skip?: string) => {
    for (const [id, n] of Object.entries(wf)) {
      if (id === skip) continue;
      for (const [k, v] of Object.entries(n.inputs ?? {})) if (isLink(v) && String(v[0]) === from[0] && v[1] === from[1]) n.inputs[k] = [...to];
    }
  };
  if (m.lora.mode === 'existing' && wf[m.lora.node]) {
    const L = wf[m.lora.node];
    if (opts.lora?.name) {
      L.inputs.lora_name = opts.lora.name;
      L.inputs.strength_model = opts.lora.strength;
      if ('strength_clip' in L.inputs) L.inputs.strength_clip = opts.lora.strength;
    } else if (isLink(L.inputs.model)) {
      // LoRA 사용 안 함 → 노드를 건너뛰도록 연결을 이어 붙임 (CLIP 출력이 있는 LoraLoader는 강도 0으로)
      if (L.class_type === 'LoraLoaderModelOnly') { rewire([m.lora.node, 0], L.inputs.model, m.lora.node); delete wf[m.lora.node]; }
      else { L.inputs.strength_model = 0; if ('strength_clip' in L.inputs) L.inputs.strength_clip = 0; }
    }
  } else if (m.lora.mode === 'inject' && opts.lora?.name && wf[m.lora.node]) {
    const id = 'autoqc_lora';
    rewire([m.lora.node, m.lora.output], [id, 0]);
    wf[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: [m.lora.node, m.lora.output], lora_name: opts.lora.name, strength_model: opts.lora.strength },
      _meta: { title: 'AutoQC LoRA' },
    };
  }

  // 스위치로 꺼 둔 내장 LoRA 가지는 떼어 냄: ComfyUI는 꺼진 가지의 노드도 검사해서,
  // 그 LoRA 파일이 없으면 (예: krea2_darkbrush) 실행 전에 "Value not in list"로 실패함
  const boolOf = (v: any): boolean | undefined => {
    if (typeof v === 'boolean') return v;
    if (isLink(v)) { const p = wf[String(v[0])]; if (typeof p?.inputs?.value === 'boolean') return p.inputs.value; }
    return undefined;
  };
  for (const n of Object.values<any>(wf)) {
    if (!/Switch/i.test(n.class_type)) continue;
    const on = boolOf(n.inputs?.switch);
    if (on === undefined) continue;
    const off = on ? 'on_false' : 'on_true', live = on ? 'on_true' : 'on_false';
    const v = n.inputs[off];
    if (!isLink(v) || !isLink(n.inputs[live]) || !LORA_NODE.test(wf[String(v[0])]?.class_type ?? '')) continue;
    const loraId = String(v[0]);
    n.inputs[off] = [...n.inputs[live]];
    const stillUsed = Object.values<any>(wf).some((x) => Object.values<any>(x.inputs ?? {}).some((y) => isLink(y) && String(y[0]) === loraId));
    if (!stillUsed) delete wf[loraId];
  }
  return wf;
}

/** ComfyUI 최근 실행(/history)에서 모듈 만들기 — Export (API) 없이 "한 번 돌린 것"을 그대로 가져옴 */
/** LLM 노드(Deno 등) 제거: 프롬프트로 연결된 칸은 PROMPT_HERE로, 이미지가 지나가던 연결은 앞 노드로 이어 붙임 */
export function stripLlmNodes(wf: ApiWorkflow): { removed: string[]; unresolved: string[]; promptSet: boolean } {
  const llm = new Set(Object.keys(wf).filter((id) => LLM_NODE.test(wf[id].class_type)));
  const removed = [...llm].map((id) => wf[id].class_type);
  const unresolved: string[] = [];
  let promptSet = false;
  if (!llm.size) return { removed, unresolved, promptSet };
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [id, n] of Object.entries(wf)) {
      if (llm.has(id)) continue;
      for (const [k, v] of Object.entries(n.inputs ?? {})) {
        if (!isLink(v) || !llm.has(String(v[0]))) continue;
        const L = wf[String(v[0])];
        if (TEXT_INPUTS.includes(k) || /text|prompt/i.test(k)) {
          n.inputs[k] = promptSet ? '' : 'PROMPT_HERE';
          promptSet = true; changed = true;
          continue;
        }
        const through = Object.entries(L.inputs ?? {}).find(([lk, lv]) => isLink(lv) && (lk === k || /image/i.test(lk)));
        if (through) { n.inputs[k] = [...(through[1] as any[])]; changed = true; }
        else unresolved.push(`${n._meta?.title ?? n.class_type}.${k}`);
      }
    }
    if (!changed) break;
  }
  const stillUsed = (lid: string) => Object.entries(wf).some(([id, n]) => !llm.has(id) && Object.values(n.inputs ?? {}).some((v) => isLink(v) && String(v[0]) === lid));
  for (const id of llm) if (!stillUsed(id)) delete wf[id];
  return { removed, unresolved, promptSet };
}

export function workflowFromHistory(entry: any): { workflow: ApiWorkflow; originalPrompt: string | null; stripped: string[] } {
  const wf: ApiWorkflow = structuredClone(entry?.prompt?.[2] ?? {});
  if (!Object.keys(wf).length) throw new Error('이 실행 기록에서 워크플로우를 찾지 못했어요');
  const llmTexts = Object.values(wf).filter((n) => LLM_NODE.test(n.class_type)).flatMap((n) => Object.entries(n.inputs ?? {}).filter(([k, v]) => typeof v === 'string' && v.length > 8 && !/system|instruction|criteria/i.test(k)).map(([, v]) => v)) as string[];
  const s = stripLlmNodes(wf);
  if (s.promptSet) return { workflow: wf, originalPrompt: llmTexts.sort((a, b) => b.length - a.length)[0] ?? null, stripped: s.removed };
  // 인코더에서 거슬러 올라가 실제로 쓰이는 프롬프트 칸을 찾고, 못 찾으면 가장 긴 텍스트
  const traced = findPromptInput(wf);
  let best: { id: string; k: string; v: string } | null = traced ? { id: traced.node, k: traced.input, v: traced.value } : null;
  if (!best) for (const [id, n] of Object.entries(wf)) {
    if (!/Encode|Prompt|CLIPText|TextEncode/i.test(n.class_type) && !(isEncoderLike(wf, id) && typeof n.inputs?.prompt === 'string')) continue;
    if (/neg/i.test(n._meta?.title ?? '')) continue;
    for (const k of TEXT_INPUTS) {
      const v = n.inputs?.[k];
      if (typeof v === 'string' && (!best || v.length > best.v.length)) best = { id, k, v };
    }
  }
  if (best) wf[best.id].inputs[best.k] = 'PROMPT_HERE';
  return { workflow: wf, originalPrompt: best?.v ?? null, stripped: s.removed };
}

/** 워크플로우에 쓰인 모델 파일들 (.safetensors / .gguf / .ckpt) */
export function modelFiles(wf: ApiWorkflow) {
  const out = new Set<string>();
  for (const n of Object.values<any>(wf ?? {})) for (const v of Object.values<any>(n.inputs ?? {})) if (typeof v === 'string' && /\.(safetensors|gguf|ckpt|pt|pth|sft)$/i.test(v)) out.add(v);
  return [...out];
}

/** 모델/노드 구성으로 모듈 ID·이름·종류를 추천 (가져오기 기본값) */
export function suggestModule(wf: ApiWorkflow) {
  const nodes = Object.values<any>(wf ?? {});
  const classes = nodes.map((n) => String(n.class_type));
  const files = modelFiles(wf).join(' ').toLowerCase();
  const loadImages = classes.filter((c) => /^LoadImage/.test(c)).length;
  const isVideo = classes.some((c) => /SaveVideo|VHS_VideoCombine|SaveAnimated|SaveWEBM|CreateVideo|LTXV|WanImageToVideo|Wan22|HunyuanVideo/i.test(c));
  const ltx = /ltx/.test(files) || classes.some((c) => /^LTXV/.test(c));
  const qwen = /qwen/.test(files) || classes.some((c) => /Qwen/i.test(c));
  const wan = /wan2/.test(files) || classes.some((c) => /^Wan/.test(c));
  const flux = /flux/.test(files);
  const zimage = /z[-_]?image/.test(files);
  const ver = (files.match(/ltx-?(2[.-]?\d)/)?.[1] ?? '2.5').replace('-', '.');
  const v = ver.replace('.', '');
  if (ltx && qwen && loadImages >= 2) return { id: 'elements_video', name: `Elements → 영상 (Qwen 키프레임 + LTX-${ver})`, category: 'video', isVideo: true, loadImages, family: 'elements' };
  if (ltx && loadImages >= 2) return { id: `ltx${v}_flf2v`, name: `LTX-${ver} · 첫/끝 프레임→영상`, category: 'video', isVideo: true, loadImages, family: 'ltx' };
  if (ltx && loadImages === 1) return { id: `ltx${v}_i2v`, name: `LTX-${ver} · 이미지→영상`, category: 'video', isVideo: true, loadImages, family: 'ltx' };
  if (ltx) return { id: `ltx${v}_t2v`, name: `LTX-${ver} · 텍스트→영상`, category: 'video', isVideo: true, loadImages, family: 'ltx' };
  if (wan && isVideo) return { id: loadImages ? 'wan_i2v' : 'wan_t2v', name: loadImages ? 'Wan · 이미지→영상' : 'Wan · 텍스트→영상', category: 'video', isVideo: true, loadImages, family: 'wan' };
  if (isVideo) return { id: loadImages ? 'video_i2v' : 'video_t2v', name: loadImages ? '이미지→영상' : '텍스트→영상', category: 'video', isVideo: true, loadImages, family: 'video' };
  if (qwen) return loadImages ? { id: 'qwen_edit', name: 'Qwen Image 2.1 · 레퍼런스 편집', category: 'edit', isVideo: false, loadImages, family: 'qwen' } : { id: 'qwen_t2i', name: 'Qwen Image 2.1 · 텍스트→이미지', category: 'image', isVideo: false, loadImages, family: 'qwen' };
  const fam = flux ? 'flux' : zimage ? 'zimage' : 'image';
  const label = flux ? 'Flux' : zimage ? 'Z-Image' : '이미지';
  return loadImages ? { id: `${fam}_edit`, name: `${label} · 레퍼런스 편집`, category: 'edit', isVideo: false, loadImages, family: fam } : { id: `${fam}_t2i`, name: `${label} · 텍스트→이미지`, category: 'image', isVideo: false, loadImages, family: fam };
}

/** 이미 있는 모듈 폴더의 워크플로우가 다른 모델이면 그 정보 (덮어쓰기 경고용) */
export function existingConflict(id: string, wf: ApiWorkflow) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const file = path.join(MODULES_DIR, safe, 'workflow.json');
  if (!fs.existsSync(file)) return null;
  try {
    const old = readJson(file);
    if (isUiFormat(old)) return null;
    const a = modelFiles(old).sort().join('|'), b = modelFiles(wf).sort().join('|');
    if (a === b) return null;
    let name = safe;
    try { name = readJson(path.join(MODULES_DIR, safe, 'manifest.json')).name || safe; } catch { /* */ }
    return { id: safe, name, models: modelFiles(old) };
  } catch { return null; }
}

export function summarizeHistory(entry: any) {
  const wf = entry?.prompt?.[2] ?? {};
  const classes = Object.values<any>(wf).map((n) => n.class_type);
  let text = '';
  for (const n of Object.values<any>(wf)) for (const k of TEXT_INPUTS) if (typeof n.inputs?.[k] === 'string' && n.inputs[k].length > text.length) text = n.inputs[k];
  const loaders = Object.values<any>(wf).filter((n) => MODEL_LOADER.test(n.class_type)).map((n) => n.inputs?.unet_name || n.inputs?.ckpt_name).filter(Boolean);
  const start = (entry?.status?.messages ?? []).find((m: any) => m[0] === 'execution_start')?.[1]?.timestamp ?? null;
  const suggest = suggestModule(wf);
  return {
    nodeCount: classes.length,
    models: loaders.length ? loaders : modelFiles(wf).slice(0, 1),
    hasLLM: classes.some((c) => LLM_NODE.test(c)),
    hasLoadImage: classes.some((c) => /^LoadImage/.test(c)),
    loadImages: suggest.loadImages,
    isVideo: suggest.isVideo,
    suggest,
    conflict: existingConflict(suggest.id, wf),
    text: text.slice(0, 160),
    time: start,
    ok: entry?.status?.status_str !== 'error',
  };
}

export function writeModule(id: string, workflow: ApiWorkflow, manifest: Record<string, any>, merge = true) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'module';
  const dir = path.join(MODULES_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8');
  const mf = path.join(dir, 'manifest.json');
  let prev: any = {};
  if (merge) try { prev = readJson(mf); } catch { /* */ }
  fs.writeFileSync(mf, JSON.stringify({ ...prev, ...manifest }, null, 2), 'utf8');
  return safe;
}


/** 1단계: 영상 출력 노드를 빼서 키프레임까지만 실행 */
export function keyframeOnly(wf: ApiWorkflow, kf: NonNullable<ModuleDef['keyframe']>): ApiWorkflow {
  const out = structuredClone(wf);
  for (const id of kf.videoOutputs) delete out[id];
  return out;
}

/** 2단계: 통과한 키프레임 파일을 LoadImage로 넣고 키프레임 생성부를 건너뜀 (영상 부분만 실행) */
export function videoFromKeyframe(wf: ApiWorkflow, kf: NonNullable<ModuleDef['keyframe']>, uploadedName: string): ApiWorkflow {
  const out = structuredClone(wf);
  const kfId = 'autoqc_keyframe';
  out[kfId] = { class_type: 'LoadImage', inputs: { image: uploadedName }, _meta: { title: 'AutoQC 통과 키프레임' } } as any;
  delete out[kf.save];
  for (const n of Object.values<any>(out)) {
    for (const [k, v] of Object.entries<any>(n.inputs ?? {})) {
      if (isLink(v) && String(v[0]) === kf.source[0] && Number(v[1]) === kf.source[1]) n.inputs[k] = [kfId, 0];
    }
  }
  return out;
}

// ── 배치 모드용: 비율·해상도·길이 → 이 모듈의 노드 값 ─────────────────────
const RATIO_NUM: Record<string, number> = { '1:1': 1, '4:5': 0.8, '3:4': 0.75, '4:3': 4 / 3, '9:16': 9 / 16, '16:9': 16 / 9, '2:3': 2 / 3, '3:2': 1.5, '21:9': 21 / 9 };
const RS_OPTION: Record<string, string> = { '1:1': '1:1 (Square)', '2:3': '2:3 (Portrait Photo)', '3:2': '3:2 (Photo)', '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)', '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '21:9': '21:9 (Ultrawide)' };

/** 해상도 단계 선택지(480p/720p/1080p…) 파라미터 */
export const tierParam = (m: ModuleDef) => m.params.find((p) => /(^|\.)resolution$/.test(p.input) && p.options?.some((o) => /^\d{3,4}p$/i.test(o)));
/** 비율 선택지(16:9, 9:16, adaptive…) 파라미터 */
export const ratioParam = (m: ModuleDef) => m.params.find((p) => /(^|\.)ratio$/.test(p.input) && p.options?.some((o) => /^\d+:\d+$/.test(o)));
/** 긴 변 픽셀 → 가장 가까운 단계 (480p≈854, 720p≈1280, 1080p≈1920). 4k는 비용이 커서 4K를 고를 때만 */
export function pickTier(opts: string[], longSide: number) {
  const want = longSide <= 960 ? '480p' : longSide <= 1400 ? '720p' : longSide < 3840 ? '1080p' : '4k';
  return opts.includes(want) ? want : opts.find((o) => /p$/.test(o)) ?? opts[0];
}

/** 화면의 "비율 + 해상도(긴 변) + 길이" 선택을 모듈 노드 값으로 바꿈 (Generate 화면과 같은 규칙) */
export function sizeAndDuration(m: ModuleDef, ratio: string, longSide: number, durationSec?: number) {
  const last = (p: ParamDef) => p.label.split('·').pop()!.trim();
  const rsAspect = m.params.find((p) => p.key.endsWith('.aspect_ratio'));
  const rsMp = m.params.find((p) => p.key.endsWith('.megapixels'));
  const pW = m.params.find((p) => /^width$/i.test(last(p)));
  const pH = m.params.find((p) => /^height$/i.test(last(p)));
  let r = ratio;
  if (rsAspect && !RS_OPTION[r]) r = (RATIO_NUM[r] ?? 1) < 1 ? '3:4' : '4:3'; // 4:5 등 미지원 비율은 가까운 것으로
  const num = RATIO_NUM[r] ?? 1;
  const mult = m.category === 'video' || rsMp ? 32 : 16;
  const sn = (x: number) => Math.max(mult * 8, Math.round(x / mult) * mult);
  const w = num >= 1 ? sn(longSide) : sn(longSide * num);
  const h = num >= 1 ? sn(longSide / num) : sn(longSide);
  const params: Record<string, any> = {};
  if (rsAspect) params[rsAspect.key] = RS_OPTION[r];
  if (rsMp) params[rsMp.key] = Math.min(16, Math.max(0.1, Math.round((w * h) / 1e4) / 100));
  if (pW && pH) { params[pW.key] = w; params[pH.key] = h; }
  // 유료 영상 API(Seedance 등): 해상도·비율이 선택지로만 있음
  const tier = tierParam(m), rp = ratioParam(m);
  if (tier) params[tier.key] = pickTier(tier.options!, longSide);
  if (rp) params[rp.key] = rp.options!.includes(ratio) ? ratio : rp.options!.includes('adaptive') ? 'adaptive' : rp.default;
  if (durationSec && m.category === 'video') {
    const dur = m.params.find((p) => /^(float\s*\(|int\s*\()?\s*(duration|길이|seconds?)\s*\)?$/i.test(last(p)));
    if (dur) { let v = dur.type === 'int' ? Math.round(durationSec) : durationSec; if (dur.min != null) v = Math.max(dur.min, v); if (dur.max != null) v = Math.min(dur.max, v); params[dur.key] = v; }
    else {
      const frames = m.params.find((p) => p.label === '프레임 수');
      const fpsP = m.params.find((p) => /^(frame ?rate|fps)/i.test(last(p)) || p.label === 'FPS');
      const fps = Number(fpsP?.default) || 24;
      if (frames) params[frames.key] = Math.round(durationSec * fps) + 1;
    }
  }
  return { width: m.size ? w : undefined, height: m.size ? h : undefined, params, ratio: r };
}
