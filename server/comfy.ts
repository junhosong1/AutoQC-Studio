// ComfyUI 어댑터 — ComfyUI 서버의 HTTP / WebSocket API만 사용합니다.
// 쓰는 경로: /prompt, /history, /view, /upload/image, /free, /interrupt, /object_info, /system_stats, /ws
import { randomUUID } from 'node:crypto';
import { getSettings } from './config.js';

export interface ComfyImageRef { filename: string; subfolder: string; type: string }
export type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, any>; _meta?: { title?: string } }>;

export class ComfyError extends Error {}

async function fetchT(url: string, init: RequestInit = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new ComfyError(`ComfyUI 응답 시간 초과 (${url})`);
    throw new ComfyError(`ComfyUI에 연결할 수 없어요 (${url}). ComfyUI Desktop이 켜져 있는지 확인해 주세요.`);
  } finally {
    clearTimeout(t);
  }
}

export class Comfy {
  readonly clientId = randomUUID();
  private infoCache = new Map<string, any>();
  constructor(public base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  async json(p: string, init?: RequestInit, ms?: number) {
    const r = await fetchT(this.base + p, init, ms);
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!r.ok) {
      const ne = body?.node_errors && Object.keys(body.node_errors).length ? body.node_errors : null;
      let msg = body?.error?.message || body?.error || text.slice(0, 300) || `HTTP ${r.status}`;
      if (ne) {
        const first = Object.entries(ne)[0] as [string, any];
        const err = first[1]?.errors?.[0];
        msg += ` — 노드 ${first[0]} (${first[1]?.class_type}): ${err?.message ?? ''} ${err?.details ?? ''}`;
      }
      throw new ComfyError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return body;
  }

  systemStats() { return this.json('/system_stats', undefined, 4000); }

  async objectInfo(cls: string) {
    if (this.infoCache.has(cls)) return this.infoCache.get(cls);
    const all = await this.json('/object_info/' + encodeURIComponent(cls), undefined, 8000);
    const info = all?.[cls] ?? null;
    if (info) this.infoCache.set(cls, info);
    return info;
  }

  clearInfoCache() { this.infoCache.clear(); }

  /** 노드 입력의 선택지 목록 (예: KSampler.sampler_name, LoraLoaderModelOnly.lora_name) */
  async inputOptions(cls: string, input: string): Promise<string[] | null> {
    const info = await this.objectInfo(cls).catch(() => null);
    const spec = info?.input?.required?.[input] ?? info?.input?.optional?.[input];
    if (!spec) return null;
    if (Array.isArray(spec[0])) return spec[0].map(String);
    if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options.map(String);
    return null;
  }

  async loras(): Promise<string[]> {
    return (await this.inputOptions('LoraLoaderModelOnly', 'lora_name')) ?? (await this.inputOptions('LoraLoader', 'lora_name')) ?? [];
  }

  async upload(buf: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(buf)]), filename);
    form.append('overwrite', 'true');
    const r = await this.json('/upload/image', { method: 'POST', body: form }, 60000);
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  async queue(prompt: ApiWorkflow): Promise<string> {
    const r = await this.json('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 유료 API 노드는 Comfy.org 키가 있어야 실행됨 (앱 밖에서 /prompt로 보낼 때는 ComfyUI 로그인 정보가 따라가지 않음)
      body: JSON.stringify({ prompt, client_id: this.clientId, ...(getSettings().comfyApiKey ? { extra_data: { api_key_comfy_org: getSettings().comfyApiKey } } : {}) }),
    }, 30000);
    if (!r?.prompt_id) throw new ComfyError('큐 등록 실패: prompt_id가 없어요');
    // 일부 출력만 검증 실패한 경우 ComfyUI는 오류 없이 나머지(예: 텍스트 미리보기)만 실행함 → 저장 노드가 안 돌아 결과가 비게 됨.
    // 이때는 바로 실패 처리하고 어떤 노드·파일이 문제인지 알려 줌
    const ne = r.node_errors && Object.keys(r.node_errors).length ? r.node_errors : null;
    if (ne) {
      try { await this.json('/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [r.prompt_id] }) }, 5000); } catch { /* 이미 실행 중이면 무시 */ }
      const [id, info] = Object.entries<any>(ne)[0];
      const err = info?.errors?.[0];
      const detail = `${err?.message ?? ''} ${err?.details ?? ''}`.trim();
      const hint = /not in list|value_not_in_list/i.test(detail) ? ' → 이 파일이 ComfyUI models 폴더에 없어요. [모듈 · 설정]의 다운로드 또는 ComfyUI에서 받아 주세요' : '';
      throw new ComfyError(`워크플로우 검증 실패 — 노드 ${id} (${info?.class_type ?? '?'}): ${detail}${hint}`);
    }
    return r.prompt_id;
  }

  /** 완료까지 대기. WebSocket으로 진행률을 받고, 완료 판정은 /history 폴링으로 이중 확인 */
  wait(promptId: string, onProgress: (p: number) => void, timeoutMs = 15 * 60 * 1000, isCanceled = () => false): Promise<any> {
    return new Promise((resolve, reject) => {
      let done = false;
      let ws: WebSocket | null = null;
      const finish = (err: Error | null, val?: any) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        try { ws?.close(); } catch { /* */ }
        err ? reject(err) : resolve(val);
      };
      const check = async () => {
        if (isCanceled()) return finish(new ComfyError('취소됨'));
        try {
          const h = await this.json('/history/' + promptId, undefined, 8000);
          const entry = h?.[promptId];
          if (!entry) return;
          const st = entry.status;
          if (st?.status_str === 'error') {
            const m = (st.messages || []).find((x: any) => x[0] === 'execution_error');
            const raw = String(m?.[1]?.exception_message || '알 수 없는 오류').trim();
            // 유료 API 노드에서 자주 나는 오류는 해결 방법을 같이 알려 줌
            const hint = /unauthori[sz]ed|log ?in|api[_ ]?key|401/i.test(raw) ? ' → 설정의 "Comfy API 키"를 넣어 주세요 (platform.comfy.org에서 발급, 크레딧을 산 계정)'
              : /402|insufficient|credit|balance|payment/i.test(raw) ? ' → Comfy 크레딧이 부족해요. platform.comfy.org에서 잔액을 확인해 주세요' : '';
            return finish(new ComfyError('ComfyUI 실행 오류: ' + raw + hint));
          }
          if (st?.completed || (entry.outputs && Object.keys(entry.outputs).length)) finish(null, entry);
        } catch { /* 일시적 오류는 다음 폴링에서 */ }
      };
      const poll = setInterval(check, 1500);
      const timer = setTimeout(() => finish(new ComfyError('생성 시간 초과')), timeoutMs);
      try {
        const WS: any = (globalThis as any).WebSocket;
        if (WS) {
          ws = new WS(this.base.replace(/^http/, 'ws') + '/ws?clientId=' + this.clientId);
          ws!.onmessage = (ev: any) => {
            if (typeof ev.data !== 'string') return; // 미리보기 바이너리 무시
            try {
              const m = JSON.parse(ev.data);
              if (m.data?.prompt_id && m.data.prompt_id !== promptId) return;
              if (m.type === 'progress' && m.data?.max) onProgress(m.data.value / m.data.max);
              if (m.type === 'executing' && m.data?.node === null) check();
              if (m.type === 'execution_error') check();
            } catch { /* */ }
          };
          ws!.onerror = () => { /* 폴링으로 계속 */ };
        }
      } catch { /* WebSocket 없으면 폴링만 */ }
    });
  }

  /** 결과 파일 목록 (이미지 + 영상). 영상 노드는 images / gifs / videos / video 키에 담아 보냄 */
  outputImages(entry: any): ComfyImageRef[] {
    const out: ComfyImageRef[] = [];
    for (const o of Object.values<any>(entry?.outputs ?? {})) {
      for (const key of ['videos', 'video', 'gifs', 'images']) {
        for (const f of o?.[key] ?? []) if (f?.filename) out.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
      }
    }
    const isVid = (f: ComfyImageRef) => /\.(mp4|webm|mov|mkv|gif)$/i.test(f.filename);
    // 영상 > 저장된 이미지 > 미리보기 순서
    return out.sort((a, b) => (isVid(b) ? 1 : 0) - (isVid(a) ? 1 : 0) || (a.type === 'output' ? 0 : 1) - (b.type === 'output' ? 0 : 1));
  }

  async fetchImage(ref: ComfyImageRef): Promise<Buffer> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'output' });
    const r = await fetchT(`${this.base}/view?${q}`, {}, 300000);
    if (!r.ok) throw new ComfyError('결과 이미지를 받아오지 못했어요');
    return Buffer.from(await r.arrayBuffer());
  }

  free() {
    return this.json('/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) }, 8000).catch(() => null);
  }

  interrupt() { return this.json('/interrupt', { method: 'POST' }, 5000).catch(() => null); }

  history(max = 30) { return this.json('/history?max_items=' + max, undefined, 10000); }
}

export function isLink(v: any): boolean {
  return Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';
}
