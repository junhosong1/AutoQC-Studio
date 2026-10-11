// AutoQC Studio MCP 서버 — Claude Code / Claude Desktop이 AutoQC Studio를 직접 조작
//   예) "G:\상품사진\신상 폴더로 상품 배치 돌려줘", "qwen_edit로 이 사진 연출컷 2장 만들어줘"
// 동작: AutoQC Studio 서버(http://localhost:5178)가 켜져 있어야 함. 이 스크립트는 그 API를 MCP 도구로 감싸는 얇은 층.
// 등록 (Claude Code):  claude mcp add autoqc -- npx tsx "G:\AutoQC Studio\tools\mcp-server.ts"
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = (process.env.AUTOQC_URL || 'http://localhost:5178').replace(/\/+$/, '');

async function call(p: string, body?: any, method?: string) {
  let r: Response;
  try {
    r = await fetch(BASE + p, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`AutoQC Studio(${BASE})에 연결할 수 없어요. autoqc_start 도구로 앱을 켜세요. 서버를 셸/백그라운드 명령으로 직접 실행하지 마세요 — 그 작업이 끝나거나 중지되면 서버와 진행 중인 배치가 함께 꺼집니다.`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let outRoot = '';
async function abs(rel?: string) {
  if (!rel) return rel;
  if (!outRoot) outRoot = (await call('/api/paths')).outputRoot;
  return path.join(outRoot, rel);
}

/** 작업 결과를 사람이 읽기 좋은 형태로 */
async function summarizeJob(j: any) {
  const items = [];
  for (const it of j.items) {
    const a = it.final !== undefined ? it.attempts[it.final] : it.attempts[it.attempts.length - 1];
    items.push({
      index: it.index + 1, status: it.status, attempts: it.attempts.length,
      score: a?.score ?? null, defects: a?.defects ?? [], reason: a?.reason ?? '',
      file: await abs(it.sortedFile ?? a?.file), prompt: a?.prompt,
    });
  }
  return { job_id: j.id, module: j.moduleName, status: j.status, error: j.error, items };
}

const server = new McpServer({ name: 'autoqc-studio', version: '0.1.0' });

server.registerTool('autoqc_start', {
  title: 'AutoQC Studio 켜기',
  description: 'AutoQC Studio 앱(서버 + 브라우저 화면)을 켭니다. 이미 켜져 있으면 그대로 둡니다. start.bat을 독립된 새 창으로 실행하므로 이 세션이 끝나도 앱과 배치는 계속 돌아갑니다. 서버를 셸 명령(npm start, tsx 등)으로 직접 띄우지 말고 반드시 이 도구를 쓰세요. 첫 실행·업데이트 후에는 패키지 확인과 화면 빌드로 1~2분 걸릴 수 있습니다.',
  inputSchema: {},
}, async () => {
  const up = async () => { try { return (await fetch(BASE + '/api/status')).ok; } catch { return false; } };
  if (await up()) return text('AutoQC Studio가 이미 켜져 있어요. ' + BASE);
  if (process.platform !== 'win32') return text('Windows가 아니라서 start.bat을 실행할 수 없어요. 사용자에게 앱을 켜 달라고 요청하세요.');
  // cmd의 start로 새 콘솔 창을 띄움. 경로에 공백(G:\\AutoQC Studio)이 있으니 반드시 따옴표로 감쌈 (verbatim 인자) → 이 MCP 프로세스/세션과 분리되어 계속 실행
  const child = spawn('cmd.exe', ['/c', 'start', '"AutoQC Studio"', '/D', `"${APP_ROOT}"`, `"${path.join(APP_ROOT, 'start.bat')}"`], { cwd: APP_ROOT, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    await sleep(3000);
    if (await up()) return text(`AutoQC Studio를 켰어요 (${Math.round((Date.now() - t0) / 1000)}초). 새 창에서 서버가 돌고 브라우저에 ${BASE} 화면이 열려요.`);
  }
  return text('start.bat 창은 열었지만 3분 안에 서버가 응답하지 않았어요. 그 창의 오류 메시지를 사용자에게 확인해 달라고 요청하세요.');
});

server.registerTool('autoqc_status', {
  title: 'AutoQC 상태·모듈 목록',
  description: 'AutoQC Studio 연결 상태(ComfyUI, LLM)와 사용할 수 있는 생성 모듈 목록(id, 이미지/영상, 참조 이미지 칸 수)을 보여 줍니다. 생성 전에 module_id를 고를 때 먼저 호출하세요. 연결이 안 되면 autoqc_start로 앱을 켜세요 (셸 명령으로 서버를 직접 띄우지 말 것).',
  inputSchema: {},
}, async () => {
  const [st, mods, lr, cr] = await Promise.all([call('/api/status'), call('/api/modules'), call('/api/comfy/loras').catch(() => ({ loras: [] })), call('/api/credits').catch(() => null)]);
  return text({
    comfy: st.comfy, llm: st.llm, comfy_credits: cr?.configured ? (cr.error ?? cr.credits) : '유료 모델용 Comfy API 키 없음',
    modules: mods.modules.map((m: any) => ({ id: m.id, name: m.name, paid: m.cost === 'paid', kind: m.category === 'video' ? 'video' : 'image', ready: m.ready, reference_slots: m.images.length, has_motion_prompt: !!m.prompt2, lora_family: m.loraTarget ?? null, description: m.description, problems: m.problems })),
    loras: lr.loras,
  });
});

server.registerTool('autoqc_generate', {
  title: '이미지·영상 생성 (자동 검수·재생성 포함)',
  description: '모듈 하나로 이미지나 영상을 생성합니다. 기획 문장(한국어 가능)을 LLM이 프롬프트로 확장 → ComfyUI 생성 → Vision LLM 검수 → 실패 시 자동 재생성 → 통과/실패 폴더 분류까지 진행합니다. wait=true면 끝날 때까지 기다렸다가 결과 파일 경로·점수·검수 사유를 돌려줍니다.',
  inputSchema: {
    module_id: z.string().describe('autoqc_status의 모듈 id (예: qwen_t2i, qwen_edit, ltx25_i2v, elements_video, minimax_h3_r2v)'),
    brief: z.string().describe('만들고 싶은 장면 (한국어 가능)'),
    count: z.number().int().min(1).max(8).optional().describe('장수 (기본 1)'),
    ratio: z.enum(['1:1', '4:5', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9']).optional(),
    resolution: z.enum(['480p', '540p', '1K', '2K']).optional().describe('긴 변 기준. 영상은 540p/1K 권장 (RTX 3080)'),
    duration: z.number().min(1).max(15).optional().describe('영상 길이(초)'),
    motion: z.string().optional().describe('영상 움직임·카메라 (두 번째 프롬프트가 있는 모듈)'),
    reference_images: z.array(z.string()).optional().describe('참조 이미지의 PC 절대 경로 목록 (칸 순서대로 = image 1, 2 …)'),
    label_safe: z.boolean().optional().describe('영상: 라벨·로고 보존 모드'),
  lora: z.object({ name: z.string().describe('LoRA 파일명 (autoqc_status의 loras 목록, 예: qwen-image-2.1-fix-1.0-comfy.safetensors)'), strength: z.number().min(0).max(2).describe('강도 (보통 0.6~1.0)') }).optional().describe('이 생성에 적용할 LoRA. 모듈과 같은 계열(lora_family)이어야 효과가 있음'),

    qc: z.object({ enabled: z.boolean(), passScore: z.number(), maxAttempts: z.number() }).optional(),
    wait: z.boolean().optional().describe('끝날 때까지 기다릴지 (기본 true, 최대 30분)'),
  },
}, async (a) => {
  const LONG: Record<string, number> = { '480p': 832, '540p': 960, '1K': 1280, '2K': 2048 };
  const long = a.resolution ? LONG[a.resolution] : undefined;
  const { job } = await call('/api/generate-simple', {
    moduleId: a.module_id, brief: a.brief, count: a.count, ratio: a.ratio, long, duration: a.duration, motion: a.motion,
    images: a.reference_images, labelSafe: a.label_safe, qc: a.qc, lora: a.lora ?? null,
  });
  if (a.wait === false) return text({ job_id: job.id, status: job.status, note: 'autoqc_job으로 진행 상황을 확인하세요.' });
  const t0 = Date.now();
  for (;;) {
    await sleep(3000);
    const { job: j } = await call(`/api/jobs/${job.id}`);
    if (!['queued', 'running'].includes(j.status)) return text(await summarizeJob(j));
    if (Date.now() - t0 > 30 * 60 * 1000) return text({ job_id: job.id, status: j.status, note: '30분이 지나 기다리기를 멈췄어요. autoqc_job으로 이어서 확인하세요.' });
  }
});

server.registerTool('autoqc_job', {
  title: '작업 진행 상황·결과',
  description: '작업 id로 진행 상황과 결과(파일 경로, 점수, 결함, 검수 사유)를 확인합니다.',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => text(await summarizeJob((await call(`/api/jobs/${job_id}`)).job)));

const LONG_MAP: Record<string, number> = { '480p': 832, '540p': 960, '720p': 1280, '1K': 1280, '2K': 2048, '3K': 3072, '4K': 4096 };
const stepSchema = z.object({
  label: z.string().describe('컷 이름 (예: 대표컷, 연출컷, 숏폼)'),
  module_id: z.string().describe('autoqc_status의 모듈 id'),
  brief: z.string().describe('장면 설명. {상품명} {특징} 을 쓰면 상품마다 바뀜'),
  count: z.number().int().min(1).max(4).optional().describe('컷당 장수 (기본 1)'),
  ratio: z.enum(['1:1', '4:5', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9']).optional(),
  resolution: z.enum(['480p', '540p', '720p', '1K', '2K', '3K', '4K']).optional().describe('긴 변 기준 (영상은 480p~720p 권장)'),
  duration: z.number().min(1).max(15).optional().describe('영상 길이(초)'),
  source: z.union([z.literal('product'), z.number().int().min(1)]).optional().describe("'product' = 상품 사진을 참조(기본), 숫자 N = N번째 컷의 결과를 시작 이미지로"),
  motion: z.string().optional().describe('영상 움직임·카메라'),
  label_safe: z.boolean().optional().describe('영상: 라벨·로고 보존 (기본 켜짐)'),
  fast: z.boolean().optional().describe('빠른 모드(Lightning LoRA)가 있는 모듈에서 켜기'),
  lora: z.object({ name: z.string().describe('LoRA 파일명 (autoqc_status의 loras 목록, 예: qwen-image-2.1-fix-1.0-comfy.safetensors)'), strength: z.number().min(0).max(2).describe('강도 (보통 0.6~1.0)') }).optional().describe('이 컷에 적용할 LoRA. 모듈과 같은 계열(lora_family)이어야 효과가 있음'),
});

server.registerTool('autoqc_batch_recipe', {
  title: '현재 컷 구성 보기',
  description: '상품 배치에서 steps를 생략하면 쓰이는 컷 구성(앱에서 마지막으로 쓴 구성)을 보여 줍니다. 배치 전에 확인하고, 바꾸고 싶으면 autoqc_batch에 steps로 넘기세요.',
  inputSchema: {},
}, async () => text(await call('/api/batches/recipe')));

server.registerTool('autoqc_batch', {
  title: '상품 배치 생산',
  description: '상품 사진들로 배치를 시작합니다. 상품마다 컷 구성대로 생성 → 검수 → 재생성 → 상품별 폴더·요약 CSV 정리. 사진은 folder(폴더 전체, 파일명 순 — 숫자는 크기 순으로 정렬: 01, 1212, 12060, toner, 다운로드), files(넘긴 순서 그대로), products(이름·특징까지 지정) 중 하나로 넘깁니다. 특정 사진만 원하면 files로 정확히 지정하세요. AVIF/HEIC/TIFF는 PNG로 바꾸고, 투명 배경은 흰색으로 채우고, 휴대폰 사진 회전은 바로잡아서 넣습니다. steps를 생략하면 앱의 마지막 컷 구성(autoqc_batch_recipe로 확인)을 씁니다. 폴더나 첫 사진의 폴더에 products.csv(파일명,상품명,특징)가 있으면 이름·특징으로 씁니다.',
  inputSchema: {
    folder: z.string().optional().describe('상품 사진 폴더 절대 경로 (안의 사진 전부)'),
    files: z.array(z.string()).optional().describe('상품 사진 절대 경로 목록 (사진 1장 = 상품 1개)'),
    products: z.array(z.object({ image: z.string().describe('사진 절대 경로'), name: z.string().optional(), features: z.string().optional() })).optional().describe('상품명·특징까지 직접 지정'),
    steps: z.array(stepSchema).optional().describe('컷 구성 (생략하면 앱의 마지막 구성)'),
    name: z.string().optional().describe('배치 이름'),
    limit: z.number().int().min(1).max(200).optional().describe('앞에서부터 몇 개만'),
    tone_id: z.string().optional().describe('앱 설정의 브랜드 톤 id'),
    qc: z.object({ enabled: z.boolean(), passScore: z.number(), maxAttempts: z.number() }).optional(),
  },
}, async (a) => {
  if (!a.folder && !a.files?.length && !a.products?.length) throw new Error('folder, files, products 중 하나는 넣어 주세요');
  const steps = a.steps?.map((s) => ({
    label: s.label, moduleId: s.module_id, brief: s.brief, count: s.count ?? 1, ratio: s.ratio ?? '1:1', long: LONG_MAP[s.resolution ?? '1K'],
    duration: s.duration, source: s.source === undefined || s.source === 'product' ? 'product' : s.source - 1,
    motion: s.motion, labelSafe: s.label_safe, fast: s.fast, lora: s.lora ?? null,
  }));
  const r = await call('/api/batches/from-folder', { folder: a.folder, files: a.files, products: a.products, steps, name: a.name, limit: a.limit, toneId: a.tone_id, qc: a.qc });
  const b = r.batch;
  return text({
    batch_id: b.id, products: b.products.map((p: any) => p.name), steps: b.steps.map((s: any) => `${s.label} (${s.moduleId}, ${s.ratio})`),
    image_fixes: r.imageNotes, output_folder: await abs(b.outDir),
    note: '진행 중이에요. autoqc_batch_status로 확인하세요. 앱의 [상품 배치] 탭에서도 실시간으로 볼 수 있어요.',
  });
});

server.registerTool('autoqc_batch_status', {
  title: '배치 진행 상황',
  description: '상품 배치의 진행 상황(상품 × 컷별 상태, 결과 파일)을 보여 줍니다. batch_id를 생략하면 가장 최근 배치.',
  inputSchema: { batch_id: z.string().optional() },
}, async ({ batch_id }) => {
  const { batches } = await call('/api/batches');
  const b = batch_id ? batches.find((x: any) => x.id === batch_id) : batches[0];
  if (!b) return text('배치가 없어요.');
  const rows = [];
  for (const c of b.cells) rows.push({ product: b.products[c.p].name, step: b.steps[c.s].label, status: c.status, seconds: c.sec, files: await Promise.all(c.files.map((f: string) => abs(f))), note: c.note });
  const done = b.cells.filter((c: any) => !['waiting', 'running'].includes(c.status)).length;
  return text({ batch_id: b.id, name: b.name, status: b.status, progress: `${done}/${b.cells.length}`, passed: b.cells.filter((c: any) => c.status === 'passed').length, output_folder: await abs(b.outDir), summary_csv: await abs(b.outDir + '/요약.csv'), cells: rows });
});

server.registerTool('autoqc_cancel', {
  title: '작업·배치 취소',
  description: '진행 중인 배치(batch_id) 또는 단일 생성 작업(job_id)을 취소합니다. 지금 만들던 컷까지만 끝내고 나머지는 건너뜁니다. 서버는 끄지 않습니다.',
  inputSchema: { batch_id: z.string().optional(), job_id: z.string().optional() },
}, async ({ batch_id, job_id }) => {
  if (!batch_id && !job_id) throw new Error('batch_id나 job_id 중 하나를 넣어 주세요');
  if (batch_id) await call(`/api/batches/${batch_id}/cancel`, {});
  if (job_id) await call(`/api/jobs/${job_id}/cancel`, {});
  return text({ canceled: { batch_id, job_id } });
});

server.registerTool('autoqc_stats', {
  title: '생산·검수 통계',
  description: '지금까지의 생성 수, 첫 시도/최종 통과율, 평균 소요 시간, 결함 유형별 건수, 검수와 사람 판단 일치도 등 PoC 지표를 돌려줍니다.',
  inputSchema: {},
}, async () => text(await call('/api/stats')));

await server.connect(new StdioServerTransport());
