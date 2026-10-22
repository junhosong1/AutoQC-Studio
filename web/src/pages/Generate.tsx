import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppCtx } from '../App';
import { api, DEFECT_LABEL, Item, Job, ModuleDef, pct, fmtSec, loraFamily, fmtCr } from '../api';
import JobCard from '../components/JobCard';
import ItemDetail from '../components/ItemDetail';

const RATIOS: [string, number][] = [['1:1', 1], ['4:5', 4 / 5], ['3:4', 3 / 4], ['4:3', 4 / 3], ['9:16', 9 / 16], ['16:9', 16 / 9], ['2:3', 2 / 3], ['3:2', 3 / 2], ['21:9', 21 / 9]];

// 해상도 단계: 긴 변 기준 (1K ≈ 720p, 4K = UHD)
type Tier = '480p' | '540p' | '1K' | '2K' | '3K' | '4K';
const TIERS: [Tier, number][] = [['480p', 832], ['540p', 960], ['1K', 1280], ['2K', 2048], ['3K', 3072], ['4K', 3840]];
// 1K 미만은 영상에서만 (LTX는 32배수·짧은 변 최소 약 480에서 안정적으로 동작) — 빠른 초안·검수용
const dims = (ratio: number, long: number, mult: number) => {
  const sn = (x: number) => Math.max(mult * 8, Math.round(x / mult) * mult);
  return ratio >= 1 ? { w: sn(long), h: sn(long / ratio) } : { w: sn(long * ratio), h: sn(long) };
};

interface Form {
  moduleId: string; brief: string; motion: string; toneId: string; enhance: boolean; finalPrompt: string;
  /** 확장 프롬프트를 만든 기준 (기획 문장 + 모듈) — 바뀌면 그 확장 프롬프트는 쓰지 않음 */
  finalFor?: string;
  /** 영상: 라벨·로고 보존 모드 */
  labelSafe?: boolean;
  ratio: string; tier: Tier; width: number; height: number; count: number; seedMode: 'random' | 'fixed'; seed: number;
  loraName: string; loraStrength: number; qcEnabled: boolean; passScore: number; maxAttempts: number;
  /** 만드는 에셋 종류 (캐릭터 시트 / 로케이션이면 그 스킬 규칙으로 작성·검수) */
  qcProfile?: 'default' | 'character_sheet' | 'location';
  params: Record<string, Record<string, any>>; // 모듈별 고급 설정
}

// 프롬프트(기획 문장·움직임·확장 결과)는 이 브라우저 탭에서만 기억 → 앱을 다시 켜면 빈 칸으로 시작. 모듈·비율 같은 설정은 계속 기억
const TEXT_KEYS = ['brief', 'motion', 'finalPrompt', 'finalFor'] as const;
const read = (st: Storage, key: string) => { try { return JSON.parse(st.getItem(key) || '{}'); } catch { return {}; } };
const load = (kind: string): Partial<Form> => {
  const saved = read(localStorage, 'aq.form.' + kind);
  for (const k of TEXT_KEYS) delete saved[k];
  return { ...saved, ...read(sessionStorage, 'aq.text.' + kind) };
};
const persist = (kind: string, f: Form) => {
  const keep: any = { ...f }, text: any = {};
  for (const k of TEXT_KEYS) { text[k] = keep[k]; delete keep[k]; }
  try { localStorage.setItem('aq.form.' + kind, JSON.stringify(keep)); sessionStorage.setItem('aq.text.' + kind, JSON.stringify(text)); } catch { /* */ }
};
export const isVideoModule = (m?: ModuleDef) => m?.category === 'video';

export default function Generate({ ctx, kind }: { ctx: AppCtx; kind: 'image' | 'video' }) {
  const { modules, settings, loras, toast, status } = ctx;
  const ofKind = (m: ModuleDef) => (kind === 'video' ? isVideoModule(m) : !isVideoModule(m));
  const [f, setF] = useState<Form>(() => ({
    moduleId: '', brief: '', motion: '', toneId: '', enhance: true, finalPrompt: '',
    tier: '1K', ratio: kind === 'video' ? '16:9' : '1:1', width: kind === 'video' ? 960 : 1328, height: kind === 'video' ? 544 : 1328, count: kind === 'video' ? 1 : 2,
    seedMode: 'random', seed: 1234, loraName: '', loraStrength: 0.8, qcEnabled: true, passScore: 7, maxAttempts: 3, params: {},
    ...load(kind),
  }));
  const [refs, setRefs] = useState<({ name: string; preview: string } | null)[]>([]);
  const [busy, setBusy] = useState<'' | 'enhance' | 'submit' | 'upload'>('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<{ job: Job; item: Item; attempt?: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSlot = useRef(0);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));

  useEffect(() => { persist(kind, f); }, [f, kind]);
  useEffect(() => {
    if (!settings) return;
    setF((x) => (x.passScore === 7 && x.maxAttempts === 3 ? { ...x, passScore: settings.qc.passScore, maxAttempts: settings.qc.maxAttempts } : x));
  }, [settings]);

  const ready = modules.filter((m) => m.ready && ofKind(m));
  // 이미지 탭과 영상 탭은 각자 고른 모듈을 따로 기억 — 다른 종류의 모듈은 절대 선택되지 않게
  const mod: ModuleDef | undefined = ready.find((m) => m.id === f.moduleId) ?? ready[0];
  useEffect(() => { if (mod && mod.id !== f.moduleId) set({ moduleId: mod.id }); }, [mod?.id]); // eslint-disable-line
  // LoRA: 이 모듈의 LoRA가 들어가는 모델 계열에 맞는 것만 고를 수 있게
  const loraTarget = mod?.loraTarget ?? null;
  const loraCompat = (l: string) => { const lf = loraFamily(l); return !lf || !loraTarget?.family ? 'unknown' : lf.id === loraTarget.family ? 'ok' : 'bad'; };
  const loraGroups = useMemo(() => ({ ok: loras.filter((l) => loraCompat(l) === 'ok'), unknown: loras.filter((l) => loraCompat(l) === 'unknown'), bad: loras.filter((l) => loraCompat(l) === 'bad') }), [loras, loraTarget?.family]); // eslint-disable-line
  // 모듈마다 마지막으로 쓴 LoRA를 기억 → 모듈을 고르면 자동으로 그 LoRA
  //   우선순위: ① 이 모듈에서 마지막으로 쓴 LoRA ② 워크플로우에 원래 있던 LoRA ③ 이 모델 계열에 맞는 LoRA (예: Qwen 모듈 → qwen LoRA)
  const loraMem = (): Record<string, { name: string; strength: number }> => { try { return JSON.parse(localStorage.getItem('aq.lora') || '{}'); } catch { return {}; } };
  const pickLora = (name: string, strength?: number) => {
    set({ loraName: name, ...(strength !== undefined ? { loraStrength: strength } : {}) });
    if (mod) { try { localStorage.setItem('aq.lora', JSON.stringify({ ...loraMem(), [mod.id]: { name, strength: strength ?? f.loraStrength } })); } catch { /* */ } }
  };
  useEffect(() => {
    if (!mod || mod.lora.mode === 'none' || !loras.length) return;
    const usable = (n: string) => n === '' || (loras.includes(n) && loraCompat(n) !== 'bad');
    const saved = loraMem()[mod.id];
    if (saved && usable(saved.name)) { set({ loraName: saved.name, loraStrength: saved.strength }); return; }
    if (mod.loraDefault && usable(mod.loraDefault.name)) { set({ loraName: mod.loraDefault.name, loraStrength: mod.loraDefault.strength }); return; }
    // Lightning/Turbo 같은 속도용 LoRA는 자동으로 고르지 않음 (빠른 모드 토글이 담당)
    const auto = loraGroups.ok.find((l) => !/turbo|lightning|\d+step/i.test(l) && !(mod.builtinLoras ?? []).includes(l)) ?? '';
    set({ loraName: auto });
  }, [mod?.id, loras.length, loraTarget?.family]); // eslint-disable-line
  const modParams = (mod && f.params[mod.id]) || {};
  const setParam = (key: string, v: any) => mod && set({ params: { ...f.params, [mod.id]: { ...modParams, [key]: v } } });
  // 해상도: 비율 + 단계(1K~4K) → 가로×세로. 영상 모델의 Resolution Selector(비율·메가픽셀)와 크기 노드에 같이 반영
  const rsAspect = mod?.params.find((p) => p.key.endsWith('.aspect_ratio') && p.options?.length);
  const rsMp = mod?.params.find((p) => p.key.endsWith('.megapixels'));
  const pW = mod?.params.find((p) => /^width$/i.test(p.label.split('·').pop()!.trim()));
  const pH = mod?.params.find((p) => /^height$/i.test(p.label.split('·').pop()!.trim()));
  // 유료 영상 API(Seedance 등): 해상도·비율이 선택지
  const tierP = mod?.params.find((p) => /(^|\.)resolution$/.test(p.input) && p.options?.some((o) => /^\d{3,4}p$/i.test(o)));
  const ratioP = mod?.params.find((p) => /(^|\.)ratio$/.test(p.input) && p.options?.some((o) => /^\d+:\d+$/.test(o)));
  const paid = mod?.cost === 'paid';
  const hasSize = !!(mod?.size || rsMp || (pW && pH) || tierP || ratioP);
  const ratioOk = (l: string) => (!rsAspect || rsAspect.options!.some((o) => o.startsWith(l + ' '))) && (!ratioP || ratioP.options!.includes(l));
  const ratios = RATIOS.filter(([l]) => ratioOk(l));
  const isVid = kind === 'video';
  useEffect(() => { if (mod && hasSize && !ratioOk(f.ratio)) set({ ratio: ratios.find(([l]) => l === '16:9')?.[0] ?? ratios[0]?.[0] ?? '1:1' }); }, [mod?.id]); // eslint-disable-line
  const curRatio = RATIOS.find(([l]) => l === f.ratio)?.[1] ?? 1;
  const longSide = (!isVid && f.tier.endsWith('p') ? 1280 : TIERS.find(([t]) => t === f.tier)?.[1]) ?? 1280;
  const size = dims(curRatio, longSide, isVid || rsMp ? 32 : 16);
  useEffect(() => { if (size.w !== f.width || size.h !== f.height) set({ width: size.w, height: size.h }); }, [size.w, size.h]); // eslint-disable-line
  const tierWarn = paid ? '' : isVid
    ? (f.tier === '2K' ? 'RTX 3080 12GB에서 영상 2K는 매우 오래 걸려요 (수십 분).' : f.tier === '3K' || f.tier === '4K' ? '12GB VRAM에서 영상 3K·4K는 메모리 부족으로 실패할 가능성이 높아요.' : '')
    : (f.tier === '3K' || f.tier === '4K' ? '모델 기본 해상도(약 1.3K)보다 훨씬 커서 느리고, 구도가 반복·깨질 수 있어요.' : '');
  // 영상 길이: 모델마다 지원 범위가 달라서 모델 계열별로 범위·단계 제공
  const lastLabel = (p: { label: string }) => p.label.split('·').pop()!.trim();
  const durP = isVid ? mod?.params.find((p) => /^(float\s*\(|int\s*\()?\s*(duration|길이|seconds?)\s*\)?$/i.test(lastLabel(p))) : undefined;
  const fpsP = isVid ? mod?.params.find((p) => /^(frame ?rate|fps)/i.test(lastLabel(p)) || p.label === 'FPS') : undefined;
  const framesP = isVid && !durP ? mod?.params.find((p) => p.label === '프레임 수') : undefined;
  const vidFam = /seedance/i.test(mod?.id + ' ' + mod?.name) ? 'seedance' : /ltx/i.test(mod?.id + ' ' + mod?.name) ? 'ltx' : /wan/i.test(mod?.id + ' ' + mod?.name) ? 'wan' : /minimax/i.test(mod?.id + ' ' + mod?.name) ? 'minimax' : 'other';
  const DUR = { ltx: { opts: [3, 5, 8, 10], max: 10, label: 'LTX-2.5' }, wan: { opts: [2, 3, 4, 5], max: 5, label: 'Wan' }, minimax: { opts: [3, 5, 8, 10, 15], max: 15, label: 'MiniMax H3' }, seedance: { opts: [4, 5, 8, 10, 15], max: 15, label: 'Seedance 2.0' }, other: { opts: [2, 3, 5, 8], max: 10, label: '이 모델' } }[vidFam];
  // 빠른 모드 (Lightning/Turbo LoRA 스위치가 워크플로우에 있을 때)
  const fastP = mod?.params.find((p) => p.type === 'bool' && /빠른 모드/.test(p.label));
  const fastOn = fastP ? !!(modParams[fastP.key] ?? fastP.default) : false;
  const fpsVal = Number(fpsP ? (modParams[fpsP.key] ?? fpsP.default) : 24) || 24;
  const durVal: number = durP ? Number(modParams[durP.key] ?? durP.default) || 5 : framesP ? Math.round(((Number(modParams[framesP.key] ?? framesP.default) || 1) / fpsVal) * 10) / 10 : 0;
  const setDur = (sec: number) => {
    const v = Math.max(durP?.min ?? 1, Math.min(DUR.max, sec));
    if (durP) setParam(durP.key, durP.type === 'int' ? Math.round(v) : v);
    else if (framesP) setParam(framesP.key, vidFam === 'wan' ? Math.round((v * fpsVal) / 4) * 4 + 1 : Math.round(v * fpsVal) + 1);
  };
  // 작업량 = 길이 × 화소. 어텐션 비용이 비선형이고 12GB를 넘으면 시스템 RAM으로 넘쳐서 급격히 느려짐 (실측: 5초·960×544 ≈ 85초, 10초·1280×1280 ≈ 25분+)
  const vidLoad = (durVal / 5) * ((size.w * size.h) / (960 * 544));
  const estSec = isVid && !paid && (durP || framesP) ? Math.round(85 * Math.pow(Math.max(vidLoad, 0.2), 1.6)) : 0;
  // 기획 문장이나 모듈이 바뀌었는데 예전 확장 프롬프트가 남아 있으면 쓰지 않음 (직접 쓴 확장 프롬프트는 finalFor가 없어서 유지)
  const finalStale = !!f.finalPrompt.trim() && f.finalFor !== f.brief.trim() + '|' + (mod?.id ?? '');
  const lsKeys = isVid ? (mod?.params ?? []).filter((p) => /첫 프레임 고정|프레임 가이드|입력 이미지 압축/.test(p.label)).map((p) => p.key) : [];
  const canLabelSafe = lsKeys.length > 0;
  const labelSafe = canLabelSafe && f.labelSafe !== false;
  /** 제출할 때 해상도 관련 노드 값을 이 선택으로 덮어씀 */
  const sizeParams = (): Record<string, any> => {
    const o: Record<string, any> = {};
    if (rsAspect) { const opt = rsAspect.options!.find((x) => x.startsWith(f.ratio + ' ')); if (opt) o[rsAspect.key] = opt; }
    if (rsMp) o[rsMp.key] = Math.min(16, Math.max(0.1, Math.round((size.w * size.h) / 1e4) / 100));
    if (pW && pH) { o[pW.key] = size.w; o[pH.key] = size.h; }
    if (tierP) { const want = longSide <= 960 ? '480p' : longSide <= 1400 ? '720p' : longSide < 3840 ? '1080p' : '4k'; o[tierP.key] = tierP.options!.includes(want) ? want : tierP.options![0]; }
    if (ratioP) o[ratioP.key] = ratioP.options!.includes(f.ratio) ? f.ratio : 'adaptive';
    return o;
  };
  useEffect(() => { setRefs((r) => (mod ? mod.images.map((_, i) => r[i] ?? null) : [])); }, [mod?.id, mod?.images.length]);
  // 다른 화면에서 "이 컷으로 영상 만들기"로 넘어온 경우
  useEffect(() => {
    const h = ctx.handoff;
    if (!h || kind !== 'video') return;
    const target = modules.find((m) => m.id === h.moduleId);
    set({ moduleId: h.moduleId });
    setRefs((target?.images ?? [null]).map((_, i) => h.refs[i] ?? null));
    toast(h.note);
    ctx.clearHandoff();
  }, [ctx.handoff]); // eslint-disable-line


  // 이 탭(이미지/영상)에 해당하는 작업만
  const myJobs = useMemo(() => ctx.jobs.filter((j) => {
    // 실제로 나온 결과물 종류가 우선 (모듈 파일이 나중에 바뀌어도 피드가 섞이지 않게)
    const made = j.items.flatMap((it) => it.attempts).filter((a) => a.file);
    const m = modules.find((x) => x.id === j.moduleId);
    const video = made.length ? made.some((a) => a.kind === 'video') : m ? isVideoModule(m) : false;
    return kind === 'video' ? video : !video;
  }), [ctx.jobs, modules, kind]);
  const session = useMemo(() => {
    const done = myJobs.filter((j) => j.status === 'done');
    const items = done.flatMap((j) => (j.qc.enabled ? j.items : [])).filter((i) => i.status === 'passed' || i.status === 'failed');
    const first = items.filter((i) => i.attempts[0]?.status === 'passed').length;
    const fin = items.filter((i) => i.status === 'passed').length;
    const times = done.flatMap((j) => j.items.map((i) => i.totalSec ?? 0)).filter(Boolean);
    return {
      cuts: done.reduce((s, j) => s + j.items.length, 0),
      first: items.length ? first / items.length : null,
      final: items.length ? fin / items.length : null,
      avg: times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : null,
      blocked: done.reduce((s, j) => s + j.items.reduce((t, i) => t + i.attempts.filter((a) => a.status === 'failed').length, 0), 0),
    };
  }, [myJobs]);

  /** 여러 장을 한 번에: 시작 칸부터 빈 칸을 차례로 채움 (한 칸에 놓으면 그 칸을 교체) */
  const onFiles = async (files: File[], startSlot: number, replace = false) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length || !mod) return;
    const total = mod.images.length;
    const targets: number[] = [];
    let cur = refs.slice();
    if (replace) targets.push(startSlot);
    for (let i = startSlot; targets.length < imgs.length && i < total; i++) if (!cur[i] && !targets.includes(i)) targets.push(i);
    for (let i = 0; targets.length < imgs.length && i < startSlot; i++) if (!cur[i] && !targets.includes(i)) targets.push(i);
    if (targets.length < imgs.length) toast(`칸이 ${total}개라 ${imgs.length - targets.length}장은 넣지 못했어요`);
    setBusy('upload');
    for (let k = 0; k < targets.length; k++) {
      const file = imgs[k];
      try {
        const data = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(file); });
        const { name } = await api('/api/upload', { name: file.name, data });
        const slot = targets[k];
        setRefs((r) => { const n = r.slice(); n[slot] = { name, preview: data }; return n; });
      } catch (e: any) { toast('업로드 실패: ' + e.message); }
    }
    setBusy('');
  };
  const [dragOver, setDragOver] = useState<number | 'all' | null>(null);

  const enhance = async () => {
    if (!f.brief.trim()) return setErr('먼저 만들고 싶은 장면을 적어 주세요');
    setBusy('enhance'); setErr('');
    try {
      const r = await api('/api/enhance', { brief: f.brief, toneId: f.toneId, hasRefs: refs.some(Boolean), moduleId: mod?.id, qcProfile: kind === 'image' ? f.qcProfile : undefined });
      set({ finalPrompt: r.positive, finalFor: f.brief.trim() + '|' + (mod?.id ?? '') });
      toast(`프롬프트 확장 완료 · ${r.sec.toFixed(1)}초`);
    } catch (e: any) { setErr(e.message); }
    setBusy('');
  };

  const submit = async () => {
    if (!mod) return;
    setBusy('submit'); setErr('');
    try {
      const params: Record<string, any> = {};
      for (const p of mod.params) if (modParams[p.key] !== undefined && modParams[p.key] !== p.default) params[p.key] = modParams[p.key];
      if (hasSize) Object.assign(params, sizeParams());
      await api('/api/jobs', {
        moduleId: mod.id,
        kind,
        brief: f.brief,
        toneId: f.toneId || undefined,
        enhance: f.enhance,
        initialPrompt: f.enhance && f.finalPrompt.trim() && !finalStale ? f.finalPrompt : undefined,
        motion: mod.prompt2 ? f.motion : undefined,
        labelSafe: labelSafe || undefined,
        count: f.count,
        width: mod.size ? f.width : undefined,
        height: mod.size ? f.height : undefined,
        seedMode: f.seedMode,
        seed: f.seed,
        lora: f.loraName && mod.lora.mode !== 'none' ? { name: f.loraName, strength: f.loraStrength } : null,
        images: refs.map((r) => r?.name ?? null),
        params,
        qc: { enabled: f.qcEnabled, passScore: f.passScore, maxAttempts: f.maxAttempts },
        qcProfile: kind === 'image' ? f.qcProfile ?? 'default' : 'default',
      });
    } catch (e: any) { setErr(e.message); }
    setBusy('');
  };

  const needRefs = mod && mod.images.length > 0 && !refs.some(Boolean);
  // 유료 모델: 이 설정으로 생성할 때 예상 차감 크레딧 (설정이 바뀌면 0.4초 뒤 다시 계산)
  const [est, setEst] = useState<{ perRun: number | null; total: number | null } | null>(null);
  const refCount = refs.filter(Boolean).length;
  const estKey = paid ? JSON.stringify([mod?.id, f.ratio, f.tier, durVal, modParams, refCount, f.count]) : '';
  useEffect(() => {
    if (!paid || !mod) { setEst(null); return; }
    const t = setTimeout(() => {
      const params: Record<string, any> = {};
      for (const p of mod.params) if (modParams[p.key] !== undefined && modParams[p.key] !== p.default) params[p.key] = modParams[p.key];
      if (hasSize) Object.assign(params, sizeParams());
      api('/api/credits/estimate', { moduleId: mod.id, ratio: f.ratio, long: longSide, duration: durVal || undefined, params, images: refCount || mod.images.length, count: f.count })
        .then((r) => setEst(r.paid ? { perRun: r.perRun, total: r.total } : null)).catch(() => setEst(null));
    }, 400);
    return () => clearTimeout(t);
  }, [estKey]); // eslint-disable-line
  const bal = ctx.credits?.configured && !ctx.credits.error ? ctx.credits.credits : undefined;
  const maxTries = f.qcEnabled ? f.maxAttempts : 1;

  const notReadyMods = modules.filter((m) => !m.ready && ofKind(m));

  return (
    <div className="main">
      <aside className="left">
        <div>
          <div className="sec-label">파이프라인 (모듈) <button className="link" onClick={() => ctx.goto('settings')}>모듈 관리</button></div>
          {ready.length ? (
            <select className="select" value={mod?.id} onChange={(e) => set({ moduleId: e.target.value })}>
              {ready.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              {notReadyMods.map((m) => <option key={m.id} disabled>{m.name} — 준비 필요</option>)}
            </select>
          ) : (
            <div className="warnbox">{kind === 'video'
              ? '영상 모듈이 아직 없어요. ComfyUI에서 LTX-2.5 (T2V / I2V / Elements) 워크플로우를 한 번 Run 한 뒤 [모듈 · 설정] → 가져오기로 붙여 주세요.'
              : '이미지 모듈이 없어요. [모듈 · 설정]에서 ComfyUI 최근 실행을 가져오거나 Export (API) 파일을 넣어 주세요.'}</div>
          )}
          {mod?.description && <div className="small muted" style={{ marginTop: 6, lineHeight: 1.5 }}>{mod.description}</div>}
        </div>

        <div>
          <div className="sec-label">프롬프트
            <label className="tlabel" onClick={() => set({ enhance: !f.enhance })}><span className={'toggle' + (f.enhance ? ' on' : '')} />LLM 확장</label>
          </div>
          <textarea className="input" placeholder={kind === 'video' ? (mod?.prompt2 ? '예) 스튜디오에서 image 2 인물이 image 1 제품을 들고 서 있는 첫 장면, 미디엄샷' : '예) 창가 테이블 위 세라믹 머그컵, 김이 천천히 피어오르고 카메라가 다가감') : '예) 따뜻한 카페 창가에 놓인 흰색 세라믹 머그컵, 상세페이지 메인컷'} value={f.brief} onChange={(e) => set({ brief: e.target.value })} />
          {f.enhance && (
            <div style={{ marginTop: 8 }}>
              <div className="sec-label" style={{ marginBottom: 5 }}>
                <span>{f.finalPrompt && !finalStale ? '확장된 프롬프트 (수정 가능 · 이 내용으로 생성)' : '생성할 때 LLM이 영어 프롬프트로 확장해요'}</span>
                <span className="row">
                  {f.finalPrompt && <button className="link" onClick={() => set({ finalPrompt: '' })}>지우기</button>}
                  <button className="link" disabled={busy !== ''} onClick={enhance}>{busy === 'enhance' ? '확장 중…' : '미리 확장해보기'}</button>
                </span>
              </div>
              {f.finalPrompt && finalStale && <div className="small" style={{ color: 'var(--warn)', margin: '2px 0' }}>기획 문장(또는 모듈)이 바뀌어서 아래 확장 프롬프트는 쓰지 않아요. 생성할 때 새로 확장하거나 [미리 확장해보기]를 다시 눌러 주세요.</div>}
              {f.finalPrompt && <textarea className="input final" style={finalStale ? { opacity: 0.45 } : undefined} value={f.finalPrompt} onChange={(e) => set({ finalPrompt: e.target.value, finalFor: f.brief.trim() + '|' + (mod?.id ?? '') })} />}
            </div>
          )}
        </div>

        {mod?.prompt2 && (
          <div>
            <div className="sec-label">영상 움직임 · 카메라 <span>{f.enhance ? 'LLM이 영어 모션 프롬프트로 확장' : '그대로 사용'}</span></div>
            <textarea className="input" style={{ minHeight: 64 }} placeholder="예) 인물이 제품을 카메라 쪽으로 천천히 들어 올리고, 카메라는 제품 클로즈업으로 다가감" value={f.motion ?? ''} onChange={(e) => set({ motion: e.target.value })} />
          </div>
        )}

        {settings && (
          <div>
            <div className="sec-label">브랜드 톤</div>
            <div className="chips">
              <button className={'pill' + (!f.toneId ? ' on' : '')} onClick={() => set({ toneId: '' })}>없음</button>
              {settings.tones.map((t) => <button key={t.id} title={t.text} className={'pill' + (f.toneId === t.id ? ' on' : '')} onClick={() => set({ toneId: t.id })}>{t.label}</button>)}
            </div>
          </div>
        )}

        {mod && mod.images.length > 0 && (
          <div
            onDragOver={(e) => { e.preventDefault(); if (dragOver === null) setDragOver('all'); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(null); }}
            onDrop={(e) => { e.preventDefault(); setDragOver(null); onFiles(Array.from(e.dataTransfer.files), 0); }}>
            <div className="sec-label">
              {mod.images.length > 1 ? `레퍼런스 이미지 (최대 ${mod.images.length}장)` : '시작 이미지'}
              <span className="row">
                {busy === 'upload' ? '올리는 중…' : <>{refs.filter(Boolean).length}/{mod.images.length}</>}
                <button className="link" onClick={() => { uploadSlot.current = -1; fileInput.current?.click(); }}>{mod.images.length > 1 ? '여러 장 추가' : '파일 선택'}</button>
                {refs.some(Boolean) && <button className="link" onClick={() => setRefs(mod.images.map(() => null))}>비우기</button>}
              </span>
            </div>
            <div className={'refgrid' + (dragOver === 'all' ? ' drag' : '')}>
              {mod.images.map((b, i) => (
                <div key={i} title={`${b.label}${mod.images.length > 1 ? ` (프롬프트에서 image ${i + 1})` : ''}\n클릭: 파일 선택 · 끌어다 놓기: 이 칸에 넣기`}
                  className={'rslot' + (refs[i] ? ' has' : '') + (dragOver === i ? ' over' : '')}
                  style={refs[i] ? { backgroundImage: `url("${refs[i]!.preview}")` } : undefined}
                  onClick={() => { uploadSlot.current = i; fileInput.current?.click(); }}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(i); }}
                  onDragLeave={() => setDragOver('all')}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(null); onFiles(Array.from(e.dataTransfer.files), i, true); }}>
                  {!refs[i] && <span className="n">{i + 1}</span>}
                  {refs[i] && <span className="x" onClick={(e) => { e.stopPropagation(); setRefs((r) => { const n = r.slice(); n[i] = null; return n; }); }}>✕</span>}
                </div>
              ))}
            </div>
            <div className="small muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
              {mod.images.length > 1
                ? <>이미지를 여기로 끌어다 놓거나 칸을 클릭하세요. 칸 번호 = 프롬프트의 <b>image 번호</b> ({mod.images.slice(0, 2).map((b, i) => `${i + 1}: ${b.label.replace(/^@?Element \d+\s*·?\s*/, '') || b.label}`).join(', ')}…). 1번만 필수예요.</>
                : '이미지를 끌어다 놓거나 칸을 클릭하세요. 상품 사진은 원본 그대로 사용돼요.'}
            </div>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              const slot = uploadSlot.current;
              if (files.length) slot < 0 ? onFiles(files, 0) : onFiles(files, slot, files.length === 1);
              e.target.value = '';
            }} />
          </div>
        )}

        {mod && mod.lora.mode !== 'none' && (
          <div>
            <div className="sec-label">LoRA <button className="link" onClick={() => ctx.refreshLoras().then(() => toast('LoRA 목록을 새로 불러왔어요'))}>목록 새로고침</button></div>
            <div className="lora">
              {loraTarget && <div className="small muted" style={{ marginBottom: 2 }}>적용 대상: <b>{loraTarget.label}</b>{loraTarget.stage ? ` (${loraTarget.stage})` : ''}</div>}
              <select className="select" value={f.loraName} onChange={(e) => pickLora(e.target.value)}>
                <option value="">사용 안 함</option>
                {loraGroups.ok.length > 0 && <optgroup label={`${loraTarget?.label ?? '이 모델'}용`}>{loraGroups.ok.map((l) => <option key={l} value={l}>{l.replace(/\.safetensors$/, '')}</option>)}</optgroup>}
                {loraGroups.unknown.length > 0 && <optgroup label="모델 표시 없음 (확인 필요)">{loraGroups.unknown.map((l) => <option key={l} value={l}>{l.replace(/\.safetensors$/, '')}</option>)}</optgroup>}
                {loraGroups.bad.length > 0 && <optgroup label="다른 모델용 — 이 모듈엔 효과 없음">{loraGroups.bad.map((l) => <option key={l} value={l} disabled>{l.replace(/\.safetensors$/, '')} · {loraFamily(l)?.label}용</option>)}</optgroup>}
              </select>
              {f.loraName && (
                <div className="row"><span className="small muted" style={{ width: 34 }}>강도</span>
                  <input type="range" min={0} max={1.5} step={0.05} value={f.loraStrength} onChange={(e) => pickLora(f.loraName, Number(e.target.value))} />
                  <span className="val">{f.loraStrength.toFixed(2)}</span>
                </div>
              )}
              {f.loraName && !loraTarget?.family && /minimax|wan|ltx|hunyuan|video|fl2v|i2v/i.test(f.loraName) && <div className="small" style={{ color: 'var(--warn)' }}>영상 모델용 LoRA로 보여요. 모듈의 모델과 맞지 않으면 효과가 없어요.</div>}
            </div>
          </div>
        )}

        {mod && hasSize && (
          <div>
            <div className="sec-label">비율 · 해상도 <span>{size.w}×{size.h}</span></div>
            <div className="chips">
              {ratios.map(([l]) => <button key={l} className={'pill' + (f.ratio === l ? ' on' : '')} onClick={() => set({ ratio: l })}>{l}</button>)}
            </div>
            <div className="chips" style={{ marginTop: 6 }}>
              {TIERS.filter(([t]) => isVid || !t.endsWith('p')).map(([t, px]) => <button key={t} className={'pill' + (f.tier === t ? ' on' : '')} title={`긴 변 ${px}px`} onClick={() => set({ tier: t })}>{t === '1K' && isVid ? '720p·1K' : t}</button>)}
            </div>
            {tierWarn && <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>{tierWarn}</div>}
            {mod.keyframe && <div className="small muted" style={{ marginTop: 4 }}>키프레임과 영상이 같은 비율·해상도로 만들어져요.</div>}
          </div>
        )}

        {mod && fastP && (
          <label className="between" style={{ cursor: 'pointer', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 10 }} onClick={(e) => { e.preventDefault(); setParam(fastP.key, !fastOn); }}>
            <span><b style={{ fontSize: 13 }}>빠른 모드 (Lightning LoRA)</b><br /><span className="small muted">스텝을 크게 줄여 2~4배 빠르게 · 디테일은 조금 떨어질 수 있어요</span></span>
            <span className={'toggle' + (fastOn ? ' on' : '')} />
          </label>
        )}

        {mod && canLabelSafe && (
          <label className="between" style={{ cursor: 'pointer', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 10 }} onClick={(e) => { e.preventDefault(); set({ labelSafe: !labelSafe }); }}>
            <span><b style={{ fontSize: 13 }}>라벨·로고 보존 모드</b><br /><span className="small muted">첫 프레임 완전 고정 · 입력 압축 낮춤 · 제품 회전 없는 카메라 무빙</span></span>
            <span className={'toggle' + (labelSafe ? ' on' : '')} />
          </label>
        )}

        {mod && isVid && (durP || framesP) && (
          <div>
            <div className="sec-label">영상 길이 <span>{durVal}초 · {fpsVal}fps · {DUR.label} 최대 {DUR.max}초</span></div>
            <div className="chips" style={{ alignItems: 'center' }}>
              {DUR.opts.map((t) => <button key={t} className={'pill' + (durVal === t ? ' on' : '')} onClick={() => setDur(t)}>{t}초</button>)}
              <input className="input" type="number" min={1} max={DUR.max} step={durP?.type === 'int' ? 1 : 0.5} value={durVal} onChange={(e) => setDur(Number(e.target.value) || 1)} style={{ width: 64, padding: '5px 8px' }} />
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              예상 생성 시간(영상 단계, RTX 3080 기준 대략): {estSec >= 60 ? `${Math.floor(estSec / 60)}분 ${estSec % 60}초` : `${estSec}초`}
              {vidLoad > 3 ? <b style={{ color: 'var(--warn)' }}> · 12GB VRAM을 넘어 시스템 메모리로 넘칠 수 있는 설정이에요 (수십 분). 16:9·9:16 1K에 5초를 추천해요.</b> : durVal > 5 && vidFam === 'ltx' ? ' · 5초보다 길면 시간·VRAM 사용이 크게 늘고, 동작이 반복되거나 흐트러질 수 있어요.' : ''}
            </div>
          </div>
        )}

        <div className="grid3">
          <div className="field"><small>장수</small><input type="number" min={1} max={8} value={f.count} onChange={(e) => set({ count: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} /></div>
          <div className="field"><small>시드</small>
            <select value={f.seedMode} onChange={(e) => set({ seedMode: e.target.value as any })}><option value="random">랜덤</option><option value="fixed">고정</option></select>
          </div>
          <div className="field" style={{ opacity: f.seedMode === 'fixed' ? 1 : 0.45 }}><small>시드 값</small><input type="number" disabled={f.seedMode !== 'fixed'} value={f.seed} onChange={(e) => set({ seed: Number(e.target.value) || 0 })} /></div>
        </div>

        <div className="qc">
          <div className="between">
            <h4>자동 검수 · 실패 시 재생성</h4>
            <label className="tlabel" onClick={() => set({ qcEnabled: !f.qcEnabled })}><span className={'toggle' + (f.qcEnabled ? ' on' : '')} /></label>
          </div>
          {f.qcEnabled ? (
            <>
              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="field"><small>통과 점수 (0~10)</small><input type="number" min={1} max={10} value={f.passScore} onChange={(e) => set({ passScore: Number(e.target.value) || 7 })} /></div>
                <div className="field"><small>최대 시도</small><input type="number" min={1} max={6} value={f.maxAttempts} onChange={(e) => set({ maxAttempts: Number(e.target.value) || 3 })} /></div>
              </div>
              {kind === 'image' && (
                <div className="field" style={{ marginTop: 8 }}><small>에셋 종류 (작성·검수 규칙)</small>
                  <select value={f.qcProfile ?? 'default'} onChange={(e) => set({ qcProfile: e.target.value as any })}>
                    <option value="default">일반 (상품·연출컷)</option>
                    <option value="character_sheet">캐릭터 시트 — 회색 배경 3열, 눈·크롭·대칭 검사</option>
                    <option value="location">로케이션 — 3/4 시점·앵커·광원·깊이감 검사</option>
                  </select>
                </div>
              )}
              <div className="checks">{Object.entries(DEFECT_LABEL).filter(([k]) => (k !== 'sheet_rule' || f.qcProfile === 'character_sheet') && (k !== 'location_rule' || f.qcProfile === 'location') && (kind === 'video' || k !== 'motion_artifact')).map(([k, d]) => <span key={k}>{d}</span>)}</div>
              <div className="small muted" style={{ marginTop: 8, lineHeight: 1.5 }}>기획 불일치·톤·글자·요청 외 변경 → 프롬프트 수정 후 재생성 / 그 외 → 시드만 바꿔 재생성{kind === 'video' ? ' / 영상은 원인 진단: 원본 문제면 원본부터, 움직임 문제면 움직임 문장만 고쳐요' : ''}</div>
            </>
          ) : <div className="small muted" style={{ marginTop: 6 }}>검수 없이 생성만 해요.</div>}
        </div>

        {mod && mod.params.length > 0 && (
          <details className="adv">
            <summary><span>고급 설정 (노드 값)</span><span className="muted">{Object.keys(modParams).filter((k) => mod.params.find((p) => p.key === k && p.default !== modParams[k])).length || ''} 변경 ▾</span></summary>
            <div className="body">
              {mod.params.filter((p) => !(hasSize && [rsAspect?.key, rsMp?.key, pW?.key, pH?.key].includes(p.key)) && ![durP?.key, fpsP?.key, framesP?.key].includes(p.key) && !(labelSafe && lsKeys.includes(p.key)) && p.key !== fastP?.key).map((p) => {
                const v = modParams[p.key] ?? p.default;
                return (
                  <div className="field" key={p.key} style={p.type === 'text' ? { gridColumn: 'span 2' } : undefined}>
                    <small title={`노드 ${p.node} · ${p.input}`}>{p.label}</small>
                    {p.type === 'bool' ? (
                      <select value={String(v)} onChange={(e) => setParam(p.key, e.target.value === 'true')}><option value="false">끔</option><option value="true">켬</option></select>
                    ) : p.type === 'select' && p.options ? (
                      <select value={v} onChange={(e) => setParam(p.key, e.target.value)}>{p.options.map((o) => <option key={o}>{o}</option>)}</select>
                    ) : p.type === 'int' || p.type === 'float' ? (
                      <input type="number" step={p.step ?? (p.type === 'int' ? 1 : 0.1)} min={p.min} max={p.max} value={v}
                        onChange={(e) => setParam(p.key, p.type === 'int' ? parseInt(e.target.value || '0') : parseFloat(e.target.value || '0'))} />
                    ) : (
                      <input value={v ?? ''} onChange={(e) => setParam(p.key, e.target.value)} />
                    )}
                  </div>
                );
              })}
              <button className="link" style={{ gridColumn: 'span 2', textAlign: 'left' }} onClick={() => mod && set({ params: { ...f.params, [mod.id]: {} } })}>워크플로우 기본값으로</button>
            </div>
          </details>
        )}

        {err && <div className="err">{err}</div>}
        {status && !status.comfy.ok && <div className="warnbox">ComfyUI에 연결되지 않았어요. ComfyUI Desktop을 켜 주세요.</div>}

        {paid && (
          <div className={'costbox' + (bal !== undefined && est?.total != null && est.total * maxTries > bal ? ' over' : '')}>
            {!ctx.credits?.configured ? <span>유료 모델이에요. [모듈·설정]에 Comfy API 키를 넣어야 생성할 수 있어요.</span> : (
              <>
                <div className="cost-row"><span>예상 차감</span><b>{est?.total != null ? `약 ${fmtCr(est.total)} 크레딧` : est ? '계산 불가' : '계산 중…'}</b></div>
                {est?.total != null && maxTries > 1 && <div className="cost-row sub"><span>검수 재시도 포함 최대</span><span>{fmtCr(est.total * maxTries)} 크레딧</span></div>}
                <div className="cost-row sub"><span>현재 잔액</span><span>{bal !== undefined ? `${fmtCr(bal)} 크레딧` : ctx.credits.error ?? '확인 중…'}</span></div>
                {bal !== undefined && est?.total != null && (
                  <div className="cost-row"><span>생성 후 예상 잔액</span><b>{fmtCr(bal - est.total)}{maxTries > 1 ? ` ~ ${fmtCr(Math.max(0, bal - est.total * maxTries))}` : ''} 크레딧</b></div>
                )}
                {bal !== undefined && est?.total != null && est.total * maxTries > bal && <div className="cost-warn">재시도까지 가면 잔액이 모자랄 수 있어요. 장수나 최대 시도를 줄여 주세요.</div>}
              </>
            )}
          </div>
        )}
        <div className="actions">
          <button className="btn primary" disabled={!mod || busy === 'submit' || !!needRefs || (!f.brief.trim() && !f.finalPrompt.trim())} onClick={submit}>
            {needRefs ? '레퍼런스 이미지를 넣어 주세요' : busy === 'submit' ? '등록 중…' : `생성 시작 · ${f.count}장`}
          </button>
          <button className="btn ghost" onClick={() => { set({ brief: '', finalPrompt: '' }); setErr(''); }}>초기화</button>
        </div>
      </aside>

      <section className="right">
        <div className="runbar">
          <div>
            <h2>{kind === 'video' ? '영상' : '이미지'} 작업 피드</h2>
            <div className="meta">생성 → 자동 검수 → 실패 시 재생성까지 자동으로 진행돼요. 이미지를 누르면 상세 보기.</div>
          </div>
          <div className="stats">
            <div className="stat"><small>생성 컷</small><b>{session.cuts}<em>장</em></b></div>
            <div className="stat"><small>첫 시도 통과율</small><b>{pct(session.first)}<em>%</em></b></div>
            <div className="stat"><small>최종 통과율</small><b>{pct(session.final)}<em>%</em></b></div>
            <div className="stat"><small>컷당 평균</small><b style={{ fontSize: session.avg && session.avg >= 60 ? 14 : 17 }}>{fmtSec(session.avg)}</b></div>
            <div className="stat"><small>검수가 막은 불량</small><b>{session.blocked}<em>건</em></b></div>
          </div>
        </div>
        <div className="feed">
          {myJobs.length === 0 && <div className="empty"><b>아직 {kind === 'video' ? '영상' : '이미지'} 작업이 없어요</b>왼쪽에 만들고 싶은 장면을 적고 [생성 시작]을 눌러 보세요.</div>}
          {myJobs.slice(0, 30).map((j) => <JobCard key={j.id} job={j} onOpen={(job, item, attempt) => setOpen({ job, item, attempt })} onCancel={(id) => api(`/api/jobs/${id}/cancel`, {})}
            onDelete={async (job) => {
              const n = job.items.reduce((s, it) => s + it.attempts.filter((a) => a.file).length, 0);
              if (!window.confirm(`"${job.brief.slice(0, 30) || job.moduleName}" 작업을 지울까요?\n결과 ${n}개 파일과 기록이 함께 삭제되고 되돌릴 수 없어요.`)) return;
              try { const r = await api(`/api/jobs/${job.id}`, undefined, 'DELETE'); toast(`작업을 삭제했어요 (파일 ${r.removed}개)`); if (open?.job.id === job.id) setOpen(null); }
              catch (e: any) { toast(e.message); }
            }} />)}
        </div>
      </section>

      {open && (() => {
        const job = ctx.jobs.find((j) => j.id === open.job.id) ?? open.job;
        const item = job.items[open.item.index];
        return (
          <div className="modal-bg" onClick={() => setOpen(null)}>
            <div className="modal" style={{ width: 'min(760px,94vw)', maxHeight: '94vh' }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-h"><b>상세 보기</b><button className="link" onClick={() => setOpen(null)}>닫기 ✕</button></div>
              <div className="modal-b"><ItemDetail job={job} item={item} initialAttempt={open.attempt} toast={toast} onSendToVideo={(f) => { setOpen(null); ctx.sendToVideo(f); }} /></div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
