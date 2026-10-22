// 단독 검수 — 생성 없이 이미 있는 이미지를 검수 규칙으로만 확인 (힉스필드 캐릭터 시트·로케이션 등)
import { useState } from 'react';
import type { AppCtx } from '../App';
import { api, DEFECT_LABEL } from '../api';

interface Row {
  key: string; name: string; preview: string; data: string;
  status: 'wait' | 'run' | 'done' | 'error';
  r?: { passed: boolean; score: number | null; defects: string[]; rule: { reason: string } | null; llm: { reason: string; score: number } | null; llmError: string | null; sec: number; width: number; height: number };
  error?: string;
}

const PROFILES = [
  { id: 'character_sheet', label: '캐릭터 시트', hint: '배경 #3a3a3c(픽셀 측정) · 초상 패널 크기·각도 · 홍채·캐치라이트 · 전신 패널 일치 · 비대칭 · 피부 질감 · 3D 렌더 느낌' },
  { id: 'location', label: '로케이션', hint: '노출 클리핑(픽셀 측정) · 단일 광원·그림자 방향 · 3/4 시점 · 앵커 오브젝트 · 깊이감 · 구조물·질감' },
  { id: 'default', label: '일반', hint: '기획 일치 · 제품·인물 동일성 · 인체 · 글자 · 슬롭 질감 · 구조 붕괴 · 톤' },
] as const;

export default function QcCheck({ ctx }: { ctx: AppCtx }) {
  const [profile, setProfile] = useState<'character_sheet' | 'location' | 'default'>('character_sheet');
  const [brief, setBrief] = useState('');
  const [toneId, setToneId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const addFiles = async (files: FileList) => {
    const add: Row[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const data = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(file); });
      add.push({ key: file.name + Date.now() + Math.random(), name: file.name, preview: URL.createObjectURL(file), data, status: 'wait' });
    }
    setRows((x) => [...x, ...add]);
  };
  const upd = (key: string, p: Partial<Row>) => setRows((x) => x.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const run = async () => {
    setBusy(true);
    for (const row of rows.filter((r) => r.status !== 'done')) {
      upd(row.key, { status: 'run', error: undefined });
      try {
        const r = await api('/api/qc/check', { data: row.data, profile, brief, toneId: toneId || undefined });
        upd(row.key, { status: 'done', r });
      } catch (e: any) { upd(row.key, { status: 'error', error: e.message }); }
    }
    setBusy(false);
  };

  const prof = PROFILES.find((p) => p.id === profile)!;
  return (
    <div className="main">
      <aside className="left" style={{ gap: 14 }}>
        <div>
          <div className="sec-label">검수 종류</div>
          <div className="seg">
            {PROFILES.map((p) => <button key={p.id} className={profile === p.id ? 'on' : ''} onClick={() => setProfile(p.id)}>{p.label}</button>)}
          </div>
          <div className="small muted" style={{ marginTop: 6, lineHeight: 1.5 }}>{prof.hint}</div>
        </div>
        <div>
          <div className="sec-label">이 이미지가 무엇이어야 하는지 (선택)</div>
          <textarea className="input" style={{ minHeight: 70 }} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={profile === 'character_sheet' ? '예: 심청 캐릭터 시트 — 10대 후반, 흰 저고리·연분홍 치마' : profile === 'location' ? '예: 인당수 바닷가 절벽, 새벽, 안개' : '예: 토너 상세페이지 대표컷'} />
        </div>
        <div>
          <div className="sec-label">브랜드 톤 (선택)</div>
          <select className="input" value={toneId} onChange={(e) => setToneId(e.target.value)}>
            <option value="">없음</option>
            {ctx.settings?.tones.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <div className="sec-label">이미지 <span>{rows.length}장</span>{rows.length > 0 && <button className="link" onClick={() => setRows([])}>비우기</button>}</div>
          <label className="rslot" style={{ width: '100%', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '1px dashed var(--line)', borderRadius: 10 }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
            <span className="small muted">이미지를 끌어다 놓거나 클릭해서 여러 장 선택</span>
            <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </label>
        </div>
        <div className="small muted" style={{ lineHeight: 1.5 }}>생성 없이 검수만 해요. 크레딧을 쓰지 않아요. 검수 LLM과 스킬 적용 방식은 [모듈 · 설정]을 따라요.</div>
        <div className="cta" style={{ position: 'sticky', bottom: 0, background: '#fff', padding: '10px 0 16px' }}>
          <button className="btn primary" style={{ width: '100%' }} disabled={busy || !rows.some((r) => r.status !== 'done')} onClick={run}>{busy ? '검수 중…' : `검수 시작 · ${rows.filter((r) => r.status !== 'done').length}장`}</button>
        </div>
      </aside>
      <section className="right qcpage" style={{ padding: 20, overflowY: 'auto' }}>
        <div className="sec-head"><h2>단독 검수</h2><div className="meta">힉스필드·다른 툴에서 만든 캐릭터 시트·로케이션도 같은 기준으로 점검해요.</div></div>
        {!rows.length && <div className="empty"><b>검수할 이미지를 넣어 주세요</b>캐릭터 시트는 Seedance에 넣기 전에, 로케이션은 캐릭터를 올리기 전에 확인하는 용도예요.</div>}
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          {rows.map((row) => (
            <div key={row.key} className="panel" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'start' }}>
              <img src={row.preview} alt="" style={{ width: 220, maxHeight: 220, objectFit: 'contain', borderRadius: 8, background: '#f0f2f5' }} />
              <div style={{ display: 'grid', gap: 8 }}>
                <div className="between">
                  <b style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</b>
                  {row.status === 'wait' && <span className="tag gray">대기</span>}
                  {row.status === 'run' && <span className="tag run">검수 중</span>}
                  {row.status === 'error' && <span className="tag fail">오류</span>}
                  {row.status === 'done' && row.r && <span className={'tag ' + (row.r.passed ? 'pass' : 'fail')}>{row.r.passed ? '통과' : '실패'}{row.r.score !== null ? ` · ${row.r.score}점` : ''}</span>}
                </div>
                {row.error && <div className="small" style={{ color: 'var(--fail)' }}>{row.error}</div>}
                {row.r && (
                  <>
                    {row.r.defects.length > 0 && <div className="checks">{row.r.defects.map((d) => <span key={d}>{DEFECT_LABEL[d] ?? d}</span>)}</div>}
                    {row.r.rule && <div className="small" style={{ color: 'var(--fail)' }}>규칙 검사: {row.r.rule.reason}</div>}
                    {row.r.llm && <div className="small">LLM 검수: {row.r.llm.reason}</div>}
                    {row.r.llmError && <div className="small" style={{ color: 'var(--warn)' }}>LLM 검수 실패: {row.r.llmError}</div>}
                    <div className="small muted">{row.r.width}×{row.r.height} · {row.r.sec.toFixed(1)}초</div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
