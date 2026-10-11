// 상품 배치 모드 — 상품 사진 여러 장 × 컷 구성(레시피) → 상품별 이미지·영상 세트를 자동 생산·검수·정리
import { useEffect, useMemo, useState } from 'react';
import type { AppCtx } from '../App';
import { api, fileUrl, isVideo, ModuleDef, fmtCr } from '../api';

export interface BatchStep {
  label: string; moduleId: string; brief: string; count: number; ratio: string; long: number; duration?: number;
  source: 'product' | number; motion?: string; labelSafe?: boolean; fast?: boolean;
}
interface Product { name: string; features: string; images: string[]; previews: string[] }
export interface BatchCell { p: number; s: number; status: string; jobId?: string; files: string[]; note?: string; sec?: number }
export interface Batch { id: string; name: string; createdAt: number; finishedAt?: number; products: { name: string; features: string; images: string[] }[]; steps: BatchStep[]; status: string; cells: BatchCell[]; outDir: string; error?: string }

const RATIOS = ['1:1', '4:5', '3:4', '9:16', '16:9', '3:2'];
const LONGS: [string, number][] = [['480p', 832], ['540p', 960], ['1K', 1280], ['2K', 2048]];
const ST: Record<string, [string, string]> = {
  waiting: ['대기', 'gray'], running: ['진행 중', 'run'], passed: ['통과', 'pass'], partial: ['일부 통과', 'warn'],
  failed: ['실패', 'fail'], skipped: ['건너뜀', 'gray'], error: ['오류', 'fail'], canceled: ['취소', 'gray'],
};

function defaultSteps(mods: ModuleDef[]): BatchStep[] {
  const ready = mods.filter((m) => m.ready);
  const edit = ready.find((m) => m.id === 'qwen_edit') ?? ready.find((m) => m.category === 'edit') ?? ready.find((m) => m.category !== 'video');
  const vid = ready.find((m) => m.id === 'ltx25_i2v') ?? ready.find((m) => m.id === 'minimax_h3_i2v') ?? ready.find((m) => m.category === 'video' && m.images.length === 1);
  const steps: BatchStep[] = [];
  if (edit) {
    steps.push({ label: '대표컷', moduleId: edit.id, brief: '{상품명} 상세페이지 대표컷. 순백 배경, 제품 정면, 부드러운 스튜디오 조명, 라벨과 로고가 선명하게', count: 1, ratio: '1:1', long: 1280, source: 'product' });
    steps.push({ label: '연출컷', moduleId: edit.id, brief: '{상품명} — {특징}. 제품이 돋보이는 라이프스타일 연출컷, 자연광, 깔끔한 배경', count: 2, ratio: '4:5', long: 1280, source: 'product' });
  }
  if (vid) steps.push({ label: '숏폼', moduleId: vid.id, brief: '제품은 정면을 향해 고정, 카메라가 천천히 다가가고 빛이 부드럽게 흐름', count: 1, ratio: '9:16', long: 960, duration: 5, source: 0, labelSafe: true });
  return steps;
}

export default function BatchPage({ ctx }: { ctx: AppCtx }) {
  const { modules, settings, toast } = ctx;
  const [name, setName] = useState('신상품 콘텐츠 세트');
  const [products, setProducts] = useState<Product[]>([]);
  const [steps, setSteps] = useState<BatchStep[]>(() => { try { const s = JSON.parse(localStorage.getItem('aq.batch.steps') || 'null'); if (Array.isArray(s) && s.length) return s; } catch { /* */ } return []; });
  const [toneId, setToneId] = useState('');
  const [qc, setQc] = useState({ enabled: true, passScore: 7, maxAttempts: 3 });
  // 유료 모델이 들어간 컷: 상품 수 × 장수로 예상 크레딧 합계
  const [batchCost, setBatchCost] = useState<number | null>(null);
  const costKey = JSON.stringify([steps.map((s) => [s.moduleId, s.ratio, s.long, s.duration, s.count]), products.length]);
  useEffect(() => {
    const paidSteps = steps.filter((s) => ctx.modules.find((m) => m.id === s.moduleId)?.cost === 'paid');
    if (!paidSteps.length || !products.length) { setBatchCost(null); return; }
    const t = setTimeout(async () => {
      try {
        const rs = await Promise.all(paidSteps.map((s) => api('/api/credits/estimate', { moduleId: s.moduleId, ratio: s.ratio, long: s.long, duration: s.duration, images: 1, count: s.count })));
        setBatchCost(rs.some((r) => r.total == null) ? null : rs.reduce((a, r) => a + r.total, 0) * products.length);
      } catch { setBatchCost(null); }
    }, 400);
    return () => clearTimeout(t);
  }, [costKey]); // eslint-disable-line
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const batches: Batch[] = ctx.batches;

  useEffect(() => { if (!steps.length && modules.length) setSteps(defaultSteps(modules)); }, [modules.length]); // eslint-disable-line
  useEffect(() => { try { localStorage.setItem('aq.batch.steps', JSON.stringify(steps)); } catch { /* */ } }, [steps]);
  // 펼쳐 볼 배치: 고른 것 → 없으면 가장 최근 (나머지는 접힌 목록으로 남아 있음)
  const cur = useMemo(() => (sel === '__none__' ? undefined : batches.find((b) => b.id === sel) ?? batches[0]), [batches, sel]);

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setErr('');
    try {
      const added: Product[] = [];
      for (const file of list) {
        const data = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(file); });
        const { name: up } = await api('/api/upload', { name: file.name, data, product: true });
        added.push({ name: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), features: '', images: [up], previews: [data] });
      }
      setProducts((p) => [...p, ...added]);
    } catch (e: any) { setErr(e.message); }
  };
  // CSV/표 붙여넣기: "상품명, 특징" 한 줄에 하나 → 순서대로 이름·특징 채움
  const pasteTable = (text: string) => {
    const rows = text.split(/\r?\n/).map((l) => l.split(/\t|,/)).filter((r) => r[0]?.trim());
    setProducts((ps) => ps.map((p, i) => (rows[i] ? { ...p, name: rows[i][0].trim(), features: rows[i].slice(1).join(', ').trim() || p.features } : p)));
  };
  const upd = (i: number, v: Partial<Product>) => setProducts((ps) => ps.map((p, k) => (k === i ? { ...p, ...v } : p)));
  const updStep = (i: number, v: Partial<BatchStep>) => setSteps((ss) => ss.map((s, k) => (k === i ? { ...s, ...v } : s)));

  const total = products.length * steps.reduce((s, x) => s + (x.count || 1), 0);
  const start = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/api/batches', { name, products: products.map(({ previews, ...p }) => p), steps, toneId: toneId || undefined, qc });
      setSel(r.batch.id); toast(`배치를 시작했어요 · 상품 ${products.length}개 × 컷 ${steps.length}종`);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  const modOpts = (m: ModuleDef) => `${m.name}${m.category === 'video' ? ' (영상)' : ''}`;
  return (
    <div className="main">
      <aside className="left" style={{ gap: 14 }}>
        <div>
          <div className="sec-label">배치 이름</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <div className="sec-label">상품 <span>{products.length}개 · 사진 1장 = 상품 1개</span>
            {products.length > 0 && <button className="link" onClick={() => setProducts([])}>비우기</button>}
          </div>
          <label className="rslot" style={{ width: '100%', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '1px dashed var(--line)', borderRadius: 10 }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
            <span className="small muted">상품 사진들을 여기로 끌어다 놓거나 클릭해서 여러 장 선택</span>
            <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </label>
          {products.length > 0 && (
            <>
              <div style={{ display: 'grid', gap: 6, marginTop: 8, maxHeight: 260, overflow: 'auto' }}>
                {products.map((p, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px 1fr 26px', gap: 8, alignItems: 'center' }}>
                    <img src={p.previews[0]} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }} />
                    <div style={{ display: 'grid', gap: 3 }}>
                      <input className="input" style={{ padding: '4px 8px', fontSize: 12 }} value={p.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="상품명" />
                      <input className="input" style={{ padding: '4px 8px', fontSize: 12 }} value={p.features} onChange={(e) => upd(i, { features: e.target.value })} placeholder="특징 (예: 수분, 산뜻함, 민감피부)" />
                    </div>
                    <button className="xdel" onClick={() => setProducts((ps) => ps.filter((_, k) => k !== i))}>✕</button>
                  </div>
                ))}
              </div>
              <details style={{ marginTop: 6 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>표로 한 번에 입력 (엑셀에서 "상품명, 특징" 복사 → 붙여넣기)</summary>
                <textarea className="input" rows={3} placeholder={'히알루론 토너, 수분 · 산뜻함\n비타민 세럼, 브라이트닝'} onBlur={(e) => e.target.value.trim() && pasteTable(e.target.value)} />
              </details>
            </>
          )}
        </div>

        <div>
          <div className="sec-label">컷 구성 (상품마다 반복) <button className="link" onClick={() => setSteps(defaultSteps(modules))}>기본값</button></div>
          <div style={{ display: 'grid', gap: 8 }}>
            {steps.map((s, i) => {
              const m = modules.find((x) => x.id === s.moduleId);
              const vid = m?.category === 'video';
              return (
                <div key={i} className="stepcard">
                  <div className="row" style={{ gap: 6 }}>
                    <b className="stepno">{i + 1}</b>
                    <input className="input" style={{ padding: '4px 8px', fontSize: 12, width: 90 }} value={s.label} onChange={(e) => updStep(i, { label: e.target.value })} />
                    <select className="select" style={{ padding: '4px 6px', fontSize: 12, flex: 1 }} value={s.moduleId} onChange={(e) => updStep(i, { moduleId: e.target.value })}>
                      {modules.filter((x) => x.ready).map((x) => <option key={x.id} value={x.id}>{modOpts(x)}</option>)}
                    </select>
                    <button className="xdel" onClick={() => setSteps((ss) => ss.filter((_, k) => k !== i).map((x) => (typeof x.source === 'number' && x.source >= i ? { ...x, source: x.source === i ? 'product' : x.source - 1 } : x)))}>✕</button>
                  </div>
                  <textarea className="input" rows={2} style={{ fontSize: 12 }} value={s.brief} onChange={(e) => updStep(i, { brief: e.target.value })} placeholder="{상품명} {특징} 를 넣으면 상품마다 바뀌어요" />
                  {m?.prompt2 && <input className="input" style={{ fontSize: 12, padding: '4px 8px' }} value={s.motion ?? ''} onChange={(e) => updStep(i, { motion: e.target.value })} placeholder="영상 움직임 · 카메라" />}
                  <div className="stepopts">
                    {m && m.images.length > 0 && (
                      <select className="select" style={{ gridColumn: '1 / -1' }} value={String(s.source)} onChange={(e) => updStep(i, { source: e.target.value === 'product' ? 'product' : Number(e.target.value) })}>
                        <option value="product">참조: 상품 사진</option>
                        {steps.slice(0, i).map((x, k) => <option key={k} value={k}>시작: {k + 1}번 {x.label} 결과</option>)}
                      </select>
                    )}
                    <select className="select" value={s.ratio} onChange={(e) => updStep(i, { ratio: e.target.value })}>{RATIOS.map((r) => <option key={r}>{r}</option>)}</select>
                    <select className="select" value={s.long} onChange={(e) => updStep(i, { long: Number(e.target.value) })}>{LONGS.filter(([l]) => vid || !l.endsWith('p')).map(([l, v]) => <option key={l} value={v}>{l}</option>)}</select>
                    {vid ? <select className="select" value={s.duration ?? 5} onChange={(e) => updStep(i, { duration: Number(e.target.value) })}>{[3, 5, 8, 10].map((d) => <option key={d} value={d}>{d}초</option>)}</select> : <select className="select" disabled><option>길이 —</option></select>}
                    <select className="select" value={s.count} onChange={(e) => updStep(i, { count: Number(e.target.value) })}>{[1, 2, 3, 4].map((c) => <option key={c} value={c}>{c}개</option>)}</select>
                    <div className="stepchk">
                      {vid && <label className="small" style={{ display: 'flex', gap: 3, alignItems: 'center' }}><input type="checkbox" checked={s.labelSafe !== false} onChange={(e) => updStep(i, { labelSafe: e.target.checked })} />라벨 보존</label>}
                    {m?.params.some((p) => p.type === 'bool' && /빠른 모드/.test(p.label)) && <label className="small" style={{ display: 'flex', gap: 3, alignItems: 'center' }}><input type="checkbox" checked={!!s.fast} onChange={(e) => updStep(i, { fast: e.target.checked })} />빠른 모드</label>}
                    </div>
                  </div>
                </div>
              );
            })}
            <button className="btn ghost sm" onClick={() => setSteps((ss) => [...ss, { label: `컷 ${ss.length + 1}`, moduleId: modules.find((m) => m.ready)?.id ?? '', brief: '{상품명}', count: 1, ratio: '1:1', long: 1280, source: 'product' }])}>+ 컷 추가</button>
          </div>
        </div>

        {settings && (
          <div>
            <div className="sec-label">브랜드 톤</div>
            <div className="chips">
              <button className={'pill' + (!toneId ? ' on' : '')} onClick={() => setToneId('')}>없음</button>
              {settings.tones.map((t) => <button key={t.id} title={t.text} className={'pill' + (toneId === t.id ? ' on' : '')} onClick={() => setToneId(t.id)}>{t.label}</button>)}
            </div>
          </div>
        )}
        <div className="grid3">
          <label className="field"><small>자동 검수</small><select value={qc.enabled ? '1' : '0'} onChange={(e) => setQc({ ...qc, enabled: e.target.value === '1' })}><option value="1">켬</option><option value="0">끔</option></select></label>
          <label className="field"><small>통과 점수</small><input type="number" min={0} max={10} value={qc.passScore} onChange={(e) => setQc({ ...qc, passScore: Number(e.target.value) })} /></label>
          <label className="field"><small>최대 시도</small><input type="number" min={1} max={6} value={qc.maxAttempts} onChange={(e) => setQc({ ...qc, maxAttempts: Number(e.target.value) })} /></label>
        </div>
        {err && <div className="err">{err}</div>}
        {batchCost !== null && (() => {
          const bal = ctx.credits?.configured && !ctx.credits.error ? ctx.credits.credits : undefined;
          const tries = qc.enabled ? qc.maxAttempts : 1;
          return (
            <div className={'costbox' + (bal !== undefined && batchCost * tries > bal ? ' over' : '')}>
              <div className="cost-row"><span>유료 컷 예상 차감</span><b>약 {fmtCr(batchCost)} 크레딧</b></div>
              {tries > 1 && <div className="cost-row sub"><span>검수 재시도 포함 최대</span><span>{fmtCr(batchCost * tries)} 크레딧</span></div>}
              {bal !== undefined && <div className="cost-row sub"><span>현재 잔액</span><span>{fmtCr(bal)} 크레딧</span></div>}
              {bal !== undefined && <div className="cost-row"><span>배치 후 예상 잔액</span><b>{fmtCr(bal - batchCost)}{tries > 1 ? ` ~ ${fmtCr(Math.max(0, bal - batchCost * tries))}` : ''} 크레딧</b></div>}
            </div>
          );
        })()}
        <div className="actions" style={{ gridTemplateColumns: '1fr' }}>
          <button className="btn primary" disabled={busy || !products.length || !steps.length} onClick={start}>
            {busy ? '시작하는 중…' : !products.length ? '상품 사진을 넣어 주세요' : `배치 시작 · 결과 약 ${total}개`}
          </button>
        </div>
      </aside>

      <section className="right">
        <div className="runbar">
          <div>
            <h2>상품 배치</h2>
            <div className="meta">상품마다 컷 구성대로 생성 → 자동 검수·재생성 → 상품별 폴더 정리 → 요약 CSV</div>
          </div>
        </div>
        <div className="feed">
        {!batches.length && <div className="empty"><b>아직 배치가 없어요</b>왼쪽에 상품 사진을 넣고 컷 구성을 확인한 뒤 [배치 시작]을 눌러 보세요. 예) 상품 10개 × (대표컷 1 + 연출컷 2 + 숏폼 1) = 결과 40개</div>}
        {batches.slice(0, 30).map((b) => (
          <BatchView key={b.id} b={b} ctx={ctx} open={b.id === cur?.id} onToggle={() => setSel(b.id === cur?.id ? '__none__' : b.id)} />
        ))}
        </div>
      </section>
    </div>
  );
}

function BatchView({ b, ctx, open, onToggle }: { b: Batch; ctx: AppCtx; open: boolean; onToggle: () => void }) {
  const done = b.cells.filter((c) => !['waiting', 'running'].includes(c.status)).length;
  const passed = b.cells.filter((c) => c.status === 'passed').length;
  const sec = b.cells.reduce((s, c) => s + (c.sec ?? 0), 0);
  const job = (id?: string) => ctx.jobs.find((j) => j.id === id);
  return (
    <div className="job">
      <div className="job-h">
        <div className="t" style={{ cursor: 'pointer' }} onClick={onToggle} title={open ? '접기' : '펼치기'}>
          <b>{open ? '▾' : '▸'} {b.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {new Date(b.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></b>
          <small>상품 {b.products.length}개 × 컷 {b.steps.length}종 · 진행 {done}/{b.cells.length} · 통과 {passed} · 누적 {Math.floor(sec / 60)}분 {sec % 60}초</small>
        </div>
        <span className={'tag ' + (ST[b.status === 'done' ? 'passed' : b.status]?.[1] ?? 'gray')}>{b.status === 'running' ? '진행 중' : b.status === 'done' ? '완료' : b.status === 'canceled' ? '취소됨' : b.status === 'interrupted' ? '중단됨(재시작)' : '오류'}</span>
        {b.status === 'running' && <button className="btn ghost sm" onClick={() => api(`/api/batches/${b.id}/cancel`, {})}>취소</button>}
        <button className="btn ghost sm" onClick={() => api('/api/open-folder', { path: b.outDir }).catch((e) => ctx.toast(e.message))}>결과 폴더</button>
        <a className="btn ghost sm" href={`/api/batches/${b.id}/report.csv`}>요약 CSV</a>
        {b.status !== 'running' && (
          <button className="xdel" title="목록에서 지우기 (파일은 남김)" onClick={async () => {
            if (!window.confirm(`"${b.name}" 배치를 목록에서 지울까요?\n결과 폴더의 이미지·영상과 요약 CSV는 그대로 남아요.`)) return;
            try { await api(`/api/batches/${b.id}`, undefined, 'DELETE'); ctx.toast('배치를 목록에서 지웠어요 (파일은 그대로)'); } catch (e: any) { ctx.toast(e.message === 'Failed to fetch' ? 'AutoQC 서버에 연결할 수 없어요. start.bat 창을 확인해 주세요.' : e.message); }
          }}>✕</button>
        )}
      </div>
      {open && <>
      {b.error && <div style={{ padding: '8px 16px 0' }}><div className="err">{b.error}</div></div>}
      <div className="bgrid-wrap">
        {/* 고정 폭 그리드: 상품 열 230px + 컷 열 동일 폭. 같은 행의 칸은 높이가 자동으로 같아지고, 내용 길이와 무관하게 세로선이 맞음 */}
        <div className="bgrid" style={{ gridTemplateColumns: `230px repeat(${b.steps.length}, 212px)` }}>
          <div className="bh">상품</div>
          {b.steps.map((s, i) => (
            <div key={i} className="bh">
              <b>{i + 1}. {s.label}</b>
              <small>{ctx.modules.find((m) => m.id === s.moduleId)?.name ?? s.moduleId}</small>
            </div>
          ))}
          {b.products.map((p, pi) => [
            <div key={'p' + pi} className="bc bprod">
              {p.images[0]
                ? <img src={`/api/comfy/view?${new URLSearchParams({ filename: p.images[0], type: 'input', subfolder: '' })}`} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                : <i />}
              <div className="bprod-t"><b title={p.name}>{p.name}</b>{p.features && <small title={p.features}>{p.features}</small>}</div>
            </div>,
            ...b.steps.map((_, si) => {
              const c = b.cells.find((x) => x.p === pi && x.s === si)!;
              const j = job(c.jobId);
              const live = c.status === 'running' && j ? j.items.flatMap((it) => it.attempts).filter((a) => a.file || a.keyframe).pop() : undefined;
              const st = ST[c.status] ?? [c.status, 'gray'];
              return (
                <div key={pi + '-' + si} className="bc">
                  <span className={'tag ' + st[1]}>{st[0]}{c.status === 'running' && j ? ` · 시도 ${j.items.reduce((s, it) => s + it.attempts.length, 0)}` : ''}</span>
                  <div className="bthumbs">
                    {c.files.map((f) => (
                      <a key={f} href={fileUrl(f)} target="_blank" rel="noreferrer" title={f} className="bth">
                        {isVideo(f) ? <video src={fileUrl(f) + '#t=0.5'} preload="metadata" muted /> : <img src={fileUrl(f)} alt="" />}
                      </a>
                    ))}
                    {live && !c.files.length && <span className="bth live"><img src={fileUrl(live.file && !isVideo(live.file) ? live.file : live.keyframe ?? live.poster)} alt="" /></span>}
                    {!c.files.length && !live && <span className="bth bslot" />}
                  </div>
                  {c.note && <small className="bnote" title={c.note}>{c.note}</small>}
                </div>
              );
            }),
          ])}
        </div>
      </div>
      </>}
    </div>
  );
}
