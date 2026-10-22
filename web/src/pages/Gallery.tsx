import { useMemo, useRef, useState } from 'react';
import type { AppCtx } from '../App';
import { DEFECT_LABEL, Item, Job, fileUrl, isVideo } from '../api';
import ItemDetail from '../components/ItemDetail';

type Filter = 'all' | 'passed' | 'failed' | 'unchecked' | 'accept' | 'reject';

function ratioLabel(w?: number, h?: number) {
  if (!w || !h) return '';
  const r = w / h;
  const known: [string, number][] = [['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['9:16', 0.5625], ['16:9', 1.778], ['3:2', 1.5], ['2:3', 0.667], ['4:3', 1.333]];
  const k = known.find(([, v]) => Math.abs(v - r) < 0.03);
  return k ? k[0] : `${w}×${h}`;
}

type Entry = { j: Job; it: Item; a: NonNullable<Item['attempts'][number]> };

/** 핀터레스트형 카드: 원본 비율 그대로, 올리면 설명이 뜨고 영상은 재생 */
function Pin({ e, sel, onClick }: { e: Entry; sel: boolean; onClick: () => void }) {
  const { j, it, a } = e;
  const vid = isVideo(a.file);
  const ref = useRef<HTMLVideoElement>(null);
  const st = it.status === 'passed' ? ['p', `PASS ${a.score}`] : it.status === 'failed' ? ['x', `FAIL ${a.score ?? ''}`] : it.status === 'unchecked' ? ['u', '미검수'] : ['g', '검수 끔'];
  const h = a.human ?? it.human;
  const ar = a.width && a.height ? `${a.width} / ${a.height}` : '1 / 1';
  return (
    <div className={'pin' + (sel ? ' sel' : '') + (it.status === 'failed' ? ' fail' : '')} onClick={onClick}
      onMouseEnter={() => ref.current?.play().catch(() => {})}
      onMouseLeave={() => { const v = ref.current; if (v) { v.pause(); v.currentTime = 0; } }}>
      {vid
        ? <video ref={ref} src={fileUrl(a.file)} poster={a.poster ? fileUrl(a.poster) : undefined} muted loop playsInline preload="none" style={{ aspectRatio: ar }} />
        : <img src={fileUrl(a.file)} alt="" loading="lazy" style={{ aspectRatio: ar }} />}
      <span className={'st ' + st[0]}>{st[1]}{it.attempts.length > 1 ? ` · ${it.attempts.length}회` : ''}</span>
      {h && <span className={'human ' + h}>{h === 'accept' ? '✓' : '✕'}</span>}
      {vid && <span className="dur">▶ {a.duration ? a.duration.toFixed(1) + '초' : '영상'}</span>}
      <div className="pin-ov">
        <b>{j.brief || j.moduleName}</b>
        <small>{j.moduleName} · {ratioLabel(a.width, a.height)} · {new Date(j.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
        {(a.defects?.length || a.reason) ? <small className="why">{a.defects?.length ? a.defects.map((d) => DEFECT_LABEL[d] ?? d).join(', ') + ' — ' : ''}{a.reason}</small> : null}
      </div>
    </div>
  );
}

export default function Gallery({ ctx }: { ctx: AppCtx }) {
  const { jobs, toast } = ctx;
  const [filter, setFilter] = useState<Filter>('all');
  const [defect, setDefect] = useState('');
  const [media, setMedia] = useState<'all' | 'image' | 'video'>('all');
  const [colW, setColW] = useState(230);
  const [sel, setSel] = useState<{ jobId: string; index: number } | null>(null);

  const everything = useMemo(() => jobs.flatMap((j) => j.items.map((it) => ({ j, it, a: it.final !== undefined ? it.attempts[it.final] : undefined }))).filter((x) => x.a?.file), [jobs]);
  const nVideo = everything.filter((x) => isVideo(x.a!.file)).length;
  const all = everything.filter((x) => media === 'all' || (media === 'video') === isVideo(x.a!.file));
  const counts = {
    all: all.length,
    passed: all.filter((x) => x.it.status === 'passed').length,
    failed: all.filter((x) => x.it.status === 'failed').length,
    unchecked: all.filter((x) => x.it.status === 'unchecked' || x.it.status === 'done').length,
    accept: all.filter((x) => (x.a!.human ?? x.it.human) === 'accept').length,
    reject: all.filter((x) => (x.a!.human ?? x.it.human) === 'reject').length,
  };
  const shown = all.filter(({ it }) => {
    if (filter === 'passed' && it.status !== 'passed') return false;
    if (filter === 'failed' && it.status !== 'failed') return false;
    if (filter === 'unchecked' && it.status !== 'unchecked' && it.status !== 'done') return false;
    if ((filter === 'accept' || filter === 'reject') && (it.attempts[it.final ?? -1]?.human ?? it.human) !== filter) return false;
    if (defect && !it.attempts.some((a) => a.defects?.includes(defect))) return false;
    return true;
  });
  const selJob = sel ? jobs.find((j) => j.id === sel.jobId) : undefined;
  const selItem: Item | undefined = selJob?.items[sel!.index];

  const F = ({ id, label, cls = '' }: { id: Filter; label: string; cls?: string }) => (
    <button className={`f ${cls}` + (filter === id ? ' on' : '')} onClick={() => setFilter(id)}>{label}<b>{counts[id]}</b></button>
  );

  return (
    <div className={'gwrap' + (selItem ? '' : ' nodetail')} style={{ minHeight: 0 }}>
      <section className="gcenter">
        <div className="toolbar">
          <div className="seg" style={{ marginRight: 6 }}>
            <button className={media === 'all' ? 'on' : ''} style={{ padding: '6px 12px' }} onClick={() => setMedia('all')}>전체 {everything.length}</button>
            <button className={media === 'image' ? 'on' : ''} style={{ padding: '6px 12px' }} onClick={() => setMedia('image')}>이미지 {everything.length - nVideo}</button>
            <button className={media === 'video' ? 'on' : ''} style={{ padding: '6px 12px' }} onClick={() => setMedia('video')}>영상 {nVideo}</button>
          </div>
          <F id="all" label="전체" /><F id="passed" label="통과" cls="p" /><F id="failed" label="실패" cls="x" /><F id="unchecked" label="미검수" cls="u" />
          <F id="accept" label="쓸 만함" /><F id="reject" label="못 씀" />
          <select className="select" style={{ width: 150, padding: '6px 10px', fontSize: 12 }} value={defect} onChange={(e) => setDefect(e.target.value)}>
            <option value="">결함 유형: 전체</option>
            {Object.entries(DEFECT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <div className="row small muted" style={{ marginLeft: 'auto', width: 190, whiteSpace: 'nowrap' }}>크기<input type="range" min={160} max={380} value={colW} onChange={(e) => setColW(Number(e.target.value))} /></div>
        </div>
        <div className="scroll">
          {!shown.length && <div className="empty"><b>표시할 결과가 없어요</b>[이미지 생성] 탭에서 생성하면 여기에 모여요. 원본 비율 그대로 보여주고, 마우스를 올리면 설명이 뜨고 영상은 재생돼요.</div>}
          <div className="masonry" style={{ columnWidth: colW }}>
            {shown.map((e) => {
              const isSel = sel?.jobId === e.j.id && sel.index === e.it.index;
              return <Pin key={e.j.id + ':' + e.it.index} e={e as Entry} sel={isSel} onClick={() => setSel(isSel ? null : { jobId: e.j.id, index: e.it.index })} />;
            })}
          </div>
        </div>
      </section>
      {selJob && selItem && (
        <aside className="side">
          <ItemDetail job={selJob} item={selItem} toast={toast} onSendToVideo={(f) => ctx.sendToVideo(f)} />
        </aside>
      )}
    </div>
  );
}
