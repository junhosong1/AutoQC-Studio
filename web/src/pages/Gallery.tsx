import { useMemo, useState } from 'react';
import type { AppCtx } from '../App';
import { DEFECT_LABEL, Item, Job, fileUrl, isVideo } from '../api';
import Media from '../components/Media';
import ItemDetail from '../components/ItemDetail';

type Filter = 'all' | 'passed' | 'failed' | 'unchecked' | 'accept' | 'reject';

function ratioLabel(w?: number, h?: number) {
  if (!w || !h) return '';
  const r = w / h;
  const known: [string, number][] = [['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['9:16', 0.5625], ['16:9', 1.778], ['3:2', 1.5], ['2:3', 0.667], ['4:3', 1.333]];
  const k = known.find(([, v]) => Math.abs(v - r) < 0.03);
  return k ? k[0] : `${w}×${h}`;
}

export default function Gallery({ ctx }: { ctx: AppCtx }) {
  const { jobs, toast } = ctx;
  const [filter, setFilter] = useState<Filter>('all');
  const [defect, setDefect] = useState('');
  const [media, setMedia] = useState<'all' | 'image' | 'video'>('all');
  const [rowH, setRowH] = useState(170);
  const [sel, setSel] = useState<{ jobId: string; index: number } | null>(null);

  const everything = useMemo(() => jobs.flatMap((j) => j.items.map((it) => ({ j, it, a: it.final !== undefined ? it.attempts[it.final] : undefined }))).filter((x) => x.a?.file), [jobs]);
  const nVideo = everything.filter((x) => isVideo(x.a!.file)).length;
  const all = everything.filter((x) => media === 'all' || (media === 'video') === isVideo(x.a!.file));
  const counts = {
    all: all.length,
    passed: all.filter((x) => x.it.status === 'passed').length,
    failed: all.filter((x) => x.it.status === 'failed').length,
    unchecked: all.filter((x) => x.it.status === 'unchecked' || x.it.status === 'done').length,
    accept: all.filter((x) => x.it.human === 'accept').length,
    reject: all.filter((x) => x.it.human === 'reject').length,
  };
  const shown = all.filter(({ it }) => {
    if (filter === 'passed' && it.status !== 'passed') return false;
    if (filter === 'failed' && it.status !== 'failed') return false;
    if (filter === 'unchecked' && it.status !== 'unchecked' && it.status !== 'done') return false;
    if ((filter === 'accept' || filter === 'reject') && it.human !== filter) return false;
    if (defect && !it.attempts.some((a) => a.defects?.includes(defect))) return false;
    return true;
  });
  const groups: { j: Job; list: typeof shown }[] = [];
  for (const x of shown) {
    const g = groups.find((g) => g.j.id === x.j.id);
    g ? g.list.push(x) : groups.push({ j: x.j, list: [x] });
  }
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
          <F id="accept" label="채택" /><F id="reject" label="반려" />
          <select className="select" style={{ width: 150, padding: '6px 10px', fontSize: 12 }} value={defect} onChange={(e) => setDefect(e.target.value)}>
            <option value="">결함 유형: 전체</option>
            {Object.entries(DEFECT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <div className="row small muted" style={{ marginLeft: 'auto', width: 190, whiteSpace: 'nowrap' }}>크기<input type="range" min={110} max={300} value={rowH} onChange={(e) => setRowH(Number(e.target.value))} /></div>
        </div>
        <div className="scroll">
          {!shown.length && <div className="empty"><b>표시할 결과가 없어요</b>[이미지 생성] 탭에서 생성하면 여기에 모여요. 비율이 달라도 원본 비율 그대로 줄 맞춰 보여줘요.</div>}
          {groups.map(({ j, list }) => (
            <div key={j.id}>
              <div className="grp">{new Date(j.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {j.brief.slice(0, 40) || j.moduleName}<span>{list.length}장 · {j.moduleName}</span></div>
              <div className="rowwrap">
                {list.map(({ it, a }) => {
                  const r = a!.width && a!.height ? a!.width / a!.height : 1;
                  const st = it.status === 'passed' ? ['p', `PASS ${a!.score}`] : it.status === 'failed' ? ['x', 'FAIL'] : it.status === 'unchecked' ? ['u', '미검수'] : ['g', '검수 끔'];
                  const isSel = sel?.jobId === j.id && sel.index === it.index;
                  return (
                    <div key={it.index} className={'it' + (it.status === 'failed' ? ' fail' : '') + (isSel ? ' sel' : '')}
                      style={{ height: rowH, flexGrow: r, flexBasis: r * rowH, backgroundImage: `url("${fileUrl(isVideo(a!.file) ? a!.poster : a!.file)}")` }}
                      onClick={() => setSel(isSel ? null : { jobId: j.id, index: it.index })}>
                      {isVideo(a!.file) && <Media file={a!.file} poster={a!.poster} />}
                      <span className={'st ' + st[0]}>{st[1]}{it.attempts.length > 1 ? ` · ${it.attempts.length}회` : ''}</span>
                      {it.human && <span className={'human ' + it.human}>{it.human === 'accept' ? '✓' : '✕'}</span>}
                      <span className="ratio">{isVideo(a!.file) ? `▶ ${a!.duration ? a!.duration.toFixed(1) + '초 · ' : ''}` : ''}{ratioLabel(a!.width, a!.height)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
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
