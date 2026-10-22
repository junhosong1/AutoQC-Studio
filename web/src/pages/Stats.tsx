import { useEffect, useState } from 'react';
import type { AppCtx } from '../App';
import { api, DEFECT_LABEL, fmtSec, pct } from '../api';

export default function Stats({ ctx }: { ctx: AppCtx }) {
  const [s, setS] = useState<any>(null);
  const [view, setView] = useState<'image' | 'video' | 'all'>('image');
  const finishedCount = ctx.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued').length;
  const labeledCount = ctx.jobs.reduce((n, j) => n + j.items.filter((i) => i.human).length, 0);
  useEffect(() => { api('/api/stats').then(setS).catch(() => {}); }, [finishedCount, labeledCount]);
  if (!s) return <div className="page"><div className="empty">불러오는 중…</div></div>;

  const I = s.byKind?.image ?? s, V = s.byKind?.video ?? null;
  const cur = view === 'all' ? s : view === 'video' ? V ?? s : I;
  const maxDefect = Math.max(1, ...Object.values<number>(cur.defects));
  const timeRows: [string, number | null, string][] = [
    ['프롬프트 확장 (LLM)', cur.avgPromptSec, '#8fb0f2'],
    ['VRAM 교대', cur.avgSwapSec, '#c9cfda'],
    [view === 'video' ? '영상 생성 (ComfyUI)' : view === 'image' ? '이미지 생성 (ComfyUI)' : '생성 (ComfyUI)', cur.avgGenSec, '#1f56d6'],
    ['검수 (규칙 + LLM)', cur.avgQcSec, '#13915a'],
  ];
  const two = (a: any, b: any) => (
    <div className="kpi2"><span><i>이미지</i><b>{a}</b></span><span><i>영상</i><b>{b}</b></span></div>
  );
  const pc = (x: number | null) => (x === null || x === undefined ? '-' : <>{pct(x)}<em>%</em></>);
  const modules = Object.entries<any>(s.byModule).filter(([, b]) => view === 'all' || (b.kind ?? 'image') === view).sort((a, b) => (a[1].kind ?? '').localeCompare(b[1].kind ?? ''));
  const maxT = Math.max(1, ...timeRows.map((r) => r[1] ?? 0));

  return (
    <div className="page">
      <div className="between">
        <div>
          <h2 style={{ fontSize: 17 }}>기록 · 통계</h2>
          <div className="small muted" style={{ marginTop: 3 }}>지금까지 완료된 작업 {s.jobs}개 · 최종 컷 {s.items}장 · 총 생성 시도 {s.attempts}회</div>
        </div>
        <div className="row">
          <button className="btn ghost sm" onClick={() => api('/api/open-folder', { path: '' }).catch((e) => ctx.toast(e.message))}>결과 폴더 열기</button>
          <a className="btn primary sm" href="/api/report.md">리포트 다운로드 (.md)</a>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><small>첫 시도 통과율</small>{two(pc(I.firstPassRate), V ? pc(V.firstPassRate) : '-')}<p>재생성 없이 바로 통과한 비율</p></div>
        <div className="kpi"><small>최종 통과율</small>{two(pc(I.finalPassRate), V ? pc(V.finalPassRate) : '-')}<p>자동 재생성까지 포함한 통과 비율</p></div>
        <div className="kpi"><small>평균 시도 횟수</small>{two(<>{I.avgAttempts ?? '-'}<em>회</em></>, <>{V?.avgAttempts ?? '-'}<em>회</em></>)}<p>통과·실패까지 걸린 생성 횟수</p></div>
        <div className="kpi"><small>컷당 평균 소요</small>{two(fmtSec(I.avgItemSec), fmtSec(V?.avgItemSec ?? null))}<p>중앙값 이미지 {fmtSec(I.medianItemSec ?? null)} · 영상 {fmtSec(V?.medianItemSec ?? null)}</p></div>
        <div className="kpi"><small>검수가 막은 불량</small><b>{s.blocked}<em>건</em></b><p>규칙 {s.ruleFails} · LLM {s.llmFails}</p></div>
        <div className="kpi"><small>검수 신뢰도</small><b>{pct(s.human.agreement)}<em>%</em></b><p>사람 판정 {s.human.labeled}건 대비 일치율</p></div>
      </div>

      <div className="between">
        <div className="small muted">아래 결함·단계별 시간·모듈 표는 선택한 종류 기준이에요. 이미지 {I.items}컷 · 영상 {V?.items ?? 0}컷</div>
        <div className="seg" style={{ width: 240 }}>
          <button className={view === 'image' ? 'on' : ''} onClick={() => setView('image')}>이미지</button>
          <button className={view === 'video' ? 'on' : ''} onClick={() => setView('video')}>영상</button>
          <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>전체</button>
        </div>
      </div>

      <div className="cols2">
        <div className="panel">
          <h3>결함 유형별 탈락 <span>LLM이 고른 결함 코드 기준</span></h3>
          <div className="bars">
            {Object.entries<number>(cur.defects).filter(([k, v]) => v > 0 || ['off_brief', 'product_distortion', 'anatomy', 'text_artifact', 'low_quality', 'brand_tone'].includes(k) || (view !== 'image' && k === 'motion_artifact')).map(([k, v]) => (
              <div className="barrow" key={k}>
                <span>{DEFECT_LABEL[k] ?? k} <code>{k}</code></span>
                <div className="track"><i style={{ width: `${(v / maxDefect) * 100}%`, background: v ? 'var(--fail)' : 'transparent' }} /></div>
                <b style={{ textAlign: 'right' }}>{v}</b>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h3>단계별 평균 시간 <span>병목 확인용</span></h3>
          <div className="bars">
            {timeRows.map(([l, v, c]) => (
              <div className="barrow" key={l}>
                <span>{l}</span>
                <div className="track"><i style={{ width: `${((v ?? 0) / maxT) * 100}%`, background: c }} /></div>
                <b style={{ textAlign: 'right' }}>{v ?? '-'}{v !== null ? '초' : ''}</b>
              </div>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 14, lineHeight: 1.6 }}>
            재시도 전략: 프롬프트 재작성 <b>{cur.promptRetries}</b>회 · 시드만 변경 <b>{cur.seedRetries}</b>회{view !== 'image' ? <> · 움직임 문장 수정 <b>{cur.motionRetries ?? 0}</b>회 · 원본 문제로 중단 <b>{cur.sourceStops ?? 0}</b>회</> : null}<br />
            검수 오판: 잘못 통과 <b>{s.human.falsePass}</b>건 · 잘못 탈락 <b>{s.human.falseFail}</b>건 (갤러리에서 채택/반려를 누르면 쌓여요)
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>모듈별 결과</h3>
        <table className="tbl">
          <thead><tr><th>모듈</th><th>종류</th><th>최종 컷</th><th>통과</th><th>통과율</th><th>컷당 평균</th></tr></thead>
          <tbody>
            {modules.map(([id, b]) => (
              <tr key={id}><td><b>{b.name}</b> <span className="muted small">{id}</span></td><td>{b.kind === 'video' ? '영상' : '이미지'}</td><td>{b.items}</td><td>{b.passed}</td><td>{b.items ? Math.round((b.passed / b.items) * 100) : 0}%</td><td>{fmtSec(b.avgSec)}</td></tr>
            ))}
            {!modules.length && <tr><td colSpan={6} className="muted">아직 기록이 없어요</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
