// 상품 배치 모드 — 상품 여러 개 × 컷 구성(레시피)을 순서대로 생성·검수하고 상품별 폴더로 정리
//   - 각 컷은 일반 작업(Job)으로 만들어져 같은 큐·검수·재생성 로직을 그대로 사용
//   - "이전 컷에서 이어서"(예: 대표컷 → 숏폼 영상)는 앞 컷의 최종 결과를 ComfyUI 입력으로 올려 시작 이미지로 사용
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, outputRoot } from './config.js';
import { Comfy } from './comfy.js';
import { getModule, sizeAndDuration } from './modules.js';
import { cancelJob, createJob, getJob } from './jobs.js';
import { PRODUCT_EXT, normalizeProduct } from './productImage.js';

export interface BatchProduct { name: string; features: string; images: string[] }
export interface BatchStep {
  label: string; moduleId: string; brief: string; count: number;
  ratio: string; long: number; duration?: number;
  /** 'product' = 상품 사진을 참조로, 숫자 = 그 순번 컷의 결과를 시작 이미지로 */
  source: 'product' | number;
  motion?: string; labelSafe?: boolean; fast?: boolean; enhance?: boolean;
  lora?: { name: string; strength: number } | null;
}
export interface BatchCell {
  p: number; s: number; status: 'waiting' | 'running' | 'passed' | 'failed' | 'partial' | 'skipped' | 'error' | 'canceled'; jobId?: string; files: string[]; note?: string; sec?: number;
  /** 검수 실패 컷 중 최고점 (다음 컷이 이어받을 때 대안으로) */
  fallback?: string; fallbackScore?: number;
}
export interface Batch {
  id: string; name: string; createdAt: number; finishedAt?: number;
  products: BatchProduct[]; steps: BatchStep[];
  toneId?: string; qc: { enabled: boolean; passScore: number; maxAttempts: number };
  /** 앞 컷이 검수 실패했을 때: auto = 최고점 컷(통과 점수-2 이상)으로, 아니면 상품 사진으로 이어감 / skip = 건너뜀 */
  onPrevFail?: 'auto' | 'skip';
  status: 'queued' | 'running' | 'done' | 'canceled' | 'error' | 'interrupted';
  cells: BatchCell[]; outDir: string; error?: string; cancel?: boolean;
}

const FILE = path.join(DATA_DIR, 'batches.json');
const batches: Batch[] = [];
const listeners = new Set<(b: Batch) => void>();
export const onBatchUpdate = (fn: (b: Batch) => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const pub = (b: Batch) => { const { cancel, ...x } = b; return x; };
function emit(b: Batch) { for (const l of listeners) l(pub(b) as Batch); }
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(batches.map(pub), null, 1), 'utf8');
}
export function loadBatches() {
  try {
    for (const b of JSON.parse(fs.readFileSync(FILE, 'utf8'))) {
      if (b.status === 'running' || b.status === 'queued') { b.status = 'interrupted'; for (const c of b.cells) if (c.status === 'running' || c.status === 'waiting') c.status = 'canceled'; }
      batches.push(b);
    }
  } catch { /* 없음 */ }
}
export const listBatches = () => batches.slice().reverse().map(pub);

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || 'item';
// 템플릿 치환. 특징이 비어 있으면 "토너 — . 연출컷"처럼 남는 구두점을 정리
const fill = (t: string, p: BatchProduct) => t.replaceAll('{상품명}', p.name).replaceAll('{name}', p.name).replaceAll('{특징}', p.features || '').replaceAll('{features}', p.features || '')
  .replace(/\s*[—–-]\s*([.,])/g, '$1').replace(/\s*[—–-]\s*$/g, '').replace(/([.,])\s*\1/g, '$1').replace(/\s{2,}/g, ' ').trim();

const RECIPE = path.join(DATA_DIR, 'batch_recipe.json');
/** 마지막으로 쓴 컷 구성 (MCP·폴더 배치에서 컷 구성을 안 주면 이걸 사용) */
export function lastRecipe(): BatchStep[] | null { try { return JSON.parse(fs.readFileSync(RECIPE, 'utf8')); } catch { return null; } }

/** 컷 구성 기본값: 대표컷 1 + 연출컷 2 (레퍼런스 편집) + 숏폼 1 (대표컷에서 이어서) */
export function defaultRecipe(mods: { id: string; ready: boolean; category: string; images: unknown[] }[]): BatchStep[] {
  const ready = mods.filter((m) => m.ready);
  const edit = ready.find((m) => m.id === 'qwen_edit') ?? ready.find((m) => m.category === 'edit');
  const vid = ready.find((m) => m.id === 'ltx25_i2v') ?? ready.find((m) => m.id === 'minimax_h3_i2v') ?? ready.find((m) => m.category === 'video' && m.images.length === 1);
  const out: BatchStep[] = [];
  if (edit) {
    out.push({ label: '대표컷', moduleId: edit.id, brief: '{상품명} 상세페이지 대표컷. 순백 배경, 제품 정면, 부드러운 스튜디오 조명, 라벨과 로고가 선명하게', count: 1, ratio: '1:1', long: 1280, source: 'product' });
    out.push({ label: '연출컷', moduleId: edit.id, brief: '{상품명} — {특징}. 제품이 돋보이는 라이프스타일 연출컷, 자연광, 깔끔한 배경', count: 2, ratio: '4:5', long: 1280, source: 'product' });
  }
  if (vid && out.length) out.push({ label: '숏폼', moduleId: vid.id, brief: '제품은 정면을 향해 고정, 카메라가 천천히 다가가고 빛이 부드럽게 흐름', count: 1, ratio: '9:16', long: 960, duration: 5, source: 0, labelSafe: true });
  return out;
}

/** 폴더 안의 상품 사진으로 배치 시작 (MCP/Claude Code용). products.csv(파일명,상품명,특징)가 있으면 이름·특징 사용 */
/** 폴더·파일 목록·상품 목록으로 배치 시작 (MCP·외부 호출용)
 *  - folder: 폴더 안의 사진 전부 (products.csv/상품.csv 로 이름·특징)
 *  - files: 사진 경로 목록 (골라서 넣기)
 *  - products: [{ image, name, features }] 직접 지정
 *  steps 를 주면 그 컷 구성, 없으면 앱에서 마지막으로 쓴 구성 */
export async function createBatchFromFolder(body: any, comfy: Comfy, mods: any[]) {
  type Src = { file: string; name?: string; features?: string };
  let srcs: Src[] = [];
  const folder = body.folder ? String(body.folder) : '';
  if (Array.isArray(body.products) && body.products.length) {
    srcs = body.products.map((p: any) => ({ file: String(p.image ?? p.file ?? ''), name: p.name, features: p.features }));
  } else if (Array.isArray(body.files) && body.files.length) {
    srcs = body.files.map((f: any) => ({ file: String(f) }));
  } else {
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('폴더를 찾을 수 없어요: ' + folder);
    srcs = fs.readdirSync(folder).filter((f) => PRODUCT_EXT.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => ({ file: path.join(folder, f) }));
    if (!srcs.length) throw new Error('폴더에 상품 사진(png/jpg/webp/avif/heic)이 없어요');
  }
  for (const s of srcs) if (!s.file || !fs.existsSync(s.file) || !fs.statSync(s.file).isFile()) throw new Error('사진 파일을 찾을 수 없어요: ' + s.file);
  // products.csv: 폴더 배치면 그 폴더, 파일 목록이면 첫 파일의 폴더
  const meta = new Map<string, { name: string; features: string }>();
  const csvDir = folder || (srcs[0] ? path.dirname(srcs[0].file) : '');
  const csv = csvDir ? ['products.csv', '상품.csv'].map((f) => path.join(csvDir, f)).find((f) => fs.existsSync(f)) : undefined;
  if (csv) {
    for (const line of fs.readFileSync(csv, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/).slice(1)) {
      const c = line.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
      if (c[0]) meta.set(c[0].replace(/\.[^.]+$/, '').toLowerCase(), { name: c[1] || c[0], features: c.slice(2).join(', ') });
    }
  }
  const limit = Math.max(1, Math.min(200, Number(body.limit) || srcs.length));
  const products: BatchProduct[] = [];
  const notes: string[] = [];
  for (const s of srcs.slice(0, limit)) {
    const base = path.basename(s.file);
    const key = base.replace(/\.[^.]+$/, '');
    const n = await normalizeProduct(fs.readFileSync(s.file), base);
    if (n.changed.length) notes.push(`${base}: ${n.changed.join(', ')}`);
    const up = await comfy.upload(n.buf, `autoqc_prod_${Date.now()}_${n.name.replace(/[^\w.\-]/g, '_')}`);
    const mm = meta.get(key.toLowerCase());
    products.push({ name: s.name || mm?.name || key.replace(/[_-]+/g, ' '), features: s.features ?? mm?.features ?? '', images: [up] });
  }
  const steps = Array.isArray(body.steps) && body.steps.length ? body.steps : lastRecipe() ?? defaultRecipe(mods);
  const batch = createBatch({ name: body.name || (folder ? path.basename(folder) : '상품 배치'), products, steps, toneId: body.toneId, qc: body.qc, onPrevFail: body.onPrevFail }, comfy);
  return { batch, imageNotes: notes };
}

export function createBatch(body: any, comfy: Comfy): Batch {
  const products: BatchProduct[] = (body.products ?? []).filter((p: any) => p?.name?.trim() || p?.images?.length).map((p: any, i: number) => ({ name: String(p.name || `상품 ${i + 1}`).trim(), features: String(p.features ?? '').trim(), images: (p.images ?? []).filter(Boolean) }));
  const steps: BatchStep[] = (body.steps ?? []).filter((s: any) => s?.moduleId);
  if (!products.length) throw new Error('상품을 하나 이상 넣어 주세요');
  if (!steps.length) throw new Error('컷 구성을 하나 이상 넣어 주세요');
  steps.forEach((s, i) => {
    const m = getModule(s.moduleId);
    if (!m?.ready) throw new Error(`${i + 1}번 컷 "${s.label}": 모듈을 쓸 수 없어요 (${s.moduleId})`);
    if (typeof s.source === 'number' && (s.source < 0 || s.source >= i)) throw new Error(`${i + 1}번 컷은 앞에 있는 컷에서만 이어받을 수 있어요`);
    if (s.source === 'product' && m.images.length && products.some((p) => !p.images.length)) throw new Error(`"${s.label}"은(는) 상품 사진이 필요해요. 사진이 없는 상품이 있어요`);
  });
  const stamp = new Date().toLocaleString('sv-SE').slice(0, 16).replace(/[-:]/g, '').replace(' ', '_'); // 로컬 시각 20261011_1847
  const b: Batch = {
    id: randomUUID(), name: String(body.name || '상품 배치').trim(), createdAt: Date.now(), products, steps,
    toneId: body.toneId || undefined, qc: body.qc ?? { enabled: true, passScore: 7, maxAttempts: 3 },
    onPrevFail: body.onPrevFail === 'skip' ? 'skip' : 'auto',
    status: batches.some((x) => x.status === 'running' || x.status === 'queued') ? 'queued' : 'running', cells: products.flatMap((_, p) => steps.map((_, s) => ({ p, s, status: 'waiting' as const, files: [] }))),
    outDir: path.join('_batches', `${stamp}_${safeName(String(body.name || 'batch'))}`).split(path.sep).join('/'),
  };
  batches.push(b); save(); emit(b);
  try { fs.writeFileSync(RECIPE, JSON.stringify(steps, null, 1), 'utf8'); } catch { /* */ }
  // 배치는 한 번에 하나씩: 먼저 넣은 배치를 끝까지 돌린 뒤 다음 배치 시작
  runChain = runChain.then(() => run(b, comfy)).catch(() => { /* run 안에서 기록 */ });
  return pub(b) as Batch;
}

let runChain: Promise<void> = Promise.resolve();

export function cancelBatch(id: string) {
  const b = batches.find((x) => x.id === id);
  if (!b) return;
  if (b.status === 'queued') {
    b.cancel = true; b.status = 'canceled'; b.finishedAt = Date.now();
    for (const c of b.cells) if (c.status === 'waiting') c.status = 'canceled';
    emit(b); save(); return;
  }
  if (b.status !== 'running') return;
  b.cancel = true;
  const cur = b.cells.find((c) => c.status === 'running');
  if (cur?.jobId) cancelJob(cur.jobId);
}

async function waitJob(id: string, b: Batch) {
  for (;;) {
    const j = getJob(id);
    if (!j) throw new Error('작업이 사라졌어요');
    if (!['queued', 'running'].includes(j.status)) return j;
    if (b.cancel) cancelJob(id);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function run(b: Batch, comfy: Comfy) {
  if (b.status !== 'queued' && b.status !== 'running') return; // 대기 중 취소됨
  if (!batches.includes(b)) return;
  b.status = 'running'; emit(b); save();
  const root = outputRoot();
  try {
    for (let p = 0; p < b.products.length; p++) {
      const prod = b.products[p];
      const prodDir = path.join(b.outDir, `${String(p + 1).padStart(2, '0')}_${safeName(prod.name)}`);
      for (let s = 0; s < b.steps.length; s++) {
        const cell = b.cells.find((c) => c.p === p && c.s === s)!;
        if (b.cancel) { cell.status = 'canceled'; continue; }
        const step = b.steps[s];
        const m = getModule(step.moduleId)!;
        const t0 = Date.now();
        // 참조 이미지: 상품 사진 또는 앞 컷 결과
        let images: (string | null)[] = [];
        if (m.images.length) {
          if (step.source === 'product') images = m.images.map((_, i) => prod.images[i] ?? null);
          else {
            const prev = b.cells.find((c) => c.p === p && c.s === step.source);
            const n = Number(step.source) + 1;
            let src = prev?.files[0];
            let name: string | null = null;
            // 앞 컷이 검수에서 떨어졌을 때 (auto): 아깝게 떨어진 최고점 컷 → 없으면 상품 사진으로 이어감. 앞 컷이 오류·취소면 건너뜀
            if (!src && (b.onPrevFail ?? 'auto') === 'auto' && prev && (prev.status === 'failed' || prev.status === 'partial')) {
              if (prev.fallback && (prev.fallbackScore ?? 0) >= b.qc.passScore - 2) {
                src = prev.fallback;
                cell.note = `${n}번 컷이 검수 통과를 못 해서 최고점 컷(${prev.fallbackScore}점)으로 이어감`;
              } else if (prod.images[0]) {
                name = prod.images[0];
                cell.note = `${n}번 컷이 검수 통과를 못 해서 상품 사진으로 대신 진행`;
              }
            }
            if (!src && !name) { cell.status = 'skipped'; cell.note = `${n}번 컷 결과가 없어 건너뜀`; emit(b); save(); continue; }
            if (src) name = await comfy.upload(fs.readFileSync(path.join(root, src)), `autoqc_batch_${b.id.slice(0, 6)}_${p + 1}_${s + 1}${path.extname(src) || '.png'}`);
            // 첫/끝 프레임 모듈이면 끝 프레임도 같은 컷으로 → 시작과 끝 모두 라벨이 정확한 숏폼
            images = m.images.map((b, i) => (i === 0 || /last|끝/i.test(b.label) ? name : null));
          }
        }
        const sz = sizeAndDuration(m, step.ratio, step.long, step.duration);
        const params = { ...sz.params };
        if (step.fast !== undefined) { const fp = m.params.find((x) => x.type === 'bool' && /빠른 모드/.test(x.label)); if (fp) params[fp.key] = step.fast; }
        cell.status = 'running'; emit(b);
        const job = createJob({
          moduleId: m.id, kind: m.category === 'video' ? 'video' : 'image',
          brief: fill(step.brief, prod), enhance: step.enhance !== false,
          motion: m.prompt2 ? fill(step.motion ?? '', prod) : undefined,
          count: Math.max(1, Math.min(8, step.count || 1)), width: sz.width, height: sz.height,
          seedMode: 'random', lora: step.lora ?? null, images, params, labelSafe: step.labelSafe,
          toneId: b.toneId, qc: b.qc,
          batch: { id: b.id, name: b.name, product: prod.name, step: step.label, p, s },
        } as any, comfy);
        cell.jobId = job.id; emit(b); save();
        const done = await waitJob(job.id, b);
        // 상품 폴더로 정리 (통과 → 상품 폴더, 실패 → _검수실패)
        const files: string[] = [];
        let pass = 0;
        let best: { file: string; score: number } | null = null;
        done.items.forEach((it, k) => {
          const a = it.final !== undefined ? it.attempts[it.final] : undefined;
          if (!a?.file) return;
          const ok = it.status === 'passed' || it.status === 'done' || it.status === 'unchecked';
          if (it.status === 'passed') pass++;
          const destRel = path.join(prodDir, ok ? '' : '_검수실패', `${safeName(step.label)}_${k + 1}${path.extname(a.file)}`);
          fs.mkdirSync(path.dirname(path.join(root, destRel)), { recursive: true });
          fs.copyFileSync(path.join(root, a.file), path.join(root, destRel));
          if (ok) files.push(destRel.split(path.sep).join('/'));
          // 실패 컷 중 최고점 (이미지일 때만 다음 컷의 시작 이미지가 될 수 있음)
          else if (a.kind !== 'video' && (a.score ?? -1) > (best?.score ?? -1)) best = { file: destRel.split(path.sep).join('/'), score: a.score ?? 0 };
        });
        cell.files = files;
        if (!files.length && best) { cell.fallback = (best as any).file; cell.fallbackScore = (best as any).score; }
        cell.sec = Math.round((Date.now() - t0) / 1000);
        cell.status = done.status === 'canceled' ? 'canceled' : done.status === 'error' ? 'error' : !b.qc.enabled ? (files.length ? 'passed' : 'failed') : pass === done.items.length ? 'passed' : pass > 0 || files.length ? 'partial' : 'failed';
        if (done.status === 'error') cell.note = done.error;
        emit(b); save();
      }
    }
    b.status = b.cancel ? 'canceled' : 'done';
  } catch (e: any) {
    b.status = 'error'; b.error = e.message;
  }
  b.finishedAt = Date.now();
  writeSummary(b);
  emit(b); save();
}

function writeSummary(b: Batch) {
  try {
    const dir = path.join(outputRoot(), b.outDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '요약.csv'), '﻿' + reportCsv(b), 'utf8');
  } catch { /* */ }
}

export function reportCsv(b: Batch) {
  const rows = [['상품', '컷', '상태', '결과 수', '최고 점수', '시도 수', '소요(초)', '파일']];
  for (const c of b.cells) {
    const j = c.jobId ? getJob(c.jobId) : undefined;
    const scores = j?.items.flatMap((it) => it.attempts.map((a) => a.score ?? -1)) ?? [];
    const tries = j?.items.reduce((s, it) => s + it.attempts.length, 0) ?? 0;
    rows.push([b.products[c.p].name, b.steps[c.s].label, c.status, String(c.files.length), scores.length ? String(Math.max(...scores)) : '', String(tries), String(c.sec ?? ''), c.files.join(' | ')]);
  }
  return rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
}
export const getBatch = (id: string) => batches.find((b) => b.id === id);

/** 배치 삭제: 기록 + (선택) 결과 폴더와 그 배치가 만든 작업들까지 */
const delListeners = new Set<(id: string) => void>();
export const onBatchDelete = (fn: (id: string) => void) => { delListeners.add(fn); return () => delListeners.delete(fn); };
export function deleteBatch(id: string) {
  // 목록(UI)에서만 지움 — 결과 파일·상품 폴더·요약 CSV·작업 기록은 그대로 둠.
  // 다른 배치가 생성 중이어도 상관없이 바로 지워지도록 파일 작업을 하지 않음.
  const i = batches.findIndex((b) => b.id === id);
  if (i < 0) throw new Error('배치를 찾을 수 없어요');
  if (batches[i].status === 'running' || batches[i].status === 'queued') throw new Error('진행 중인 배치는 먼저 취소해 주세요');
  batches.splice(i, 1);
  try { save(); } catch (e) { console.error('[batch] 목록 저장 실패', e); }
  for (const l of delListeners) { try { l(id); } catch { /* */ } }
  return { ok: true };
}
