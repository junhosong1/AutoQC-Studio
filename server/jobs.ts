// 작업 큐 + 생성 → 검수 → 재생성 루프 (Self-Healing)
//
// 한 장(item)마다:
//   [프롬프트 확장] → [LLM 내림] → [ComfyUI 생성] → [규칙 검수] → [ComfyUI 내림] → [LLM 검수]
//   ├ 통과  → _passed 폴더로 분류, 끝
//   └ 실패  → 사유 기록 후 재시도
//        · off_brief / brand_tone / text_artifact → 검수 사유를 넣어 프롬프트 재작성 + 새 시드
//        · 그 외(인체 파손, 제품 변형, 저품질, 구도) → 같은 프롬프트, 새 시드
//   최대 시도 횟수를 넘기면 점수가 가장 높은 컷을 _failed 폴더로 (사유 포함)
import { getBalance } from './credits.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, getSettings, outputRoot } from './config.js';
import { Comfy } from './comfy.js';
import { ModuleDef, applyToWorkflow, getModule, keyframeOnly, videoFromKeyframe } from './modules.js';
import { DEFECT_CODES, PROMPT_DEFECTS, enhanceMotionPrompt, enhancePrompt, reviewImage, unloadLlm } from './llm.js';
import { decode, precheck, toJpeg } from './qc.js';
import { frameStrip, isVideoFile, posterJpeg } from './video.js';

export type AttemptStatus = 'prompting' | 'generating' | 'reviewing' | 'passed' | 'failed' | 'done' | 'unchecked' | 'error' | 'canceled';

export interface Attempt {
  n: number;
  seed: number;
  prompt: string;
  negative: string;
  promptSource: 'llm' | 'llm-retry' | 'user' | 'preview';
  status: AttemptStatus;
  progress: number;
  file?: string;
  width?: number;
  height?: number;
  kind?: 'image' | 'video';
  poster?: string;
  duration?: number;
  fps?: number;
  hasAudio?: boolean;
  score?: number;
  defects?: string[];
  reason?: string;
  stage?: 'rule' | 'llm' | 'keyframe';
  retryStrategy?: 'prompt+seed' | 'seed' | 'prompt+seed+res';
  /** 키프레임 → 영상 2단계 모듈: 지금 단계와 키프레임 파일 */
  phase?: 'keyframe' | 'video';
  keyframe?: string;
  keyframeScore?: number;
  error?: string;
  times: { prompt?: number; gen?: number; qc?: number; swap?: number };
  motionPrompt?: string;
}

export interface Item {
  index: number;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'done' | 'unchecked' | 'error' | 'canceled';
  attempts: Attempt[];
  final?: number; // attempts 인덱스
  sortedFile?: string;
  human?: 'accept' | 'reject';
  totalSec?: number;
}

export interface JobRequest {
  moduleId: string;
  /** 배치 모드에서 만든 작업이면 그 정보 */
  batch?: { id: string; name: string; product: string; step: string; p: number; s: number };
  /** 영상: 라벨·로고 보존 모드 (첫 프레임 완전 고정 + 입력 압축 ↓ + 제품 회전 금지 모션) */
  labelSafe?: boolean;
  /** 요청한 탭: image(이미지 생성) / video(영상 생성) — 모듈 종류와 다르면 거절 */
  kind?: 'image' | 'video';
  brief: string;
  toneId?: string;
  enhance: boolean;
  initialPrompt?: string;
  /** 두 번째 프롬프트 (영상 움직임·카메라) */
  motion?: string;
  negative?: string;
  count: number;
  width?: number;
  height?: number;
  seedMode: 'random' | 'fixed';
  seed?: number;
  lora?: { name: string; strength: number } | null;
  images?: (string | null)[];
  params?: Record<string, any>;
  qc: { enabled: boolean; passScore: number; maxAttempts: number };
}

export interface Job extends JobRequest {
  id: string;
  createdAt: number;
  finishedAt?: number;
  moduleName: string;
  toneText: string;
  toneLabel: string;
  llmBackend: string;
  llmModel: string;
  status: 'queued' | 'running' | 'done' | 'canceled' | 'error';
  items: Item[];
  error?: string;
  cancel?: boolean;
  /** 유료 모듈: 작업 전후 Comfy 크레딧 잔액과 실제 차감량 */
  credits?: { before?: number; after?: number; spent?: number };
}

const HISTORY = path.join(DATA_DIR, 'history.jsonl');
const jobs: Job[] = [];
const listeners = new Set<(j: Job) => void>();
let running = false;
let comfyRef: Comfy | null = null;
let lastBroadcast = 0;

export function onJobUpdate(fn: (j: Job) => void) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(j: Job, force = true) {
  const now = Date.now();
  if (!force && now - lastBroadcast < 200) return;
  lastBroadcast = now;
  const { cancel, ...pub } = j;
  for (const l of listeners) l(pub as Job);
}

export function loadHistory() {
  if (!fs.existsSync(HISTORY)) return;
  const lines = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(-1000)) {
    try { jobs.push(JSON.parse(line)); } catch { /* 손상된 줄 무시 */ }
  }
}

function persistAll() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const done = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
  fs.writeFileSync(HISTORY, done.map((j) => { const { cancel, ...x } = j; return JSON.stringify(x); }).join('\n') + (done.length ? '\n' : ''), 'utf8');
}
function appendHistory(j: Job) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { cancel, ...x } = j;
  fs.appendFileSync(HISTORY, JSON.stringify(x) + '\n', 'utf8');
}

export const listJobs = () => jobs.slice().reverse().map(({ cancel, ...j }) => j);
export const getJob = (id: string) => jobs.find((j) => j.id === id);

// 작업을 만든 순간의 모듈을 고정 (작업 도중 모듈 파일이 바뀌어도 그 작업은 원래 워크플로우로)
const jobModules = new Map<string, ModuleDef>();
const moduleOf = (job: Job) => jobModules.get(job.id) ?? getModule(job.moduleId);

export function createJob(req: JobRequest, comfy: Comfy): Job {
  const m = getModule(req.moduleId);
  if (!m) throw new Error('모듈을 찾을 수 없어요: ' + req.moduleId);
  if (!m.ready) throw new Error(`"${m.name}" 모듈이 아직 준비되지 않았어요: ${m.problems[0] ?? ''}`);
  const isVid = m.category === 'video';
  if (req.kind === 'image' && isVid) throw new Error(`"${m.name}"은(는) 영상 모듈이에요. [영상 생성] 탭에서 사용해 주세요.`);
  if (req.kind === 'video' && !isVid) throw new Error(`"${m.name}"은(는) 이미지 모듈이에요. [이미지 생성] 탭에서 사용해 주세요.`);
  if (!req.brief?.trim() && !req.initialPrompt?.trim()) throw new Error('프롬프트를 입력해 주세요');
  const s = getSettings();
  const tone = s.tones.find((t) => t.id === req.toneId);
  const count = Math.max(1, Math.min(16, Math.round(req.count || 1)));
  const job: Job = {
    ...req,
    count,
    qc: {
      enabled: !!req.qc?.enabled,
      passScore: Math.max(1, Math.min(10, req.qc?.passScore ?? s.qc.passScore)),
      maxAttempts: Math.max(1, Math.min(6, req.qc?.maxAttempts ?? s.qc.maxAttempts)),
    },
    id: new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + randomUUID().slice(0, 6),
    createdAt: Date.now(),
    moduleName: m.name,
    toneText: tone?.text ?? '',
    toneLabel: tone?.label ?? '',
    llmBackend: s.llm.backend,
    llmModel: s.llm.backend === 'claude' ? s.llm.claudeModel : s.llm.lmstudioModel,
    status: 'queued',
    items: Array.from({ length: count }, (_, i) => ({ index: i, status: 'queued', attempts: [] })),
  };
  jobs.push(job);
  jobModules.set(job.id, structuredClone(m));
  comfyRef = comfy;
  emit(job);
  void pump();
  return job;
}

export function cancelJob(id: string) {
  const j = getJob(id);
  if (!j) return;
  j.cancel = true;
  if (j.status === 'queued') { j.status = 'canceled'; j.items.forEach((it) => (it.status = 'canceled')); appendHistory(j); emit(j); }
  else if (j.status === 'running') comfyRef?.interrupt();
}

/** 끝난(또는 취소된) 작업을 기록과 결과 파일까지 함께 삭제 */
const delListeners = new Set<(id: string) => void>();
export function onJobDelete(fn: (id: string) => void) { delListeners.add(fn); return () => delListeners.delete(fn); }
export function deleteJob(id: string) {
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) throw new Error('작업을 찾을 수 없어요');
  const j = jobs[i];
  if (j.status === 'running' || j.status === 'queued') throw new Error('진행 중인 작업은 먼저 취소해 주세요');
  const root = path.resolve(outputRoot());
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const it of j.items) {
    for (const a of it.attempts) for (const f of [a.file, a.poster, a.keyframe]) if (f) { files.add(f); dirs.add(path.dirname(f)); }
    if (it.sortedFile) { files.add(it.sortedFile); files.add(it.sortedFile.replace(/\.[^.]+$/, '.txt')); }
  }
  let removed = 0;
  for (const rel of files) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) continue; // 출력 폴더 밖은 절대 건드리지 않음
    try { fs.unlinkSync(abs); removed++; } catch { /* 이미 없음 */ }
  }
  // 이 작업 전용 폴더(날짜/작업ID)가 비었으면 정리
  for (const rel of dirs) {
    const abs = path.resolve(root, rel);
    if (abs.startsWith(root + path.sep) && path.basename(abs) === j.id) { try { fs.rmSync(abs, { recursive: true, force: true }); } catch { /* */ } }
  }
  jobs.splice(i, 1);
  jobModules.delete(id);
  persistAll();
  for (const l of delListeners) l(id);
  return { removed };
}

export function setHuman(jobId: string, index: number, value: 'accept' | 'reject' | null) {
  const j = getJob(jobId);
  const it = j?.items[index];
  if (!j || !it) throw new Error('항목을 찾을 수 없어요');
  if (value) it.human = value; else delete it.human;
  persistAll();
  emit(j);
  return it;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    let next: Job | undefined;
    while ((next = jobs.find((j) => j.status === 'queued'))) await runJob(next);
  } finally {
    running = false;
  }
}

const sec = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;
const randSeed = () => Math.floor(Math.random() * 2 ** 48);
const day = () => new Date().toLocaleDateString('sv-SE');

async function runJob(job: Job) {
  const comfy = comfyRef!;
  const m = moduleOf(job);
  job.status = 'running';
  const paid = m?.cost === 'paid' && !!getSettings().comfyApiKey;
  if (paid) { const b = await getBalance(true); if (b.credits !== undefined) job.credits = { before: b.credits }; }
  emit(job);
  try {
    if (!m?.workflow) throw new Error('모듈 워크플로우를 찾을 수 없어요');
    const relDir = path.join(day(), job.id);
    fs.mkdirSync(path.join(outputRoot(), relDir), { recursive: true });
    for (const item of job.items) {
      if (job.cancel) { item.status = 'canceled'; continue; }
      await runItem(job, item, comfy, relDir);
      emit(job);
    }
    job.status = job.cancel ? 'canceled' : 'done';
  } catch (e: any) {
    job.status = 'error';
    job.error = e.message;
    job.items.forEach((it) => { if (it.status === 'queued' || it.status === 'running') it.status = 'error'; });
  }
  job.finishedAt = Date.now();
  if (paid && job.credits?.before !== undefined) {
    await new Promise((r) => setTimeout(r, 3000)); // 청구 반영 대기
    const b = await getBalance(true);
    if (b.credits !== undefined) job.credits = { ...job.credits, after: b.credits, spent: Math.max(0, job.credits.before! - b.credits) };
  }
  appendHistory(job);
  emit(job);
}

async function runItem(job: Job, item: Item, comfy: Comfy, relDir: string) {
  const s = getSettings();
  const m = moduleOf(job)!;
  const t0 = Date.now();
  item.status = 'running';
  const maxAttempts = job.qc.enabled ? job.qc.maxAttempts : 1;
  const hasRefs = (job.images ?? []).some(Boolean);
  let prompt = job.initialPrompt?.trim() || (job.enhance ? '' : job.brief.trim());
  let negative = job.negative ?? '';
  let promptSource: Attempt['promptSource'] = job.initialPrompt?.trim() ? 'preview' : 'user';
  let feedback = '';
  let needPrompt = job.enhance && !prompt;
  let llmLoaded = false;
  let motion = job.motion?.trim() ?? '';
  let needMotion = !!(m.prompt2 && motion && job.enhance && !/^use the provided start image/i.test(motion));
  // 참조 이미지 번호별 설명 (LLM이 image 1/2/3을 정확히 가리키도록)
  const refLabels = (job.images ?? []).map((x, i) => (x ? (m.images[i]?.label ?? `참조 ${i + 1}`).replace(/^@Element\s*\d+\s*·?\s*/, '') || '참조 이미지' : null)).filter((x): x is string => x !== null)
    .map((l) => (/^(제품|인물|배경\/공간|스타일|\d+)$/.test(l) ? `${l} (default slot role — the brief decides)` : l));
  // 라벨 글자 결함 재시도 때 키프레임 해상도를 조금씩 올림
  let sizeBoost = 1;
  // 키프레임은 통과했는데 영상에서 실패한 경우 → 키프레임은 그대로 두고 영상만 다시 (시간 절약)
  let keptKf: { name: string; file: string; score?: number } | null = null;
  const kfDim = (v?: number) => (v && sizeBoost !== 1 ? Math.round((v * sizeBoost) / 16) * 16 : v);

  for (let n = 1; n <= maxAttempts; n++) {
    if (job.cancel) { item.status = 'canceled'; return; }
    const seed = job.seedMode === 'fixed' && n === 1 && job.seed !== undefined ? job.seed : randSeed();
    const a: Attempt = { n, seed, prompt, negative, promptSource, status: 'prompting', progress: 0, times: {} };
    item.attempts.push(a);
    emit(job);

    // 1) 프롬프트 확장 (첫 시도, 또는 프롬프트성 결함으로 실패한 뒤)
    if (needPrompt) {
      const tp = Date.now();
      try {
        if (s.vramSaver) await comfy.free();
        // 이미지→영상(시작 프레임이 이미 있음) 모듈은 장면 묘사가 아니라 "움직임" 프롬프트로 확장
        const isVid = m.category === 'video';
        const motionOnly = isVid && m.images.length > 0 && !m.prompt2 && !m.keyframe && m.promptStyle !== 'ref-video';
        const r = motionOnly
          ? { positive: await enhanceMotionPrompt(job.brief + (feedback ? `\nREVIEWER FEEDBACK ON PREVIOUS CLIP: ${feedback}` : ''), job.toneText, !!job.labelSafe, m.refToken), negative: '' }
          // 영상(텍스트→영상, 레퍼런스→영상)은 영상용 프롬프트, Elements 키프레임·이미지 모듈은 이미지용
          : await enhancePrompt(job.brief, job.toneText, feedback, hasRefs ? refLabels : false, { video: isVid && !m.keyframe, refToken: m.refToken });
        prompt = r.positive;
        if (!job.negative) negative = r.negative;
        promptSource = feedback ? 'llm-retry' : 'llm';
        llmLoaded = true;
      } catch (e: any) {
        if (!prompt) { prompt = [job.brief, job.toneText].filter(Boolean).join(', '); promptSource = 'user'; }
        console.warn('[prompt] LLM 확장 실패:', e.message);
        a.reason = 'LLM 프롬프트 확장 실패 — 입력 문장을 그대로 사용했어요';
      }
      a.times.prompt = sec(tp);
      a.prompt = prompt; a.negative = negative; a.promptSource = promptSource;
      needPrompt = false;
    }

    // 1-2) 영상 움직임 프롬프트 (한 번만)
    if (needMotion) {
      const tp = Date.now();
      try { motion = await enhanceMotionPrompt(motion, job.toneText, !!job.labelSafe); llmLoaded = true; }
      catch (e: any) { a.reason = (a.reason ? a.reason + ' / ' : '') + '모션 프롬프트 확장 실패 — 입력 그대로 사용'; }
      a.times.prompt = (a.times.prompt ?? 0) + sec(tp);
      needMotion = false;
    }
    if (m.prompt2 && motion && job.labelSafe && !/label stays/i.test(motion)) motion = motion.replace(/\s*No text, no black frame\.?\s*$/i, '') + ' The product stays upright and faces the camera the whole time; its label and logo stay sharp, flat and unchanged; no product rotation or flipping. No black frame.';
    if (m.prompt2 && motion) a.motionPrompt = motion;
    if (!m.prompt2 && job.labelSafe && m.category === 'video' && m.images.length > 0 && prompt && !/label stays/i.test(prompt)) { prompt = prompt.replace(/\s*No text, no black frame\.?\s*$/i, '') + ' The product stays upright and faces the camera the whole time; its label and logo stay sharp, flat and unchanged; no product rotation or flipping. No black frame.'; a.prompt = prompt; }

    // 2) 생성
    if (job.cancel) { a.status = 'canceled'; item.status = 'canceled'; return; }
    a.status = 'generating';
    emit(job);
    try {
      if (s.vramSaver) { const ts = Date.now(); await unloadLlm(); llmLoaded = false; a.times.swap = sec(ts); }
      const tg = Date.now();
      let wf = applyToWorkflow(m, {
        prompt, prompt2: motion, negative, seed, width: kfDim(job.width), height: kfDim(job.height),
        lora: job.lora, images: job.images, params: job.params,
      });
      if (job.labelSafe) applyLabelSafe(wf);
      // 2-0) 키프레임 → 영상 모듈: 키프레임(약 1분)을 먼저 만들고 검수, 통과해야 영상(약 3~5분)으로
      let kfFailed = false;
      if (m.keyframe && job.qc.enabled && keptKf) {
        Object.assign(a, { keyframe: keptKf.file, keyframeScore: keptKf.score, phase: 'video' });
        wf = videoFromKeyframe(wf, m.keyframe, keptKf.name);
      } else if (m.keyframe && job.qc.enabled) {
        a.phase = 'keyframe'; emit(job);
        const p1 = await comfy.queue(keyframeOnly(wf, m.keyframe));
        const e1 = await comfy.wait(p1, (p) => { a.progress = p; emit(job, false); }, 20 * 60 * 1000, () => !!job.cancel);
        const r1 = comfy.outputImages(e1)[0];
        if (!r1) throw new Error('키프레임 이미지가 나오지 않았어요');
        const kbuf = await comfy.fetchImage(r1);
        const krel = path.join(relDir, `${String(item.index + 1).padStart(2, '0')}_try${n}_keyframe.png`);
        fs.writeFileSync(path.join(outputRoot(), krel), kbuf);
        a.keyframe = krel.split(path.sep).join('/');
        a.times.gen = sec(tg);
        a.status = 'reviewing'; emit(job);
        const tk = Date.now();
        const kimg = decode(kbuf);
        const kpre = precheck(kimg, undefined, undefined, s.qc.minStd);
        if (!kpre.passed) {
          kfFailed = true;
          Object.assign(a, { status: 'failed', score: 0, defects: kpre.defects, reason: '[키프레임] ' + kpre.reason, stage: 'keyframe' });
        } else {
          try {
            if (s.vramSaver) await comfy.free();
            const r = await reviewImage(toJpeg(kimg!), job.brief || prompt, job.toneText, prompt, false, hasRefs);
            llmLoaded = true;
            if (r.score >= job.qc.passScore && r.defects.length === 0) a.keyframeScore = r.score;
            else { kfFailed = true; Object.assign(a, { status: 'failed', score: r.score, defects: r.defects, reason: '[키프레임] ' + r.reason, stage: 'keyframe' }); }
          } catch (e: any) { a.reason = '키프레임 LLM 검수 실패 — 영상 단계로 진행'; }
        }
        a.times.qc = sec(tk);
        if (kfFailed) {
          Object.assign(a, { file: a.keyframe, kind: 'image', width: kimg?.width, height: kimg?.height, progress: 1 });
        } else {
          // 통과한 키프레임을 ComfyUI 입력으로 올리고 영상 부분만 실행
          const name = await comfy.upload(kbuf, `autoqc_kf_${job.id.slice(0, 8)}_${item.index + 1}_${n}.png`);
          wf = videoFromKeyframe(wf, m.keyframe, name);
          keptKf = { name, file: a.keyframe!, score: a.keyframeScore };
          a.phase = 'video'; a.status = 'generating'; a.progress = 0; emit(job);
          if (s.vramSaver) { const ts = Date.now(); await unloadLlm(); llmLoaded = false; a.times.swap = (a.times.swap ?? 0) + sec(ts); }
        }
      }
      if (!kfFailed) {
      const tv = Date.now();
      const pid = await comfy.queue(wf);
      const entry = await comfy.wait(pid, (p) => { a.progress = p; emit(job, false); }, (m.category === 'video' ? 60 : 15) * 60 * 1000, () => !!job.cancel);
      const refs = comfy.outputImages(entry);
      if (!refs.length) throw new Error('ComfyUI 결과에 이미지·영상이 없어요');
      const buf = await comfy.fetchImage(refs[0]);
      const ext = refs[0].filename.split('.').pop() || 'png';
      const rel = path.join(relDir, `${String(item.index + 1).padStart(2, '0')}_try${n}.${ext}`);
      fs.writeFileSync(path.join(outputRoot(), rel), buf);
      a.file = rel.split(path.sep).join('/');
      a.progress = 1;
      a.times.gen = (a.times.gen ?? 0) + sec(tv);
      const video = isVideoFile(refs[0].filename);
      a.kind = video ? 'video' : 'image';
      const img = video ? null : decode(buf);
      let strip: Buffer | null = null;
      let stripHasRef = false;
      if (video) {
        try {
          // 시작 프레임(키프레임 또는 넣어 준 참조 이미지)을 스트립 맨 앞에 붙여서, 검수가 "원본 대비" 라벨을 비교하게
          let refImg: ReturnType<typeof decode> = null;
          try {
            if (a.keyframe) refImg = decode(fs.readFileSync(path.join(outputRoot(), a.keyframe)));
            else if (m.images.length && job.images?.[0]) refImg = decode(await comfy.fetchImage({ filename: job.images[0], subfolder: '', type: 'input' }));
          } catch { refImg = null; }
          const fsr = await frameStrip(path.join(outputRoot(), rel), refImg);
          strip = fsr.jpeg;
          stripHasRef = fsr.withRef;
          Object.assign(a, { width: fsr.info.width, height: fsr.info.height, duration: fsr.info.duration ?? undefined, fps: fsr.info.fps, hasAudio: fsr.info.hasAudio });
          const posterRel = rel.replace(/\.[^.]+$/, '_poster.jpg');
          fs.writeFileSync(path.join(outputRoot(), posterRel), await posterJpeg(path.join(outputRoot(), rel)));
          a.poster = posterRel.split(path.sep).join('/');
        } catch (e: any) { a.reason = '프레임 추출 실패: ' + e.message; }
      } else { a.width = img?.width; a.height = img?.height; }

      if (!job.qc.enabled) { a.status = 'done'; item.final = n - 1; item.status = 'done'; break; }

      // 3) 규칙 검수
      a.status = 'reviewing';
      emit(job);
      const tq = Date.now();
      const pre = video
        ? (strip ? precheck(decode(strip), undefined, undefined, s.qc.minStd) : { passed: false, defects: [] as string[], reason: a.reason ?? '프레임 추출 실패', std: null })
        : precheck(img, m.size ? job.width ?? m.size.width : undefined, m.size ? job.height ?? m.size.height : undefined, s.qc.minStd);
      if (video && !strip) {
        Object.assign(a, { status: 'unchecked', stage: 'rule' });
        a.times.qc = sec(tq);
        item.final = n - 1; item.status = 'unchecked';
        break;
      }
      if (!pre.passed) {
        Object.assign(a, { status: 'failed', score: 0, defects: pre.defects, reason: pre.reason, stage: 'rule' });
      } else {
        // 4) LLM 검수
        try {
          if (s.vramSaver) await comfy.free();
          const r = await reviewImage(video ? strip! : toJpeg(img!), job.brief || prompt, job.toneText, prompt, video, hasRefs, video && stripHasRef);
          llmLoaded = true;
          const passed = r.score >= job.qc.passScore && r.defects.length === 0;
          Object.assign(a, { status: passed ? 'passed' : 'failed', score: r.score, defects: r.defects, reason: r.reason + ((pre as any).warn ? ` (참고: ${(pre as any).warn})` : ''), stage: 'llm' });
        } catch (e: any) {
          console.warn('[qc] LLM 검수 실패:', e.message);
          Object.assign(a, { status: 'unchecked', reason: 'LLM 검수 실패 — 검수 모델이 형식에 맞는 답을 주지 않았어요 (결과물은 정상 저장)', stage: 'llm' });
        }
      }
      a.times.qc = (a.times.qc ?? 0) + sec(tq);
      }
    } catch (e: any) {
      if (job.cancel) { a.status = 'canceled'; item.status = 'canceled'; return; }
      a.status = 'error';
      a.error = e.message;
      // ComfyUI 오류는 다시 해도 같을 가능성이 높아 이 장은 중단
      item.status = 'error';
      emit(job);
      throw e;
    }
    emit(job);

    const st = a.status as AttemptStatus;
    if (st === 'passed') { item.final = n - 1; item.status = 'passed'; break; }
    if (st === 'unchecked') { item.final = n - 1; item.status = 'unchecked'; break; }

    // 5) 실패 → 다음 시도 전략
    if (n < maxAttempts) {
      const promptFix = job.enhance && (a.defects ?? []).some((d) => PROMPT_DEFECTS.has(d));
      feedback = `${(a.defects ?? []).map((d) => `${d}(${DEFECT_CODES[d] ?? d})`).join(', ')} — ${a.reason ?? ''}`;
      // 참조 제품의 라벨 글자가 깨짐 → 시드만 바꿔선 안 고쳐짐: 제품을 더 크게·정면으로 + 키프레임 해상도 ↑
      const labelFix = hasRefs && (a.defects ?? []).includes('text_artifact');
      if (labelFix) {
        const longSide = Math.max(job.width ?? 0, job.height ?? 0);
        if (m.size && longSide) sizeBoost = Math.min(sizeBoost * 1.25, 2048 / longSide);
        feedback += ' | FIX: make the product larger in frame and facing the camera, label flat to camera, sharp and identical to the reference; no fingers over the label.';
      }
      a.retryStrategy = labelFix && job.enhance ? 'prompt+seed+res' : promptFix ? 'prompt+seed' : 'seed';
      // 키프레임 자체를 바꿔야 하는 결함(기획 불일치·톤·키프레임 단계 실패)이 아니면 통과한 키프레임 재사용
      if (a.stage === 'keyframe' || (a.defects ?? []).some((d) => d === 'off_brief' || d === 'brand_tone') || needPromptNext(a)) keptKf = null;
      needPrompt = promptFix || (labelFix && job.enhance);
      if (needPrompt && a.stage !== 'keyframe' && (a.defects ?? []).every((d) => d === 'text_artifact' || d === 'motion_artifact' || d === 'low_quality')) { /* 영상 단계의 글자·모션 문제는 키프레임 유지, 프롬프트도 그대로 */ needPrompt = false; }
      if (keptKf && m.keyframe && !needPrompt) a.retryStrategy = 'seed';
    }
  }

  if (item.status === 'running') {
    // 모든 시도 실패 → 가장 점수 높은 컷
    let best = 0;
    item.attempts.forEach((x, i) => { if ((x.score ?? -1) > (item.attempts[best].score ?? -1)) best = i; });
    item.final = best;
    item.status = 'failed';
  }
  item.totalSec = sec(t0);

  // 6) 폴더 자동 분류
  const fin = item.final !== undefined ? item.attempts[item.final] : undefined;
  if (fin?.file) {
    const bucket = { passed: '_passed', failed: '_failed', unchecked: '_unchecked', done: '_done' }[item.status as string];
    if (bucket) {
      const destRel = path.join(bucket, day(), `${job.id}_${String(item.index + 1).padStart(2, '0')}${path.extname(fin.file)}`);
      const dest = path.join(outputRoot(), destRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(outputRoot(), fin.file), dest);
      if (item.status === 'failed') {
        fs.writeFileSync(dest.replace(/\.[^.]+$/, '.txt'), item.attempts.map((x) => `시도 ${x.n} · 점수 ${x.score ?? '-'} · ${(x.defects ?? []).join(', ')} · ${x.reason ?? ''}`).join('\n'), 'utf8');
      }
      item.sortedFile = destRel.split(path.sep).join('/');
    }
  }
}

/** 라벨·로고 보존: 첫 프레임(및 끝 프레임 가이드)을 완전히 고정하고, 입력 이미지 압축을 낮춰 작은 글씨 디테일을 살림 */
function applyLabelSafe(wf: Record<string, any>) {
  for (const n of Object.values<any>(wf)) {
    if (n.class_type === 'LTXVImgToVideoInplace' && typeof n.inputs.strength === 'number') n.inputs.strength = 1;
    if (n.class_type === 'LTXVAddGuide' && typeof n.inputs.strength === 'number') n.inputs.strength = 1;
    if (n.class_type === 'LTXVPreprocess' && typeof n.inputs.img_compression === 'number') n.inputs.img_compression = Math.min(n.inputs.img_compression, 8);
  }
}

/** 키프레임을 새로 만들어야 하는지 (영상 단계 실패 중 키프레임 원인으로 볼 수 있는 결함) */
function needPromptNext(a: Attempt) {
  return a.stage !== 'keyframe' && (a.defects ?? []).includes('composition');
}

// ── 통계 ──────────────────────────────────────────────────
export function stats() {
  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'canceled' || j.status === 'error');
  const items = finished.flatMap((j) => j.items.map((it) => ({ j, it }))).filter(({ it }) => it.attempts.some((a) => a.file));
  const qcItems = items.filter(({ j }) => j.qc.enabled);
  const reviewed = qcItems.filter(({ it }) => it.status === 'passed' || it.status === 'failed');
  const firstPass = reviewed.filter(({ it }) => it.attempts[0]?.status === 'passed').length;
  const finalPass = reviewed.filter(({ it }) => it.status === 'passed').length;
  const allAttempts = items.flatMap(({ it }) => it.attempts).filter((a) => a.file);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  const defects: Record<string, number> = Object.fromEntries(Object.keys(DEFECT_CODES).map((k) => [k, 0]));
  let ruleFails = 0, llmFails = 0, promptRetries = 0, seedRetries = 0;
  for (const a of allAttempts) {
    if (a.status === 'failed') { a.stage === 'rule' ? ruleFails++ : llmFails++; for (const d of a.defects ?? []) defects[d] = (defects[d] ?? 0) + 1; }
    if (a.retryStrategy === 'prompt+seed') promptRetries++;
    if (a.retryStrategy === 'seed') seedRetries++;
  }
  // 사람 판정과 검수 판정 비교 (검수 신뢰도)
  const labeled = reviewed.filter(({ it }) => it.human);
  const agree = labeled.filter(({ it }) => (it.human === 'accept') === (it.status === 'passed')).length;
  const falsePass = labeled.filter(({ it }) => it.status === 'passed' && it.human === 'reject').length;
  const falseFail = labeled.filter(({ it }) => it.status === 'failed' && it.human === 'accept').length;

  const byModule: Record<string, { name: string; items: number; passed: number; avgSec: number | null }> = {};
  for (const { j, it } of items) {
    const b = (byModule[j.moduleId] ??= { name: j.moduleName, items: 0, passed: 0, avgSec: null });
    b.items++; if (it.status === 'passed') b.passed++;
  }
  for (const id of Object.keys(byModule)) byModule[id].avgSec = avg(items.filter(({ j }) => j.moduleId === id).map(({ it }) => it.totalSec ?? 0));

  return {
    jobs: finished.length,
    items: items.length,
    attempts: allAttempts.length,
    reviewedItems: reviewed.length,
    firstPassRate: reviewed.length ? firstPass / reviewed.length : null,
    finalPassRate: reviewed.length ? finalPass / reviewed.length : null,
    avgAttempts: avg(reviewed.map(({ it }) => it.attempts.length)),
    avgItemSec: avg(items.map(({ it }) => it.totalSec ?? 0)),
    avgGenSec: avg(allAttempts.map((a) => a.times.gen ?? 0).filter(Boolean)),
    avgQcSec: avg(allAttempts.map((a) => a.times.qc ?? 0).filter(Boolean)),
    avgPromptSec: avg(allAttempts.map((a) => a.times.prompt ?? 0).filter(Boolean)),
    avgSwapSec: avg(allAttempts.map((a) => a.times.swap ?? 0).filter(Boolean)),
    blocked: ruleFails + llmFails,
    ruleFails, llmFails, promptRetries, seedRetries,
    defects,
    human: { labeled: labeled.length, agree, falsePass, falseFail, agreement: labeled.length ? agree / labeled.length : null },
    byModule,
  };
}

export function reportMarkdown() {
  const s = stats();
  const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`);
  const lines = [
    `# AutoQC Studio 결과 리포트`,
    ``,
    `생성일: ${new Date().toLocaleString('ko-KR')}`,
    ``,
    `## 요약`,
    `| 항목 | 값 |`, `|---|---|`,
    `| 작업 수 | ${s.jobs} |`, `| 생성 컷(최종) | ${s.items} |`, `| 총 생성 시도 | ${s.attempts} |`,
    `| 첫 시도 통과율 | ${pct(s.firstPassRate)} |`, `| 최종 통과율 (재생성 포함) | ${pct(s.finalPassRate)} |`,
    `| 평균 시도 횟수 | ${s.avgAttempts ?? '-'} |`, `| 컷당 평균 소요 | ${s.avgItemSec ?? '-'}초 |`,
    `| 평균 생성 / 검수 / 프롬프트 | ${s.avgGenSec ?? '-'}초 / ${s.avgQcSec ?? '-'}초 / ${s.avgPromptSec ?? '-'}초 |`,
    `| 검수가 막은 불량 | ${s.blocked}건 (규칙 ${s.ruleFails} · LLM ${s.llmFails}) |`,
    `| 재시도 전략 | 프롬프트 재작성 ${s.promptRetries}회 · 시드 변경 ${s.seedRetries}회 |`,
    ``,
    `## 결함 유형`,
    `| 코드 | 설명 | 건수 |`, `|---|---|---|`,
    ...Object.entries(s.defects).map(([k, v]) => `| ${k} | ${DEFECT_CODES[k]} | ${v} |`),
    ``,
    `## 검수 신뢰도 (사람 판정 대비)`,
    `| 사람이 판정한 컷 | 일치율 | 잘못 통과 | 잘못 탈락 |`, `|---|---|---|---|`,
    `| ${s.human.labeled} | ${pct(s.human.agreement)} | ${s.human.falsePass} | ${s.human.falseFail} |`,
    ``,
    `## 모듈별`,
    `| 모듈 | 컷 | 통과 | 평균 소요 |`, `|---|---|---|---|`,
    ...Object.values(s.byModule).map((b) => `| ${b.name} | ${b.items} | ${b.passed} | ${b.avgSec ?? '-'}초 |`),
  ];
  return lines.join('\n') + '\n';
}
