// AutoQC Studio 서버 — 웹 화면 + API
//   npm start     : 화면을 빌드한 뒤 http://localhost:5178 로 실행
//   npm run dev   : 개발 모드 (화면 코드 수정 시 바로 반영)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { ROOT, DATA_DIR, getSettings, outputRoot, publicSettings, saveSettings } from './config.js';
import { Comfy } from './comfy.js';
import { applyToWorkflow, loadModules, publicModules, summarizeHistory, workflowFromHistory, writeModule, getModules, getModule, suggestModule, existingConflict, sizeAndDuration } from './modules.js';
import { DEFECT_CODES, enhancePrompt, llmStatus } from './llm.js';
import { PRESETS, addDownload, allowedFolders, cancelDownload, listDownloads, onDownloadUpdate, probe } from './downloads.js';
import { modelsRoot } from './config.js';
import { normalizeProduct } from './productImage.js';
import { estimateUsd, getBalance, toCredits } from './credits.js';
import { cancelBatch, createBatch, createBatchFromFolder, defaultRecipe, lastRecipe, deleteBatch, onBatchDelete, getBatch, listBatches, loadBatches, onBatchUpdate, reportCsv } from './batch.js';
import { cancelJob, createJob, deleteJob, getJob, listJobs, loadHistory, onJobDelete, onJobUpdate, reportMarkdown, setHuman, stats } from './jobs.js';

// 예기치 못한 오류 하나로 서버 전체가 꺼지지 않도록: 기록만 남기고 계속 실행 (data/server.log)
function logCrash(kind: string, e: unknown) {
  const msg = `[${new Date().toLocaleString('ko-KR')}] ${kind}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`;
  console.error(msg);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(path.join(DATA_DIR, 'server.log'), msg, 'utf8'); } catch { /* */ }
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

const PORT = Number(process.env.PORT || 5178);
const DEV = process.argv.includes('--dev');
const NO_OPEN = process.argv.includes('--no-open') || !!process.env.NO_OPEN;

let comfy = new Comfy(getSettings().comfyUrl);
loadModules();
loadHistory();
loadBatches();

const app = express();
app.use(express.json({ limit: '60mb' }));

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<any>) => (req: express.Request, res: express.Response) =>
  fn(req, res).catch((e: any) => res.status(400).json({ error: e?.message ?? String(e) }));

// ── 상태 ──
app.get('/api/status', wrap(async (_req, res) => {
  let c: any;
  try {
    const st = await comfy.systemStats();
    const d = st?.devices?.[0] ?? {};
    c = { ok: true, gpu: String(d.name ?? '').replace(/^cuda:\d+\s*/, '').replace(/ : .*$/, ''), vramTotal: d.vram_total ?? null, vramFree: d.vram_free ?? null, version: st?.system?.comfyui_version ?? null };
  } catch (e: any) { c = { ok: false, error: e.message }; }
  res.json({ comfy: c, llm: await llmStatus(), url: getSettings().comfyUrl });
}));

// ── 설정 ──
app.get('/api/settings', (_req, res) => res.json({ settings: publicSettings(), defects: DEFECT_CODES }));
app.put('/api/settings', wrap(async (req, res) => {
  const s = saveSettings(req.body ?? {});
  comfy = new Comfy(s.comfyUrl);
  res.json({ settings: publicSettings() });
}));

// ── 모듈 ──
app.get('/api/modules', wrap(async (_req, res) => res.json({ modules: await publicModules(comfy) })));
app.post('/api/modules/reload', wrap(async (_req, res) => { comfy.clearInfoCache(); loadModules(); res.json({ modules: await publicModules(comfy) }); }));

app.get('/api/comfy/history', wrap(async (_req, res) => {
  const h = await comfy.history(40);
  const list = Object.entries<any>(h ?? {}).map(([id, e]) => {
    const img = comfy.outputImages(e)[0];
    return { id, ...summarizeHistory(e), thumb: img ? `/api/comfy/view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' })}` : null };
  }).sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  res.json({ items: list });
}));

app.get('/api/comfy/view', wrap(async (req, res) => {
  const q = { filename: String(req.query.filename ?? ''), subfolder: String(req.query.subfolder ?? ''), type: String(req.query.type ?? 'output') };
  const ext = q.filename.split('.').pop() || 'png';
  // 입력 이미지(상품 사진 등)는 이름이 고유하고 바뀌지 않음 → 디스크에 캐시해 ComfyUI가 무거운 모델을 돌리는 중에도 바로 표시
  const cacheable = q.type === 'input' && /^[\w.\-() ]+$/.test(q.filename) && !q.subfolder;
  const cfile = cacheable ? path.join(DATA_DIR, 'thumbcache', q.filename) : '';
  if (cfile && fs.existsSync(cfile)) { res.set('Cache-Control', 'public, max-age=604800, immutable').type(ext).sendFile(cfile); return; }
  const buf = await comfy.fetchImage(q);
  if (cfile) { try { fs.mkdirSync(path.dirname(cfile), { recursive: true }); fs.writeFileSync(cfile, buf); } catch { /* */ } }
  res.set('Cache-Control', cacheable ? 'public, max-age=604800, immutable' : 'no-cache').type(ext).send(buf);
}));

app.post('/api/modules/import', wrap(async (req, res) => {
  const { promptId, id, name, category, description, overwrite } = req.body ?? {};
  const h = await comfy.json('/history/' + promptId);
  const entry = h?.[promptId];
  if (!entry) throw new Error('이 실행 기록을 찾을 수 없어요 (ComfyUI를 재시작하면 기록이 사라져요)');
  const { workflow, originalPrompt, stripped } = workflowFromHistory(entry);
  const sug = suggestModule(entry.prompt?.[2] ?? {});
  const conflict = existingConflict(id || sug.id, workflow);
  if (conflict && !overwrite) {
    res.status(409).json({ error: `"${conflict.name}" (${conflict.id}) 모듈이 이미 있고, 다른 모델(${conflict.models[0] ?? '?'})을 쓰고 있어요. 다른 ID로 가져오거나 '덮어쓰기'를 체크해 주세요.`, conflict });
    return;
  }
  const saved = writeModule(id || sug.id, workflow, {
    name: name || sug.name, category: sug.isVideo ? 'video' : (category || sug.category), description: description || '',
    family: sug.family,
    importedFrom: { promptId, at: new Date().toISOString(), originalPrompt },
    notes: stripped.length ? [`가져올 때 LLM 노드 ${stripped.length}개를 뺐어요 (${[...new Set(stripped)].join(', ')}) — 프롬프트·검수는 앱이 담당`] : [],
  }, !conflict);
  loadModules();
  res.json({ id: saved, module: (await publicModules(comfy)).find((m) => m.id === saved) });
}));

app.get('/api/comfy/loras', wrap(async (_req, res) => res.json({ loras: await comfy.loras().catch(() => []) })));

app.post('/api/upload', wrap(async (req, res) => {
  const { name, data } = req.body ?? {};
  if (!data) throw new Error('이미지 데이터가 없어요');
  const buf = Buffer.from(String(data).replace(/^data:[^,]+,/, ''), 'base64');
  // product=true(상품 배치): AVIF 등 변환 + 투명 배경 흰색 + 회전 보정. 레퍼런스(Elements 등)는 투명도를 그대로 유지
  const n = req.body?.product ? await normalizeProduct(buf, String(name || 'product.png')) : { buf, name: String(name || 'ref.png') };
  const safe = 'autoqc_' + Date.now() + '_' + n.name.replace(/[^\w.\-]/g, '_');
  res.json({ name: await comfy.upload(n.buf, safe) });
}));

// 결과 이미지를 ComfyUI 입력으로 올리기 (이미지 → 영상 등 다음 단계로 보내기)
app.post('/api/upload-from-output', wrap(async (req, res) => {
  const rel = String(req.body?.file ?? '');
  const abs = path.resolve(outputRoot(), rel);
  if (!abs.startsWith(path.resolve(outputRoot())) || !fs.existsSync(abs)) throw new Error('파일을 찾을 수 없어요');
  res.json({ name: await comfy.upload(fs.readFileSync(abs), 'autoqc_' + Date.now() + '_' + path.basename(abs)) });
}));

// ── 모델 다운로드 ──
app.get('/api/downloads', (_req, res) => res.json({ downloads: listDownloads(), presets: PRESETS, folders: allowedFolders(), modelsDir: modelsRoot() }));
app.post('/api/downloads/probe', wrap(async (req, res) => {
  const urls: string[] = Array.isArray(req.body?.urls) ? req.body.urls : [req.body?.url];
  res.json({ results: await Promise.all(urls.map((u) => probe(String(u)))) });
}));
app.post('/api/downloads', wrap(async (req, res) => {
  const items: any[] = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const out = items.map((it) => addDownload(String(it.url), String(it.folder || 'loras'), it.label, it.filename));
  res.json({ downloads: out });
}));
app.post('/api/downloads/:id/cancel', (req, res) => { cancelDownload(req.params.id); res.json({ ok: true }); });

// ── 프롬프트 확장 미리보기 ──
app.post('/api/enhance', wrap(async (req, res) => {
  const { brief, toneId, hasRefs } = req.body ?? {};
  const tone = getSettings().tones.find((t) => t.id === toneId)?.text ?? '';
  const t0 = Date.now();
  const r = await enhancePrompt(String(brief ?? ''), tone, '', !!hasRefs);
  res.json({ ...r, sec: (Date.now() - t0) / 1000 });
}));

// ── 작업 ──
app.get('/api/jobs', (_req, res) => res.json({ jobs: listJobs() }));
app.post('/api/jobs', wrap(async (req, res) => res.json({ job: createJob(req.body, comfy) })));
// 상품 배치 모드
app.get('/api/batches', (_req, res) => res.json({ batches: listBatches() }));
app.post('/api/batches', wrap(async (req, res) => res.json({ batch: createBatch(req.body ?? {}, comfy) })));
// Comfy 크레딧 잔액 (유료 API 모델용)
app.get('/api/credits', wrap(async (req, res) => res.json(await getBalance(req.query.force === '1'))));
// 이 설정으로 1회 실행할 때 예상 차감량. body: { moduleId, params, width, height, images(개수), count }
app.post('/api/credits/estimate', wrap(async (req, res) => {
  const b = req.body ?? {};
  const m = getModule(String(b.moduleId ?? ''));
  if (!m?.workflow || m.cost !== 'paid') { res.json({ paid: false }); return; }
  const sz = b.ratio ? sizeAndDuration(m, String(b.ratio), Number(b.long) || 1280, b.duration ? Number(b.duration) : undefined) : null;
  const wf = applyToWorkflow(m, {
    prompt: 'x', seed: 1, width: b.width ?? sz?.width, height: b.height ?? sz?.height,
    images: Array.from({ length: Math.max(1, Number(b.images) || m.images.length) }, (_, i) => (i < (Number(b.images) || m.images.length) ? 'x.png' : null)),
    params: { ...(sz?.params ?? {}), ...(b.params ?? {}) },
  });
  const usd = estimateUsd(wf);
  const count = Math.max(1, Number(b.count) || 1);
  const per = usd === null ? null : toCredits(usd);
  res.json({ paid: true, perRun: per, perRunUsd: usd, count, total: per === null ? null : per * count });
}));
app.get('/api/batches/recipe', (_req, res) => res.json({ steps: lastRecipe() ?? defaultRecipe(getModules() as any) }));
app.post('/api/batches/from-folder', wrap(async (req, res) => res.json(await createBatchFromFolder(req.body ?? {}, comfy, getModules()))));
app.delete('/api/batches/:id', wrap(async (req, res) => res.json(deleteBatch(req.params.id))));
app.post('/api/batches/:id/cancel', (req, res) => { cancelBatch(req.params.id); res.json({ ok: true }); });
app.get('/api/batches/:id/report.csv', (req, res) => {
  const b = getBatch(req.params.id);
  if (!b) { res.status(404).json({ error: 'not found' }); return; }
  res.setHeader('Content-Disposition', `attachment; filename="batch-${b.id.slice(0, 8)}.csv"`);
  res.type('text/csv; charset=utf-8').send('\ufeff' + reportCsv(b));
});
// MCP/자동화용 간단 생성: 비율·해상도·길이만 주면 노드 값은 서버가 계산, 참조 이미지는 PC 파일 경로로
app.get('/api/paths', (_req, res) => res.json({ outputRoot: path.resolve(outputRoot()), modulesDir: path.resolve(ROOT, 'modules') }));
app.post('/api/generate-simple', wrap(async (req, res) => {
  const b = req.body ?? {};
  const m = getModule(String(b.moduleId ?? ''));
  if (!m) throw new Error('모듈을 찾을 수 없어요: ' + b.moduleId);
  const sz = sizeAndDuration(m, String(b.ratio || (m.category === 'video' ? '16:9' : '1:1')), Number(b.long) || (m.category === 'video' ? 960 : 1280), Number(b.duration) || undefined);
  const images: (string | null)[] = [];
  for (const [i, f] of (Array.isArray(b.images) ? b.images : []).entries()) {
    if (i >= m.images.length) break;
    if (!fs.existsSync(f)) throw new Error('참조 이미지 파일이 없어요: ' + f);
    images.push(await comfy.upload(fs.readFileSync(f), 'autoqc_mcp_' + Date.now() + '_' + path.basename(f).replace(/[^\w.\-]/g, '_')));
  }
  const job = createJob({
    moduleId: m.id, kind: m.category === 'video' ? 'video' : 'image', brief: String(b.brief ?? ''), enhance: b.enhance !== false,
    motion: m.prompt2 ? String(b.motion ?? '') : undefined, count: Math.max(1, Math.min(8, Number(b.count) || 1)),
    width: sz.width, height: sz.height, seedMode: 'random', lora: b.lora ?? null, images, params: sz.params,
    labelSafe: b.labelSafe, toneId: b.toneId, qc: b.qc ?? { enabled: true, passScore: getSettings().qc.passScore, maxAttempts: getSettings().qc.maxAttempts },
  } as any, comfy);
  res.json({ job });
}));
app.delete('/api/jobs/:id', wrap(async (req, res) => res.json(deleteJob(req.params.id))));
app.post('/api/jobs/:id/cancel', (req, res) => { cancelJob(req.params.id); res.json({ ok: true }); });
app.post('/api/jobs/:id/items/:i/human', wrap(async (req, res) => res.json({ item: setHuman(req.params.id, Number(req.params.i), req.body?.value ?? null) })));
app.get('/api/jobs/:id', (req, res) => { const j = getJob(req.params.id); j ? res.json({ job: j }) : res.status(404).json({ error: 'not found' }); });

app.get('/api/stats', (_req, res) => res.json(stats()));
app.get('/api/report.md', (_req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="autoqc-report-${new Date().toISOString().slice(0, 10)}.md"`);
  res.type('text/markdown; charset=utf-8').send(reportMarkdown());
});

// 실시간 업데이트 (Server-Sent Events)
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const off = onJobUpdate((j) => res.write(`event: job\ndata: ${JSON.stringify(j)}\n\n`));
  const offDel = onJobDelete((id) => res.write(`event: jobdel\ndata: ${JSON.stringify({ id })}\n\n`));
  const offD = onDownloadUpdate((d) => res.write(`event: download\ndata: ${JSON.stringify(d)}\n\n`));
  const offB = onBatchUpdate((b) => res.write(`event: batch\ndata: ${JSON.stringify(b)}\n\n`));
  const offBD = onBatchDelete((id) => res.write(`event: batchdel\ndata: ${JSON.stringify({ id })}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { off(); offD(); offDel(); offB(); offBD(); clearInterval(ping); });
});

// 결과 폴더 열기 (Windows 탐색기)
app.post('/api/open-folder', wrap(async (req, res) => {
  const rel = String(req.body?.path ?? '');
  const target = path.resolve(outputRoot(), rel);
  if (!target.startsWith(path.resolve(outputRoot()))) throw new Error('잘못된 경로');
  const dir = fs.existsSync(target) && fs.statSync(target).isFile() ? path.dirname(target) : target;
  fs.mkdirSync(dir, { recursive: true });
  const cmd = process.platform === 'win32' ? `explorer "${dir}"` : process.platform === 'darwin' ? `open "${dir}"` : `xdg-open "${dir}"`;
  exec(cmd);
  res.json({ ok: true, dir });
}));

app.use('/files', express.static(outputRoot(), { maxAge: '1h' }));

async function start() {
  if (DEV) {
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      console.error('화면 빌드가 없어요. "npm start"로 실행해 주세요 (빌드 후 자동 실행).');
      process.exit(1);
    }
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  const server = app.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    const ready = getModules().filter((m) => m.ready).length;
    console.log(`\n  AutoQC Studio  →  ${url}`);
    console.log(`  ComfyUI       →  ${getSettings().comfyUrl}`);
    console.log(`  모듈          →  ${getModules().length}개 (사용 가능 ${ready}개)`);
    console.log(`  결과 폴더     →  ${outputRoot()}\n`);
    if (!NO_OPEN && process.platform === 'win32') exec(`start "" "${url}"`);
  });
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  ${PORT} 포트를 이미 쓰고 있어요. AutoQC Studio가 이미 켜져 있을 수 있어요.`);
      console.error('  이전 검은 창을 닫거나 start.bat으로 다시 실행해 주세요 (이전 실행을 자동으로 정리해요).\n');
      process.exit(1);
    }
    throw e;
  });
}
start();
