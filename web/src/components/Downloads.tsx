import { useEffect, useState } from 'react';
import type { AppCtx } from '../App';
import { api, Download, Preset, fmtBytes } from '../api';

function Row({ d }: { d: Download }) {
  const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : d.status === 'done' ? 100 : 0;
  const state = {
    queued: '대기', downloading: `${pct.toFixed(0)}% · ${fmtBytes(d.speed)}/s`, done: '완료', exists: '이미 있음', error: '실패', canceled: '취소',
  }[d.status];
  return (
    <div className="dl-row">
      <div style={{ minWidth: 0 }}>
        <b>{d.label || d.filename}</b>
        <small title={d.filename}>{d.folder}/{d.filename}</small>
        {d.error && <small style={{ color: 'var(--fail)', whiteSpace: 'normal' }}>{d.error}</small>}
      </div>
      <span className="small muted">{fmtBytes(d.received)}{d.total ? ` / ${fmtBytes(d.total)}` : ''}</span>
      <div>
        <div className={'pbar' + (d.status === 'done' || d.status === 'exists' ? ' done' : d.status === 'error' ? ' err' : '')}><i style={{ width: `${d.status === 'exists' ? 100 : pct}%` }} /></div>
        <small className="muted" style={{ fontSize: 11 }}>{state}</small>
      </div>
      {(d.status === 'downloading' || d.status === 'queued') ? <button className="link" onClick={() => api(`/api/downloads/${d.id}/cancel`, {})}>취소</button> : <span />}
    </div>
  );
}

export default function Downloads({ ctx }: { ctx: AppCtx }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [modelsDir, setModelsDir] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Record<string, { size: number | null; error?: string }>>({});
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('loras');
  const [busy, setBusy] = useState(false);

  const load = () => api('/api/downloads').then((r) => { setPresets(r.presets); setFolders(r.folders); setModelsDir(r.modelsDir); });
  useEffect(() => { load().catch(() => {}); }, [ctx.settings?.hfToken, ctx.settings?.modelsDir]);

  const check = async (p: Preset) => {
    setBusy(true);
    try {
      const r = await api('/api/downloads/probe', { urls: p.files.map((f) => f.url) });
      const next = { ...sizes };
      p.files.forEach((f, i) => (next[f.url] = r.results[i]));
      setSizes(next);
    } catch (e: any) { ctx.toast(e.message); }
    setBusy(false);
  };
  const start = async (p: Preset, withOptional: boolean) => {
    try {
      await api('/api/downloads', { items: p.files.filter((f) => withOptional || !f.optional).map((f) => ({ url: f.url, folder: f.folder, label: f.label })) });
      ctx.toast('다운로드를 시작했어요. 이 화면을 닫아도 계속 받아요.');
    } catch (e: any) { ctx.toast(e.message); }
  };
  const addUrl = async () => {
    if (!url.trim()) return;
    try {
      const pr = await api('/api/downloads/probe', { url });
      if (!pr.results[0].ok) { ctx.toast(pr.results[0].error); return; }
      await api('/api/downloads', { url, folder });
      setUrl('');
      ctx.toast(`${pr.results[0].filename} (${fmtBytes(pr.results[0].size)}) 받는 중`);
    } catch (e: any) { ctx.toast(e.message); }
  };

  const total = (p: Preset, opt: boolean) => p.files.filter((f) => opt || !f.optional).reduce((s, f) => s + (sizes[f.url]?.size ?? 0), 0);

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3>모델 다운로드 <span>저장 위치: {modelsDir ?? '찾지 못함 — 아래 설정에서 models 폴더를 지정해 주세요'}</span></h3>
      {!ctx.settings?.hfToken && <div className="warnbox">라이선스 동의가 필요한 모델(LTX-2.5 등)은 Hugging Face에서 동의한 뒤, 아래 [연결] 설정에 HF 토큰을 넣고 저장해야 받아져요.</div>}
      {presets.map((p) => (
        <div className="dl" key={p.id}>
          <div className="between">
            <div>
              <b style={{ fontSize: 14 }}>{p.name}</b> {p.gated && <span className="tag warn">동의 필요</span>}
              <div className="small muted" style={{ marginTop: 3, lineHeight: 1.5 }}>{p.description}</div>
              <div className="small muted">{p.license}</div>
            </div>
            <div className="row">
              <button className="btn ghost sm" disabled={busy} onClick={() => check(p)}>{busy ? '확인 중…' : '용량·권한 확인'}</button>
              <button className="btn primary sm" onClick={() => start(p, false)}>필수 파일 받기</button>
            </div>
          </div>
          {p.files.map((f) => (
            <div className="dl-row" key={f.url} style={{ gridTemplateColumns: '1fr 90px 210px' }}>
              <div style={{ minWidth: 0 }}><b>{f.label}</b><small>{f.folder}/{decodeURIComponent(f.url.split('/').pop() ?? '')}</small></div>
              <span className="small muted">{fmtBytes(sizes[f.url]?.size)}</span>
              <span className="small" style={{ color: sizes[f.url]?.error ? 'var(--fail)' : 'var(--mute)' }}>{sizes[f.url]?.error ?? (f.optional ? '선택' : sizes[f.url] ? '받을 수 있음' : '')}</span>
            </div>
          ))}
          {Object.keys(sizes).length > 0 && <div className="small muted">필수 합계 약 {fmtBytes(total(p, false))} · 선택 포함 {fmtBytes(total(p, true))} <button className="link" onClick={() => start(p, true)}>선택 파일까지 받기</button></div>}
        </div>
      ))}

      <div className="dl">
        <b style={{ fontSize: 13 }}>링크로 받기 (LoRA 등)</b>
        <div className="small muted">Hugging Face 파일 주소나 Civitai 모델 주소를 붙여넣으세요. 받은 LoRA는 [이미지 생성] → LoRA 목록에 바로 나타나요.</div>
        <div className="row">
          <input className="input" placeholder="https://huggingface.co/.../xxx.safetensors" value={url} onChange={(e) => setUrl(e.target.value)} />
          <select className="select" style={{ width: 170 }} value={folder} onChange={(e) => setFolder(e.target.value)}>{folders.map((f) => <option key={f}>{f}</option>)}</select>
          <button className="btn primary sm" onClick={addUrl}>받기</button>
        </div>
      </div>

      {ctx.downloads.length > 0 && (
        <div className="dl">
          <b style={{ fontSize: 13 }}>받는 중 · 기록</b>
          {ctx.downloads.map((d) => <Row key={d.id} d={d} />)}
        </div>
      )}
    </div>
  );
}
