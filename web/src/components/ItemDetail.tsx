import { useEffect, useState } from 'react';
import { api, DEFECT_LABEL, Item, Job, fileUrl, fmtSec, isVideo, itemBadge, retryLabel } from '../api';
import Media from './Media';
import { TimeBar, TimeLegend } from './JobCard';

export default function ItemDetail({ job, item, initialAttempt, toast, onSendToVideo }: { job: Job; item: Item; initialAttempt?: number; toast: (m: string) => void; onSendToVideo?: (file: string) => void }) {
  const [sel, setSel] = useState<number>(initialAttempt ?? item.final ?? item.attempts.length - 1);
  useEffect(() => { setSel(initialAttempt ?? item.final ?? item.attempts.length - 1); }, [job.id, item.index, initialAttempt]); // eslint-disable-line
  const a = item.attempts[sel] ?? item.attempts[item.attempts.length - 1];
  const badge = itemBadge(job, item);
  // 사람 판정은 지금 보고 있는 시도에만 (예전 기록은 최종 시도에 항목 판정이 붙어 있음)
  const humanOf = (i: number) => item.attempts[i]?.human ?? (i === item.final ? item.human : undefined);
  const label = async (value: 'accept' | 'reject') => {
    try { await api(`/api/jobs/${job.id}/items/${item.index}/human`, { value: humanOf(sel) === value ? null : value, attempt: sel }); }
    catch (e: any) { toast(e.message); }
  };
  if (!a) return null;
  const h = humanOf(sel);
  const judged = a.status === 'passed' || a.status === 'failed';
  return (
    <>
      <div className="between">
        <b style={{ fontSize: 14 }}>#{item.index + 1} · {job.moduleName}</b>
        <span className={'tag ' + badge.cls}>{badge.text}</span>
      </div>
      <div className="big" style={{ aspectRatio: `${a.width ?? 1} / ${a.height ?? 1}`, maxWidth: `calc(66vh * ${(a.width ?? 1) / (a.height ?? 1)})` }}>
        {a.file && (isVideo(a.file)
          ? <Media file={a.file} poster={a.poster} controls />
          : <a href={fileUrl(a.file)} target="_blank" rel="noreferrer"><img src={fileUrl(a.file)} alt="" /></a>)}
      </div>
      {item.attempts.length > 1 && (
        <div className="tries" style={{ flexWrap: 'wrap' }}>
          {item.attempts.map((x, i) => (
            <div key={i} className={'try ' + (x.status === 'passed' ? 'pass' : x.status === 'failed' ? 'fail' : '') + (i === sel ? ' cur' : '')}
              style={{ backgroundImage: x.file ? `url("${fileUrl(isVideo(x.file) ? x.poster : x.file)}")` : undefined, width: 44, height: 54 }} onClick={() => setSel(i)}>
              <span>{x.score ?? '-'}</span>
              {humanOf(i) && <i className={'th ' + humanOf(i)}>{humanOf(i) === 'accept' ? '✓' : '✕'}</i>}
            </div>
          ))}
        </div>
      )}
      <div className="reason" style={{ fontSize: 12 }}>
        <b style={{ color: a.status === 'passed' ? 'var(--pass)' : undefined }}>시도 {a.n} · {a.status === 'passed' ? `통과 ${a.score}점` : a.status === 'failed' ? `탈락 ${a.score}점` : a.status === 'unchecked' ? '미검수' : a.status === 'done' ? '검수 끔' : a.status}</b>
        {a.stage === 'rule' && <span className="muted"> (규칙 검수)</span>}
        {a.stage === 'keyframe' && <span className="muted"> (키프레임 단계에서 탈락 — 영상은 만들지 않음)</span>}
        {a.keyframe && a.stage !== 'keyframe' && <span className="muted"> · 키프레임 통과{a.keyframeScore !== undefined ? ` ${a.keyframeScore}점` : ''}</span>}
        {a.defects?.length ? <> · {a.defects.map((d) => DEFECT_LABEL[d] ?? d).join(', ')}</> : null}
        {a.reason && <div style={{ marginTop: 3 }}>{a.reason}</div>}
        {a.retryStrategy && <div className="muted" style={{ marginTop: 3 }}>→ 다음 시도: {retryLabel(a)}</div>}
      </div>
      {a.keyframe && a.kind === 'video' && (
        <a className="small" href={fileUrl(a.keyframe)} target="_blank" rel="noreferrer" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <img src={fileUrl(a.keyframe)} alt="" style={{ width: 64, height: 40, objectFit: 'cover', borderRadius: 4 }} /> 이 영상의 키프레임(첫 프레임) 보기
        </a>
      )}
      <div className="kv2">
        <div><small>시드</small><b>{a.seed}</b></div>
        <div><small>{a.kind === 'video' ? '해상도 · 길이' : '해상도'}</small><b>{a.width && a.height ? `${a.width}×${a.height}` : '-'}{a.kind === 'video' && a.duration ? ` · ${a.duration.toFixed(1)}초${a.fps ? ` ${Math.round(a.fps)}fps` : ''}${a.hasAudio ? ' · 오디오' : ''}` : ''}</b></div>
        <div><small>LoRA</small><b title={job.lora?.name}>{job.lora?.name ? `${job.lora.name.replace(/\.safetensors$/, '')} · ${job.lora.strength}` : '없음'}</b></div>
        <div><small>톤</small><b>{job.toneLabel || '없음'}</b></div>
        <div><small>검수 모델</small><b title={job.llmModel}>{job.qc.enabled ? job.llmModel.split('/').pop() : '검수 끔'}</b></div>
        <div><small>이 컷 총 소요</small><b>{fmtSec(item.totalSec)}</b></div>
      </div>
      <div>
        <div className="sec-label">프롬프트 <span>{a.promptSource === 'llm' ? 'LLM 확장' : a.promptSource === 'llm-retry' ? 'LLM 재작성 (검수 피드백 반영)' : a.promptSource === 'preview' ? '미리보기에서 확정' : '직접 입력'}</span>
          <button className="link" onClick={() => { navigator.clipboard?.writeText(a.prompt); toast('프롬프트를 복사했어요'); }}>복사</button>
        </div>
        <div className="prompt-box">{a.prompt}</div>
        {a.motionPrompt && <><div className="sec-label" style={{ marginTop: 8 }}>영상 움직임 프롬프트</div><div className="prompt-box">{a.motionPrompt}</div></>}
      </div>
      <div>
        <TimeBar attempts={item.attempts} />
        <div style={{ marginTop: 6 }}><TimeLegend /></div>
      </div>
      {judged && (
        <div className="judge">
          <div className="judge-h">
            <span>시도 {a.n} — 내 판단</span>
            <span className="muted">AI 검수: <b style={{ color: a.status === 'passed' ? 'var(--pass)' : 'var(--fail)' }}>{a.status === 'passed' ? '통과' : '탈락'}</b></span>
          </div>
          <div className="grid2">
            <button className={'btn sm ' + (h === 'accept' ? 'ok' : 'ghost')} onClick={() => label('accept')}>✓ 쓸 만함</button>
            <button className={'btn sm ' + (h === 'reject' ? 'no' : 'ghost')} onClick={() => label('reject')}>✕ 못 씀</button>
          </div>
          {h && <div className={'judge-r ' + ((h === 'accept') === (a.status === 'passed') ? 'ok' : 'no')}>{(h === 'accept') === (a.status === 'passed') ? 'AI 판정과 일치' : `AI 판정과 불일치 — AI는 ${a.status === 'passed' ? '통과' : '탈락'}시켰어요`}</div>}
        </div>
      )}
      <div className="grid2" style={{ marginTop: 'auto' }}>
        <button className="btn ghost sm" onClick={() => api('/api/open-folder', { path: item.sortedFile ?? a.file }).catch((e) => toast(e.message))}>폴더 열기</button>
        <a className="btn ghost sm" href={fileUrl(a.file)} target="_blank" rel="noreferrer">원본 보기</a>
        {onSendToVideo && a.kind !== 'video' && a.file && <button className="btn sm" style={{ gridColumn: 'span 2', border: '1px solid var(--accent-line)', background: 'var(--accent-weak)', color: 'var(--accent)', fontWeight: 600 }} onClick={() => onSendToVideo(a.file!)}>이 컷으로 영상 만들기 →</button>}
      </div>
      <div className="small muted" style={{ lineHeight: 1.5 }}>내 판단은 위에서 고른 시도 하나에만 적용돼요. AI 검수 판정과 비교해 [기록 · 통계]의 검수 신뢰도가 계산돼요.</div>
    </>
  );
}
