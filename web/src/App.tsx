import { useCallback, useEffect, useState } from 'react';
import { api, Download, Job, ModuleDef, Settings, Status, fileUrl, Credits, fmtCr } from './api';
import Generate from './pages/Generate';
import Gallery from './pages/Gallery';
import Stats from './pages/Stats';
import SettingsPage from './pages/Settings';
import BatchPage, { Batch } from './pages/Batch';
import QcCheck from './pages/QcCheck';

const TABS = [
  { id: 'gen', label: '이미지 생성' },
  { id: 'video', label: '영상 생성' },
  { id: 'batch', label: '상품 배치' },
  { id: 'check', label: '단독 검수' },
  { id: 'gallery', label: '결과 갤러리' },
  { id: 'stats', label: '기록 · 통계' },
  { id: 'settings', label: '모듈 · 설정' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export interface AppCtx {
  status: Status | null;
  settings: Settings | null;
  defects: Record<string, string>;
  modules: ModuleDef[];
  loras: string[];
  jobs: Job[];
  batches: Batch[];
  reloadModules: (hard?: boolean) => Promise<void>;
  reloadSettings: () => Promise<void>;
  refreshLoras: () => Promise<void>;
  toast: (m: string) => void;
  goto: (t: TabId) => void;
  credits: Credits | null;
  refreshCredits: (force?: boolean) => void;
  downloads: Download[];
  handoff: Handoff | null;
  clearHandoff: () => void;
  sendToVideo: (file: string) => Promise<void>;
}
export interface Handoff { moduleId: string; refs: { name: string; preview: string }[]; note: string }

export default function App() {
  const [tab, setTab] = useState<TabId>(() => (localStorage.getItem('aq.tab') as TabId) || 'gen');
  const [status, setStatus] = useState<Status | null>(null);
  const [offline, setOffline] = useState(false);
  const [credits, setCredits] = useState<Credits | null>(null);
  const refreshCredits = useCallback((force = false) => { api('/api/credits' + (force ? '?force=1' : '')).then(setCredits).catch(() => {}); }, []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defects, setDefects] = useState<Record<string, string>>({});
  const [modules, setModules] = useState<ModuleDef[]>([]);
  const [loras, setLoras] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [handoff, setHandoff] = useState<Handoff | null>(null);

  const toast = useCallback((m: string) => { setToastMsg(m); setTimeout(() => setToastMsg(null), 3200); }, []);
  const reloadModules = useCallback(async (hard = false) => {
    const r = await api<{ modules: ModuleDef[] }>(hard ? '/api/modules/reload' : '/api/modules', hard ? {} : undefined);
    setModules(r.modules);
  }, []);
  const reloadSettings = useCallback(async () => {
    const r = await api('/api/settings');
    setSettings(r.settings); setDefects(r.defects);
  }, []);
  const refreshLoras = useCallback(async () => { setLoras((await api('/api/comfy/loras')).loras); }, []);

  useEffect(() => { try { localStorage.setItem('aq.tab', tab); } catch { /* */ } }, [tab]);

  useEffect(() => {
    reloadSettings().catch(() => {});
    reloadModules().catch(() => {});
    refreshLoras().catch(() => {});
    api('/api/jobs').then((r) => setJobs(r.jobs)).catch(() => {});
    api('/api/downloads').then((r) => setDownloads(r.downloads)).catch(() => {});
    const poll = async () => { try { setStatus(await api('/api/status')); setOffline(false); } catch { setOffline(true); } };
    refreshCredits();
    const ct = setInterval(() => refreshCredits(), 60000);
    poll();
    const t = setInterval(poll, 8000);
    const es = new EventSource('/api/events');
    // 서버가 꺼지면 SSE가 끊김 → 경고 표시. 다시 켜지면(자동 재연결) 목록을 새로 받아 화면을 서버 상태와 맞춤
    let lost = false;
    es.onerror = () => { lost = true; setOffline(true); };
    es.onopen = () => {
      setOffline(false);
      if (lost) {
        lost = false;
        api('/api/jobs').then((r) => setJobs(r.jobs)).catch(() => {});
        api('/api/batches').then((r) => setBatches(r.batches)).catch(() => {});
        poll();
      }
    };
    es.addEventListener('job', (ev) => {
      const j: Job = JSON.parse((ev as MessageEvent).data);
      if (j.credits?.after !== undefined) setCredits((c) => (c ? { ...c, credits: j.credits!.after, at: Date.now() } : c)); // 유료 작업이 끝나면 잔액 갱신
      setJobs((prev) => {
        const i = prev.findIndex((x) => x.id === j.id);
        if (i < 0) return [j, ...prev];
        const next = prev.slice(); next[i] = j; return next;
      });
    });
    api('/api/batches').then((r) => setBatches(r.batches)).catch(() => {});
    es.addEventListener('batch', (ev) => {
      const b: Batch = JSON.parse((ev as MessageEvent).data);
      setBatches((prev) => { const i = prev.findIndex((x) => x.id === b.id); if (i < 0) return [b, ...prev]; const n = prev.slice(); n[i] = b; return n; });
    });
    es.addEventListener('batchdel', (ev) => {
      const { id } = JSON.parse((ev as MessageEvent).data);
      setBatches((prev) => prev.filter((x) => x.id !== id));
    });
    es.addEventListener('jobdel', (ev) => {
      const { id } = JSON.parse((ev as MessageEvent).data);
      setJobs((prev) => prev.filter((x) => x.id !== id));
    });
    es.addEventListener('download', (ev) => {
      const d: Download = JSON.parse((ev as MessageEvent).data);
      setDownloads((prev) => { const i = prev.findIndex((x) => x.id === d.id); if (i < 0) return [d, ...prev]; const n = prev.slice(); n[i] = d; return n; });
    });
    return () => { clearInterval(t); clearInterval(ct); es.close(); };
  }, [reloadModules, reloadSettings, refreshLoras]);

  // ComfyUI가 나중에 켜지면 모듈 옵션과 LoRA 목록 다시 받기
  const comfyOk = status?.comfy.ok;
  useEffect(() => { if (comfyOk) { refreshLoras().catch(() => {}); reloadModules().catch(() => {}); } }, [comfyOk, refreshLoras, reloadModules]);

  const sendToVideo = useCallback(async (file: string) => {
    // 시작 이미지 1장짜리 I2V 모듈을 우선 (없으면 이미지 입력이 있는 아무 영상 모듈)
    const vids = modules.filter((m) => m.ready && m.category === 'video' && m.images.length > 0);
    const vm = vids.find((m) => m.images.length === 1) ?? vids[0];
    if (!vm) { toast('이미지→영상 모듈이 아직 없어요. ComfyUI에서 LTX-2.5 I2V를 한 번 실행한 뒤 [모듈 가져오기]로 붙여 주세요.'); return; }
    try {
      const { name } = await api('/api/upload-from-output', { file });
      setHandoff({ moduleId: vm.id, refs: [{ name, preview: fileUrl(file) }], note: `"${vm.name}"에 이 컷을 시작 이미지로 넣었어요` });
      setTab('video');
    } catch (e: any) { toast(e.message); }
  }, [modules, toast]);

  const ctx: AppCtx = { status, settings, defects, modules, loras, jobs, batches, reloadModules, reloadSettings, refreshLoras, toast, goto: setTab, credits, refreshCredits, downloads, handoff, clearHandoff: () => setHandoff(null), sendToVideo };
  const gb = status?.comfy.vramTotal ? Math.round(status.comfy.vramTotal / 1024 ** 3) + 'GB' : '';
  const llmName = status?.llm.model?.split('/').pop()?.replace(/-/g, ' ') ?? '';

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><div className="logo">Q</div>AutoQC Studio <small>v0.1</small></div>
        <nav className="tabs">
          {TABS.map((t) => <button key={t.id} className={'tab' + (tab === t.id ? ' on' : '')} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </nav>
        <div className="status">
          {credits?.configured && (
            <button className="chip" title={credits.error ? credits.error : `Comfy 크레딧 잔액 (≈ $${(credits.usd ?? 0).toFixed(2)}) · 눌러서 새로고침`} onClick={() => refreshCredits(true)}>
              <span className={'dot' + (credits.error ? ' warn' : '')} />크레딧 <b>{credits.error ? '확인 불가' : fmtCr(credits.credits ?? 0)}</b>
            </button>
          )}
          <div className="chip" title={status?.comfy.error ?? status?.url}>
            <span className={'dot' + (status?.comfy.ok ? '' : ' off')} />ComfyUI <b>{status ? (status.comfy.ok ? `${status.comfy.gpu?.replace('NVIDIA GeForce ', '') ?? ''} · ${gb}` : '연결 안 됨') : '확인 중'}</b>
          </div>
          <div className="chip" title={status?.llm.error ?? ''}>
            <span className={'dot' + (!status?.llm.ok ? ' off' : status.llm.hasModel ? '' : ' warn')} />LLM <b>{status ? (status.llm.ok ? llmName : '연결 안 됨') : '확인 중'}</b>
          </div>
        </div>
      </header>
      {offline && <div className="offline">AutoQC 서버와 연결이 끊겼어요. 지금 화면은 마지막 상태라 삭제·생성이 반영되지 않아요. start.bat을 실행하면 자동으로 다시 연결돼요.</div>}
      {tab === 'gen' && <Generate key="image" ctx={ctx} kind="image" />}
      {tab === 'video' && <Generate key="video" ctx={ctx} kind="video" />}
      {tab === 'batch' && <BatchPage ctx={ctx} />}
      {tab === 'check' && <QcCheck ctx={ctx} />}
      {tab === 'gallery' && <Gallery ctx={ctx} />}
      {tab === 'stats' && <Stats ctx={ctx} />}
      {tab === 'settings' && <SettingsPage ctx={ctx} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
