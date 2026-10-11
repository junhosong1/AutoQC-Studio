import { Attempt, DEFECT_LABEL, Item, Job, fileUrl, fmtSec, isVideo, itemBadge, retryLabel, fmtCr } from '../api';
import Media from './Media';

const T_COLORS = { prompt: '#8fb0f2', swap: '#c9cfda', gen: '#1f56d6', qc: '#13915a' };

export function TimeBar({ attempts }: { attempts: Attempt[] }) {
  const sum = { prompt: 0, swap: 0, gen: 0, qc: 0 };
  for (const a of attempts) for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += a.times[k] ?? 0;
  const total = Object.values(sum).reduce((s, x) => s + x, 0);
  if (!total) return null;
  return (
    <div title={`프롬프트 ${sum.prompt.toFixed(1)}초 · VRAM 교대 ${sum.swap.toFixed(1)}초 · 생성 ${sum.gen.toFixed(1)}초 · 검수 ${sum.qc.toFixed(1)}초`}>
      <div className="times">{(Object.keys(sum) as (keyof typeof sum)[]).map((k) => sum[k] > 0 && <i key={k} style={{ width: `${(sum[k] / total) * 100}%`, background: T_COLORS[k] }} />)}</div>
    </div>
  );
}

export function TimeLegend() {
  return (
    <div className="legend">
      <span><i style={{ background: T_COLORS.prompt }} />프롬프트</span>
      <span><i style={{ background: T_COLORS.swap }} />VRAM 교대</span>
      <span><i style={{ background: T_COLORS.gen }} />생성</span>
      <span><i style={{ background: T_COLORS.qc }} />검수</span>
    </div>
  );
}

const fin = (it: Item) => (it.final !== undefined ? it.attempts[it.final] : undefined);

function ItemCard({ job, it, onOpen }: { job: Job; it: Item; onOpen: (it: Item, attempt?: number) => void }) {
  const badge = itemBadge(job, it);
  const last = it.attempts[it.attempts.length - 1];
  const shown = it.final !== undefined ? it.attempts[it.final] : [...it.attempts].reverse().find((a) => a.file);
  const ratio = job.width && job.height ? `${job.width} / ${job.height}` : shown?.width && shown?.height ? `${shown.width} / ${shown.height}` : '4 / 5';
  const busy = it.status === 'running' && last && !['passed', 'failed', 'done', 'unchecked'].includes(last.status);
  const lastFail = [...it.attempts].reverse().find((a) => a.status === 'failed');
  const failNote = it.status === 'passed' ? lastFail : [...it.attempts].reverse().find((a) => a.status === 'failed' || a.status === 'unchecked' || a.status === 'error' || a.reason);
  const passNote = it.status === 'passed' && fin(it);
  return (
    <div className="card">
      <div className="img" style={{ aspectRatio: ratio }} onClick={() => shown?.file && onOpen(it)}>
        {busy && last?.keyframe && last.phase === 'video'
          ? <Media file={last.keyframe} style={{ opacity: 0.45 }} />
          : shown?.file && <Media file={shown.file} poster={shown.poster} style={busy ? { opacity: 0.35 } : undefined} />}
        {shown?.kind === 'video' && !busy && <span className="vtag">▶ {shown.duration ? shown.duration.toFixed(1) + '초' : '영상'}{shown.hasAudio ? ' · 오디오' : ''}</span>}
        {busy && (
          <div className="ph">
            <div>
              {last.status === 'prompting' ? 'LLM이 프롬프트 작성 중' : last.status === 'reviewing' ? (last.phase === 'keyframe' ? 'LLM이 키프레임 검수 중' : 'LLM이 검수 중') : last.progress > 0 ? `${last.phase === 'keyframe' ? '① 키프레임 생성 중' : last.phase === 'video' ? '② 영상 생성 중' : 'ComfyUI 생성 중'} ${Math.round(last.progress * 100)}%` : last.phase === 'video' ? '② 영상 준비 중 (키프레임 통과)' : 'ComfyUI 준비 중 (모델 불러오는 중)'}
              {last.status === 'generating' && <div className="bar"><i style={{ width: `${Math.round(last.progress * 100)}%` }} /></div>}
            </div>
          </div>
        )}
        {it.status === 'queued' && <div className="ph">대기 중</div>}
        <span className={'badge ' + badge.cls}>{badge.text}</span>
        {it.human && <span className={'human ' + it.human}>{it.human === 'accept' ? '✓' : '✕'}</span>}
      </div>
      {it.attempts.length > 0 && (
        <div className="info">
          {it.attempts.length > 1 && (
            <div className="tries">
              {it.attempts.map((a, i) => (
                <div key={i} className={'try ' + (a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : '') + (i === it.final ? ' cur' : '')}
                  style={{ backgroundImage: a.file ? `url("${fileUrl(isVideo(a.file) ? a.poster : a.file)}")` : undefined }} onClick={() => a.file && onOpen(it, i)} title={`시도 ${a.n} · ${a.reason ?? ''}`}>
                  <span>{a.score ?? (a.status === 'generating' ? '…' : '')}</span>
                </div>
              ))}
            </div>
          )}
          {passNote && !failNote && passNote.reason && <div className="reason">{passNote.reason}</div>}
          {failNote?.reason && (
            <div className="reason">
              {it.status === 'passed' && <span className="muted">시도 {failNote.n} 탈락 · </span>}
              {failNote.defects?.length ? <b>{failNote.defects.map((d) => DEFECT_LABEL[d] ?? d).join(' · ')}</b> : null}
              {failNote.defects?.length ? ' — ' : ''}{failNote.reason}
              {failNote.retryStrategy && <span className="muted"> → {retryLabel(failNote, true)}로 재생성</span>}
            </div>
          )}
          {last?.error && <div className="reason"><b>오류</b> — {last.error}</div>}
          <TimeBar attempts={it.attempts} />
          {it.totalSec !== undefined && <div className="between small muted"><span>시드 {shown?.seed}</span><span>{fmtSec(it.totalSec)}</span></div>}
        </div>
      )}
    </div>
  );
}

export default function JobCard({ job, onOpen, onCancel, onDelete }: { job: Job; onOpen: (job: Job, it: Item, attempt?: number) => void; onCancel: (id: string) => void; onDelete?: (job: Job) => void }) {
  const passed = job.items.filter((i) => i.status === 'passed').length;
  const failed = job.items.filter((i) => i.status === 'failed').length;
  const tries = job.items.reduce((s, i) => s + i.attempts.length, 0);
  const time = new Date(job.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="job">
      <div className="job-h">
        <div className="t">
          <b>{job.brief || '(직접 입력한 프롬프트)'}</b>
          <small>
            {time} · {job.moduleName} · {job.items.length}장{job.toneLabel ? ` · ${job.toneLabel}` : ''}{job.lora?.name ? ` · LoRA ${job.lora.name.replace(/\.safetensors$/, '')} ${job.lora.strength}` : ''}
            {job.qc.enabled ? ` · 검수 ${job.qc.passScore}점↑ 최대 ${job.qc.maxAttempts}회` : ' · 검수 끔'}
            {job.credits?.spent !== undefined ? <span className="cr"> · 크레딧 −{fmtCr(job.credits.spent)} (잔액 {fmtCr(job.credits.after ?? 0)})</span>
              : job.credits?.before !== undefined && job.status === 'running' ? <span className="cr"> · 시작 잔액 {fmtCr(job.credits.before)} 크레딧</span> : null}
          </small>
        </div>
        {job.status === 'running' && <span className="tag run">진행 중 · 시도 {tries}회</span>}
        {job.status === 'queued' && <span className="tag gray">대기</span>}
        {job.status === 'done' && job.qc.enabled && <span className={'tag ' + (failed ? 'warn' : 'pass')}>통과 {passed}/{job.items.length} · 시도 {tries}회</span>}
        {job.status === 'done' && !job.qc.enabled && <span className="tag gray">완료</span>}
        {job.status === 'error' && <span className="tag fail" title={job.error}>오류</span>}
        {job.status === 'canceled' && <span className="tag gray">취소됨</span>}
        {(job.status === 'running' || job.status === 'queued') && <button className="btn ghost sm" onClick={() => onCancel(job.id)}>취소</button>}
        {onDelete && job.status !== 'running' && job.status !== 'queued' && (
          <button className="xdel" title="이 작업의 이미지·영상과 기록 삭제" onClick={() => onDelete(job)}>✕</button>
        )}
      </div>
      {job.status === 'error' && job.error && <div style={{ padding: '10px 16px 0' }}><div className="err">{job.error}</div></div>}
      <div className="items">
        {job.items.map((it) => <ItemCard key={it.index} job={job} it={it} onOpen={(i, a) => onOpen(job, i, a)} />)}
      </div>
    </div>
  );
}
