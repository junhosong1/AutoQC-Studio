// Comfy 크레딧: 잔액 조회 + 유료 API 노드 비용 추정
//  - 잔액: GET https://api.comfy.org/customers/balance (X-API-KEY) → amount_micros (USD 백만분의 1)
//  - 크레딧 = USD × 211 (ComfyUI 화면과 같은 환산)
//  - 비용 추정식은 ComfyUI 0.39 노드의 가격 배지(price_badge)를 옮긴 것. 실제 청구와 약간 다를 수 있음
import { getSettings } from './config.js';
import type { ApiWorkflow } from './comfy.js';

export const CREDITS_PER_USD = 211;
const API = 'https://api.comfy.org';

export interface Balance { configured: boolean; usd?: number; credits?: number; at?: number; error?: string;
  /** 진단용: 응답 상태와 잔액 필드(숫자만) */
  status?: number; fields?: Record<string, number | string> }
let cache: Balance | null = null;

// 잔액 조회 경로: 새 플랫폼은 워크스페이스 결제(cloud.comfy.org/api/billing/balance)가 기준.
// 예전 개인 계정 잔액(api.comfy.org/customers/balance)은 0으로 남아 있을 수 있어서 보조로만 사용
const SOURCES = [
  { name: 'workspace', url: 'https://cloud.comfy.org/api/billing/balance' },
  { name: 'customer', url: API + '/customers/balance' },
];

async function fetchJson(url: string, key: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const r = await fetch(url, { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', Accept: 'application/json' }, signal: ctl.signal });
    const body: any = r.ok ? await r.json().catch(() => null) : null;
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

function parse(raw: any) {
  const j: any = raw?.balance && typeof raw.balance === 'object' ? raw.balance : raw;
  const fields: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(j ?? {})) if ((typeof v === 'number' || (typeof v === 'string' && v.length < 20)) && /micros|balance|amount|credit|currency/i.test(k)) fields[k] = v as any;
  // 쓸 수 있는 잔액. 워크스페이스 응답은 *_cents 필드가 있고, 같은 값이 *_micros에도 들어 있음(이름과 달리 센트 단위).
  // 그래서 *_cents가 있으면 센트로, 없으면(예전 개인 계정 응답) 마이크로달러로 계산
  const pick = (...xs: any[]) => { const c = xs.filter((x) => typeof x === 'number'); return c.find((x) => x > 0) ?? c[0]; };
  const cents = pick(j?.effective_balance_cents, j?.amount_cents, typeof j?.prepaid_balance_cents === 'number' ? j.prepaid_balance_cents + (j.cloud_credit_balance_cents ?? 0) : undefined);
  const micros = typeof cents === 'number' ? cents * 1e4
    : pick(j?.effective_balance_micros, j?.amount_micros, typeof j?.prepaid_balance_micros === 'number' ? j.prepaid_balance_micros + (j.cloud_credit_balance_micros ?? 0) : undefined);
  return { micros, fields };
}

export async function getBalance(force = false): Promise<Balance> {
  const key = getSettings().comfyApiKey;
  if (!key) return { configured: false };
  if (!force && cache?.at && Date.now() - cache.at < 30_000 && !cache.error) return cache;
  const tried: string[] = [];
  let zero: Balance | null = null;
  for (const src of SOURCES) {
    try {
      const { status, body } = await fetchJson(src.url, key);
      tried.push(`${src.name}:${status}`);
      if (status === 401 || status === 403) continue;
      if (!body) continue;
      const { micros, fields } = parse(body);
      if (typeof micros !== 'number') continue;
      const usd = micros / 1e6;
      const b: Balance = { configured: true, status, fields: { ...fields, source: src.name }, usd, credits: Math.round(usd * CREDITS_PER_USD), at: Date.now() };
      if (micros > 0) return (cache = b);
      zero ??= b; // 0이면 다음 경로도 확인
    } catch (e: any) {
      tried.push(`${src.name}:${e?.name === 'AbortError' ? 'timeout' : 'fail'}`);
    }
  }
  if (zero) return (cache = zero);
  const auth = tried.every((t) => /:(401|403)$/.test(t));
  return (cache = { configured: true, error: auth ? 'API 키가 맞지 않아요 (platform.comfy.org → API 키에서 확인)' : `잔액을 읽지 못했어요 (${tried.join(', ')})`, at: Date.now() });
}

/** GPT Image 2: 1024² 기준 가격(가격 배지 프리셋) × 화소 비율^0.5 + 참조 이미지당 요금 */
const GPT2: Record<string, number> = { low: 0.0071, medium: 0.0632, high: 0.2529 };
const GPT2_REF = 0.012;

/** 워크플로우(값이 다 들어간 상태) 한 번 실행의 예상 비용(USD). 유료 노드가 없으면 0, 모르는 유료 노드면 null */
export function estimateUsd(wf: ApiWorkflow): number | null {
  let total = 0;
  let unknown = false;
  for (const n of Object.values(wf)) {
    const c = n.class_type, i = n.inputs ?? {};
    if (c === 'OpenAIGPTImageNodeV2') {
      const q = String(i['model.quality'] ?? 'medium');
      const [w, h] = i['model.size'] === 'Custom' || !/^\d+x\d+$/.test(String(i['model.size']))
        ? [Number(i['model.custom_width']) || 1024, Number(i['model.custom_height']) || 1024]
        : String(i['model.size']).split('x').map(Number);
      const refs = Object.keys(i).filter((k) => k.startsWith('model.images.')).length;
      total += ((GPT2[q] ?? GPT2.medium) * Math.sqrt((w * h) / (1024 * 1024)) + refs * GPT2_REF) * (Number(i.n) || 1);
    } else if (/^ByteDance2(FirstLastFrame|TextToVideo|Reference)/.test(c)) {
      const m = String(i.model ?? ''), res = String(i['model.resolution'] ?? '720p');
      const dur = Number(i['model.duration']) || 5;
      if (/2\.5/.test(m)) {
        // Seedance 2.5 (노드 가격 배지 식, 참조 영상 없음): 프레임당 단가 × (24×초+1) 프레임
        const ratio = String(i['model.ratio'] ?? '16:9');
        const is480 = res === '480p', is1080 = res === '1080p';
        const perFrame = ratio === '1:1' ? (is480 ? 400 : is1080 ? 2025 : 900)
          : ratio === '4:3' || ratio === '3:4' ? (is480 ? 411.25 : is1080 ? 2028 : 905.6719)
          : ratio === '21:9' ? (is480 ? 418.5 : is1080 ? 2037.9648 : 904.3945)
          : (is480 ? 400.3125 : is1080 ? 2025 : 900);
        total += (Math.floor(perFrame * (24 * dur + 1)) / 1000) * (is1080 ? 0.016731 : 0.015301);
        continue;
      }
      const rate = res === '4k' ? 195200 : res === '1080p' ? 48800 : res === '720p' ? 21600 : 10044;
      const price = res === '4k' ? 0.00572 : res === '1080p' ? 0.011011 : /mini/i.test(m) ? 0.005005 : /fast/i.test(m) ? 0.008008 : 0.01001;
      total += (dur * rate * price) / 1000;
    } else if (/^(OpenAI|ByteDance|Kling|Veo|Runway|Luma|Pixverse|Vidu|Recraft|Ideogram|Flux.*Pro|Gemini.*Image|Minimax(?!H3))/.test(c) && !/Chat|Config|InputFiles|Asset|LLM/.test(c)) {
      unknown = true; // 가격식을 아직 넣지 않은 유료 노드
    }
  }
  return unknown && total === 0 ? null : total;
}
export const toCredits = (usd: number) => Math.round(usd * CREDITS_PER_USD);
