import { useEffect, useState } from 'react';
import type { AppCtx } from '../App';
import { api, ModuleDef, Settings } from '../api';
import Downloads from '../components/Downloads';

const CAT: Record<string, string> = { image: '이미지 생성', edit: '레퍼런스 편집', video: '영상', tool: '도구' };

function ImportModal({ ctx, onClose }: { ctx: AppCtx; onClose: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<any>(null);
  const [form, setForm] = useState({ id: '', name: '', category: 'image', description: '' });
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/comfy/history').then((r) => setItems(r.items)).catch((e) => setErr(e.message)); }, []);
  // 기본값은 실행 기록의 모델/노드 구성으로 서버가 추천 (LTX → ltx25_t2v / ltx25_i2v, Qwen+LTX+여러 이미지 → elements_video …)
  const choose = (h: any) => {
    setPick(h); setOverwrite(false); setErr('');
    const s = h.suggest ?? { id: 'module_' + Date.now(), name: '', category: 'image' };
    setForm({ id: s.id, name: s.name, category: s.category, description: '' });
  };
  const sameId = pick && form.id === pick.suggest?.id;
  const conflict = sameId ? pick?.conflict : ctx.modules.find((m) => m.id === form.id) ? { id: form.id, name: ctx.modules.find((m) => m.id === form.id)!.name, models: [] } : null;
  const doImport = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/api/modules/import', { promptId: pick.id, ...form, overwrite });
      await ctx.reloadModules();
      ctx.toast(`"${form.name}" 모듈을 가져왔어요`);
      if (r.module?.problems?.length) setErr('가져왔지만 확인이 필요해요: ' + r.module.problems.join(' / '));
      else onClose();
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h"><b>ComfyUI 최근 실행에서 모듈 가져오기</b><button className="link" onClick={onClose}>닫기 ✕</button></div>
        <div className="modal-b">
          <div className="small muted" style={{ lineHeight: 1.6 }}>
            ComfyUI에서 원하는 워크플로우를 한 번 실행하면 여기에 나타나요. 고르면 그 실행 그대로 모듈이 되고, 프롬프트 칸은 자동으로 PROMPT_HERE로 바뀌어요. (Export (API) 없이 바로 가져오기)<br />
            Deno 같은 LLM 노드는 가져올 때 자동으로 빠져요 (프롬프트 확장·검수는 앱이 담당). 같은 모듈 ID로 다시 가져오면 덮어써요.
          </div>
          {err && <div className="err">{err}</div>}
          {!items && !err && <div className="muted">불러오는 중…</div>}
          {items && !items.length && <div className="warnbox">ComfyUI 실행 기록이 없어요. ComfyUI에서 워크플로우를 한 번 실행한 뒤 다시 열어 주세요. (ComfyUI를 재시작하면 기록이 비워져요)</div>}
          {items?.map((h) => (
            <div key={h.id} className={'hist' + (pick?.id === h.id ? ' on' : '')} onClick={() => choose(h)}>
              <div className="th" style={h.thumb ? { backgroundImage: `url("${h.thumb}")` } : undefined} />
              <div className="tx">
                <b>{h.suggest?.name || h.models?.[0]?.replace(/\.safetensors$/, '') || '모델 정보 없음'}</b> <span className="muted">· 노드 {h.nodeCount}개 · {h.time ? new Date(h.time).toLocaleString('ko-KR') : ''}</span>
                <div className="small muted" style={{ marginTop: 1 }}>{h.models?.[0] || ''}</div>
                <p>{h.text || '(텍스트 입력 없음)'}</p>
                <div className="row" style={{ marginTop: 3 }}>
                  {h.isVideo ? <span className="tag pass">영상</span> : <span className="tag gray">이미지</span>}
                  {h.hasLoadImage && <span className="tag run">이미지 입력 {h.loadImages > 1 ? h.loadImages + '개' : '있음'}</span>}
                  {h.hasLLM && <span className="tag warn">LLM 노드 포함</span>}
                  {!h.ok && <span className="tag fail">실행 오류</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="modal-f" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {pick && (
            <div className="grid2" style={{ width: '100%' }}>
              <label className="field"><small>모듈 ID (폴더 이름 · 같은 ID면 덮어쓰기)</small><input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} /></label>
              <label className="field"><small>화면에 보일 이름</small><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field"><small>종류</small>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{Object.entries(CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <label className="field"><small>설명 (선택)</small><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              {pick.isVideo && form.category !== 'video' && <div className="warnbox" style={{ gridColumn: 'span 2' }}>영상 워크플로우라서 종류와 상관없이 [영상 생성] 탭에 들어가요.</div>}
              {conflict && (
                <label className="warnbox" style={{ gridColumn: 'span 2', display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                  <span>이미 <b>{conflict.name}</b> ({conflict.id}) 모듈이 있어요{conflict.models?.[0] ? ` — 다른 모델(${conflict.models[0]})을 쓰는 모듈이에요` : ''}. 덮어쓰려면 체크, 아니면 ID를 바꿔 주세요.</span>
                </label>
              )}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={onClose}>취소</button>
          <button className="btn primary sm" disabled={!pick || !form.id || busy || (!!conflict && !overwrite)} onClick={doImport}>{busy ? '가져오는 중…' : '모듈로 가져오기'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 모듈 한 줄: 이름 · 실행 위치 · 상태만 보이고, 누르면 그 자리에서 상세가 펼쳐짐 */
function ModuleRow({ m, open, toggle }: { m: ModuleDef; open: boolean; toggle: () => void }) {
  const paid = m.cost === 'paid';
  const caps = [
    m.images.length ? `참조 이미지 ${m.images.length}장` : null,
    m.prompt2 ? '움직임 프롬프트' : null,
    m.lora.mode !== 'none' ? 'LoRA' : null,
    m.keyframe ? '키프레임 먼저 검수' : null,
  ].filter(Boolean) as string[];
  return (
    <div className={'mrow' + (open ? ' open' : '') + (m.ready ? '' : ' off')}>
      <button className="mrow-h" onClick={toggle} aria-expanded={open}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="mname">{m.name.replace(/\s*\((유료 API|로컬)\)\s*$/, '')}</span>
        <span className="mcaps">{caps.join(' · ')}</span>
        <span className={'tag ' + (paid ? 'warn' : 'gray')}>{paid ? '유료 API' : '로컬'}</span>
        <span className={'tag ' + (m.ready ? 'pass' : 'fail')}>{m.ready ? '사용 가능' : '준비 필요'}</span>
      </button>
      {!open && m.problems.length > 0 && <div className="mprob">⚠ {m.problems[0]}</div>}
      {open && (
        <div className="mrow-b">
          {m.description && <p className="mdesc">{m.description}</p>}
          {m.problems.map((p, i) => <div key={i} className="mprob">⚠ {p}</div>)}
          <dl className="minfo">
            <dt>ID</dt><dd><code>{m.id}</code></dd>
            <dt>종류</dt><dd>{CAT[m.category] ?? m.category}</dd>
            <dt>실행</dt><dd>{paid ? '클라우드 (Comfy 크레딧 차감)' : m.vram || '로컬 GPU'}</dd>
            {m.license && <><dt>라이선스</dt><dd>{m.license}</dd></>}
            {m.nodeCount ? <><dt>노드</dt><dd>{m.nodeCount}개</dd></> : null}
          </dl>
          {m.notes.length > 0 && (
            <div><div className="msub">연결 정보</div><ul className="mnotes">{m.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
          )}
          {m.params.length > 0 && (
            <div><div className="msub">고급 설정으로 조절 가능</div><div className="mchips">{m.params.map((p) => <span key={p.key}>{p.label}</span>)}</div></div>
          )}
        </div>
      )}
    </div>
  );
}

function ModuleList({ modules }: { modules: ModuleDef[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'local' | 'paid' | 'problem'>('all');
  const toggle = (id: string) => setOpen((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const shown = modules.filter((m) => filter === 'all' || (filter === 'paid' ? m.cost === 'paid' : filter === 'local' ? m.cost !== 'paid' : !m.ready));
  const groups: [string, ModuleDef[]][] = (['image', 'edit', 'video', 'tool'] as const)
    .map((c) => [CAT[c], shown.filter((m) => m.category === c).sort((a, b) => a.name.localeCompare(b.name, 'ko'))] as [string, ModuleDef[]])
    .filter(([, list]) => list.length);
  const bad = modules.filter((m) => !m.ready).length;
  return (
    <>
      <div className="between" style={{ marginBottom: 10 }}>
        <div className="small muted">전체 {modules.length}개 · 사용 가능 {modules.length - bad}개{bad ? ` · 준비 필요 ${bad}개` : ''} · 줄을 누르면 상세가 펼쳐져요</div>
        <div className="row" style={{ gap: 8 }}>
          <div className="seg" style={{ width: 280 }}>
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>전체</button>
            <button className={filter === 'local' ? 'on' : ''} onClick={() => setFilter('local')}>로컬</button>
            <button className={filter === 'paid' ? 'on' : ''} onClick={() => setFilter('paid')}>유료 API</button>
            <button className={filter === 'problem' ? 'on' : ''} onClick={() => setFilter('problem')}>준비 필요</button>
          </div>
          <button className="link" onClick={() => setOpen(open.size ? new Set() : new Set(shown.map((m) => m.id)))}>{open.size ? '모두 접기' : '모두 펼치기'}</button>
        </div>
      </div>
      {!groups.length && <div className="small muted" style={{ padding: '12px 0' }}>해당하는 모듈이 없어요</div>}
      <div className="mgroups">
        {groups.map(([label, list]) => (
          <div key={label} className="mgroup">
            <div className="mgroup-h">{label} <span>{list.length}</span></div>
            <div className="mlist">{list.map((m) => <ModuleRow key={m.id} m={m} open={open.has(m.id)} toggle={() => toggle(m.id)} />)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function SkillPanel({ s, up }: { s: Settings; up: (fn: (x: Settings) => void) => void }) {
  const [sk, setSk] = useState<{ dir: string; mode: string; files: { key: string; file: string; found: boolean; size: number }[] } | null>(null);
  useEffect(() => { api('/api/skills').then(setSk).catch(() => setSk(null)); }, [s.llm.backend, s.llm.skillMode]);
  const SK: Record<string, string> = { seedance: '영상 프롬프트 (Seedance)', leera: '로케이션 프롬프트 (Leera)', shotPrep: '검수 기준 (shot-prep)', characterSheet: '캐릭터 시트' };
  return (
    <div className="skillbox">
      <label className="lb">제작 스킬 적용
        <select className="input" value={s.llm.skillMode ?? 'auto'} onChange={(e) => up((x) => { x.llm.skillMode = e.target.value as any; })}>
          <option value="auto">자동 — Claude면 원문 스킬, 로컬·기타 모델은 압축 규칙</option>
          <option value="compact">압축 규칙 — 작은 모델용 (빈칸 채우기 + 코드 점검)</option>
          <option value="full">원문 스킬 — skills 폴더의 .md를 그대로 (긴 규칙을 소화하는 모델용)</option>
          <option value="off">끄기 — 예전 방식</option>
        </select>
      </label>
      <label className="lb">검수 방식
        <select className="input" value={s.llm.qcMode ?? 'single'} onChange={(e) => up((x) => { x.llm.qcMode = e.target.value as any; })}>
          <option value="single">한 번에 체크리스트 (빠름)</option>
          <option value="split">예·아니오 질문 여러 번 (작은 비전 모델이 더 정확, 느림)</option>
        </select>
      </label>
      {sk && (
        <div className="small muted">
          지금 적용: <b>{sk.mode === 'full' ? '원문 스킬' : sk.mode === 'compact' ? '압축 규칙' : '끔'}</b> · 스킬 폴더 {sk.dir}
          <div className="skillfiles">{sk.files.map((f) => <span key={f.key} className={'tag ' + (f.found ? 'pass' : 'gray')}>{SK[f.key] ?? f.key} · {f.file}{f.found ? '' : ' (없음)'}</span>)}</div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage({ ctx }: { ctx: AppCtx }) {
  const { status } = ctx;
  const [s, setS] = useState<Settings | null>(ctx.settings);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => { if (ctx.settings) setS(structuredClone(ctx.settings)); }, [ctx.settings]);
  if (!s) return <div className="page"><div className="empty">불러오는 중…</div></div>;
  const up = (fn: (x: Settings) => void) => setS((prev) => { const n = structuredClone(prev!); fn(n); return n; });
  const save = async () => {
    setSaving(true);
    try { await api('/api/settings', s, 'PUT'); await ctx.reloadSettings(); ctx.toast('설정을 저장했어요'); }
    catch (e: any) { ctx.toast(e.message); }
    setSaving(false);
  };

  return (
    <div className="page">
      <div className="panel">
        <h3>
          모듈 <span>modules 폴더 안의 폴더 하나 = 모듈 하나 (workflow.json + manifest.json)</span>
        </h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn primary sm" onClick={() => setImportOpen(true)}>ComfyUI 최근 실행에서 가져오기</button>
          <button className="btn ghost sm" onClick={() => ctx.reloadModules(true).then(() => ctx.toast('모듈을 다시 읽었어요'))}>모듈 새로고침</button>
          <span className="small muted">Export (API) 파일을 modules/&lt;이름&gt;/workflow.json으로 넣고 새로고침해도 돼요.</span>
        </div>
        <ModuleList modules={ctx.modules} />
      </div>

      <Downloads ctx={ctx} />

      <div className="cols2">
        <div className="panel form">
          <h3>연결</h3>
          <label className="lb">ComfyUI 주소
            <input className="input" value={s.comfyUrl} onChange={(e) => up((x) => { x.comfyUrl = e.target.value; })} />
          </label>
          <div className="small" style={{ color: status?.comfy.ok ? 'var(--pass)' : 'var(--fail)' }}>{status?.comfy.ok ? `연결됨 · ${status.comfy.gpu}` : status?.comfy.error ?? '확인 중'}</div>
          <label className="lb">LLM (프롬프트 확장 · 검수)
            <div className="seg">
              <button className={s.llm.backend === 'lmstudio' ? 'on' : ''} onClick={() => up((x) => { x.llm.backend = 'lmstudio'; })}>LM Studio (로컬 · 무료)</button>
              <button className={s.llm.backend === 'openai' ? 'on' : ''} onClick={() => up((x) => { x.llm.backend = 'openai'; })}>OpenAI 호환 (아무 LLM)</button>
              <button className={s.llm.backend === 'claude' ? 'on' : ''} onClick={() => up((x) => { x.llm.backend = 'claude'; })}>Claude API (유료)</button>
            </div>
          </label>
          {s.llm.backend === 'lmstudio' ? (
            <>
              <label className="lb">LM Studio 주소<input className="input" value={s.llm.lmstudioUrl} onChange={(e) => up((x) => { x.llm.lmstudioUrl = e.target.value; })} /></label>
              <label className="lb">모델 (이미지를 볼 수 있는 Vision 모델이어야 검수 가능)
                <input className="input" list="lm-models" value={s.llm.lmstudioModel} onChange={(e) => up((x) => { x.llm.lmstudioModel = e.target.value; })} />
                <datalist id="lm-models">{status?.llm.models.map((m) => <option key={m} value={m} />)}</datalist>
              </label>
              <div className="small" style={{ color: status?.llm.ok ? (status.llm.hasModel ? 'var(--pass)' : 'var(--warn)') : 'var(--fail)' }}>
                {status?.llm.ok ? (status.llm.hasModel ? '연결됨 · 모델 확인' : `연결됨 · 이 모델 이름이 목록에 없어요 (목록: ${status.llm.models.join(', ') || '없음'})`) : status?.llm.error ?? ''}
              </div>
            </>
          ) : s.llm.backend === 'openai' ? (
            <>
              <label className="lb">서버 주소 (Ollama http://127.0.0.1:11434 · OpenRouter https://openrouter.ai/api · OpenAI https://api.openai.com 등)
                <input className="input" value={s.llm.openaiUrl ?? ''} onChange={(e) => up((x) => { x.llm.openaiUrl = e.target.value; })} />
              </label>
              <label className="lb">모델 이름 (검수하려면 이미지를 볼 수 있는 모델)
                <input className="input" list="oa-models" value={s.llm.openaiModel ?? ''} onChange={(e) => up((x) => { x.llm.openaiModel = e.target.value; })} />
                <datalist id="oa-models">{status?.llm.models.map((m) => <option key={m} value={m} />)}</datalist>
              </label>
              <label className="lb">API 키 (로컬 서버면 비워 두세요)<input className="input" type="password" value={s.llm.openaiKey ?? ''} onChange={(e) => up((x) => { x.llm.openaiKey = e.target.value; })} /></label>
              <div className="small" style={{ color: status?.llm.ok && status.llm.hasModel ? 'var(--pass)' : 'var(--warn)' }}>{status?.llm.ok ? (status.llm.hasModel ? '연결됨 · 모델 확인' : status.llm.error ?? '') : status?.llm.error ?? ''}</div>
            </>
          ) : (
            <>
              <label className="lb">Claude 모델<input className="input" value={s.llm.claudeModel} onChange={(e) => up((x) => { x.llm.claudeModel = e.target.value; })} /></label>
              <label className="lb">API 키<input className="input" type="password" value={s.llm.anthropicKey} placeholder="sk-ant-..." onChange={(e) => up((x) => { x.llm.anthropicKey = e.target.value; })} /></label>
            </>
          )}
          <SkillPanel s={s} up={up} />
          <label className="lb">Hugging Face 토큰 (라이선스 동의 모델 다운로드용 · Read 권한)
            <input className="input" type="password" placeholder="hf_..." value={s.hfToken} onChange={(e) => up((x) => { x.hfToken = e.target.value; })} />
          </label>
          <label className="lb">Comfy API 키 (유료 모델: GPT Image 2 · Seedance 2.0 — 크레딧은 Comfy 계정에서 차감)
            <input className="input" type="password" placeholder="comfyui-..." value={s.comfyApiKey ?? ''} onChange={(e) => up((x) => { x.comfyApiKey = e.target.value; })} />
            <a className="small" href="https://platform.comfy.org/profile/api-keys" target="_blank" rel="noreferrer">platform.comfy.org에서 키 만들기 (크레딧을 산 계정으로 로그인)</a>
          </label>
          <label className="lb">Civitai API 키 (선택)
            <input className="input" type="password" value={s.civitaiToken} onChange={(e) => up((x) => { x.civitaiToken = e.target.value; })} />
          </label>
          <label className="lb">ComfyUI models 폴더 (비우면 ComfyUI Desktop 설정에서 자동으로 찾음)
            <input className="input" placeholder="자동" value={s.modelsDir} onChange={(e) => up((x) => { x.modelsDir = e.target.value; })} />
          </label>
          <label className="tlabel" onClick={() => up((x) => { x.vramSaver = !x.vramSaver; })}>
            <span className={'toggle' + (s.vramSaver ? ' on' : '')} />VRAM 절약 모드 — LLM과 이미지 모델이 GPU를 번갈아 쓰도록 매번 내려줌 (12GB 권장)
          </label>
        </div>

        <div className="panel form">
          <h3>검수 기본값 · 브랜드 톤</h3>
          <div className="grid3">
            <label className="field"><small>통과 점수</small><input type="number" min={1} max={10} value={s.qc.passScore} onChange={(e) => up((x) => { x.qc.passScore = Number(e.target.value); })} /></label>
            <label className="field"><small>최대 시도</small><input type="number" min={1} max={6} value={s.qc.maxAttempts} onChange={(e) => up((x) => { x.qc.maxAttempts = Number(e.target.value); })} /></label>
            <label className="field"><small>단색 판정 기준</small><input type="number" min={0} max={40} value={s.qc.minStd} onChange={(e) => up((x) => { x.qc.minStd = Number(e.target.value); })} /></label>
          </div>
          <label className="lb">결과 저장 폴더<input className="input" value={s.outputDir} onChange={(e) => up((x) => { x.outputDir = e.target.value; })} /></label>
          <div className="sec-label" style={{ marginTop: 4 }}>브랜드 톤 프리셋 <button className="link" onClick={() => up((x) => { x.tones.push({ id: 't' + Date.now(), label: '새 톤', text: '' }); })}>+ 추가</button></div>
          {s.tones.map((t, i) => (
            <div key={t.id} className="row" style={{ alignItems: 'flex-start' }}>
              <input className="input" style={{ width: 120 }} value={t.label} onChange={(e) => up((x) => { x.tones[i].label = e.target.value; })} />
              <textarea className="input" style={{ minHeight: 40, fontSize: 12 }} value={t.text} placeholder="영어로 색감·조명·무드" onChange={(e) => up((x) => { x.tones[i].text = e.target.value; })} />
              <button className="link" style={{ paddingTop: 10, whiteSpace: 'nowrap' }} onClick={() => up((x) => { x.tones.splice(i, 1); })}>삭제</button>
            </div>
          ))}
        </div>
      </div>
      <div className="savebar">
        <span className="small muted">연결 · 검수 기본값 · 브랜드 톤은 [설정 저장]을 눌러야 반영돼요.</span>
        <button className="btn primary sm" disabled={saving} onClick={save}>{saving ? '저장 중…' : '설정 저장'}</button>
      </div>
      {importOpen && <ImportModal ctx={ctx} onClose={() => setImportOpen(false)} />}
    </div>
  );
}
