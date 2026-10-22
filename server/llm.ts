// LLM 어댑터 — 두 가지 역할
//   1) 프롬프트 생성기 : 한국어 기획 문장 → 이미지 모델용 영어 프롬프트(JSON)
//   2) 검수자(Reviewer): 생성 이미지 + 기획 의도 → 점수/결함 코드/사유(JSON)
// 백엔드: LM Studio(로컬) · OpenAI 호환 서버(아무 LLM) · Claude API
// 제작 스킬(shot-prep · Seedance · Leera · character-sheet)은 skills.ts 를 거쳐 적용
//   compact = 작은 모델용: 빈칸(JSON 슬롯)만 채우게 하고 문장은 코드가 조립, 규칙 검사도 코드가
//   full    = 강한 모델용: skills/ 폴더의 원문 스킬을 시스템 프롬프트에 붙임
import { getSettings } from './config.js';
import { CORE_RULES, COMMERCE_RULES, LOCATION_RULES, SEEDANCE_RULES, SLOT_SCHEMAS, SlotKind, assembleSlots, lintPrompt, skillMode, skillText } from './skills.js';

export const DEFECT_CODES: Record<string, string> = {
  off_brief: '기획 의도·프롬프트와 내용 불일치',
  product_distortion: '제품 형태·로고·비율 변형',
  anatomy: '손·얼굴·인체 파손',
  text_artifact: '깨진 글자·의미 없는 텍스트',
  low_quality: '노이즈·뭉개짐·과포화 등 저품질',
  composition: '구도·크롭 문제 (주제가 잘림 등)',
  brand_tone: '톤앤매너(색감·무드) 불일치',
  motion_artifact: '영상: 프레임 간 형태 변형·깜빡임·멈춤',
  identity_drift: '인물·캐릭터·제품이 레퍼런스와 달라짐 (얼굴·의상·형태)',
  slop_texture: '슬롭 질감: 번들거림·밀랍·플라스틱 피부·과샤픈 테두리',
  geometry_break: '구조 붕괴: 물체·건물·소품이 녹거나 합쳐지거나 말이 안 되는 형태',
  unrequested_change: '요청하지 않은 요소가 추가·변경됨',
  sheet_rule: '캐릭터 시트 규칙 위반 (배경·눈·초상 크기·머리 크롭·대칭)',
  location_rule: '로케이션 규칙 위반 (광원·그림자·앵커·3/4 시점·깊이감)',
};

/** 이 결함들은 프롬프트를 고쳐야 해결됨 → 피드백을 넣어 프롬프트 재작성. 나머지는 시드만 바꿔 재시도 */
export const PROMPT_DEFECTS = new Set(['off_brief', 'brand_tone', 'text_artifact', 'unrequested_change', 'sheet_rule', 'location_rule', 'identity_drift']);

/** 검수 프로필: default(일반) / character_sheet(캐릭터 시트) / location(로케이션 플레이트) */
export type QcProfile = 'default' | 'character_sheet' | 'location';
export const QC_PROFILES: Record<QcProfile, string> = { default: '일반', character_sheet: '캐릭터 시트', location: '로케이션' };

const PROMPT_GEN_SYSTEM = `You are the prompt engineer of an automated commerce / brand image pipeline.
The user gives a creative brief (often in Korean), an optional brand tone note, and sometimes feedback from a reviewer who rejected the previous image.
Write one prompt for a modern text-to-image diffusion model (Qwen-Image / Flux / Z-Image class).

Rules:
- Write in natural English, 50-120 words, as one flowing description (no tag soup).
- Order: main subject → setting → lighting → camera / lens / framing → color and mood.
- Commerce: the product or main subject is the clear hero, fully inside the frame, true to its real shape. Never invent logos.
- Do NOT ask for any visible text, letters, signage, labels or numbers unless the brief explicitly requires readable text. Prefer "blank" or "unlabeled" surfaces. (Text is composited later by the pipeline.)
  Exception: when REFERENCE IMAGES are attached, the product's own label and logo come from the reference and must be kept exactly (never ask for blank or unlabeled products then).
- Follow the brand tone note for palette, light and mood.
- If REFERENCE IMAGES are attached to the workflow, describe how to use them ("the product from the reference image") instead of re-inventing the product.
- If REVIEWER FEEDBACK is given, fix exactly those problems and keep everything else.
- Negative prompt: short list of things to avoid (e.g. "blurry, distorted product, extra fingers, garbled text, watermark").

Output ONLY a JSON object, nothing else:
{"positive": "...", "negative": "..."}`;

const REF_PROMPT_SYSTEM = `You are the prompt engineer of an automated commerce pipeline that uses a multi-reference IMAGE EDIT model (Qwen-Image-Edit class).
The model receives numbered reference images ("image 1", "image 2", ...). The user gives a brief (often in Korean), the list of what each image number contains, an optional brand tone, and sometimes reviewer feedback.
Write ONE instruction-style prompt that composes a new photo from those references.

Rules:
- Natural English, 50-120 words, one paragraph. Refer to references by number exactly: "the product from image 1", "the woman from image 2", "the label design from image 3".
- Keep identity: the product's exact shape, colors, cap, label layout, logo and printed text must stay identical to its reference; the person's face and hair stay identical.
- If an image is listed as label / logo / text, say the product label must show that exact design and wording, sharp and readable.
- Make the product large in frame, facing the camera, label fully visible and not occluded by fingers. Avoid strong tilt, motion blur or reflections on the label.
- Then setting → lighting → camera / framing → mood, following the brand tone.
- If REVIEWER FEEDBACK is given, fix exactly those problems (for garbled label text: make the product bigger and more frontal, keep the label flat to camera).
- Negative prompt: short list (e.g. "garbled text, misspelled label, distorted product, extra fingers, blurry").

Output ONLY a JSON object, nothing else:
{"positive": "...", "negative": "..."}`;

const VIDEO_PROMPT_SYSTEM = `You are the prompt engineer of an automated commerce / brand VIDEO pipeline (text-to-video models with native audio, e.g. LTX-2.5, MiniMax H3).
The user gives a creative brief (often in Korean), an optional brand tone, and sometimes reviewer feedback on the previous clip.
Write ONE video prompt.

Rules:
- Natural English, 70-140 words, present tense, one paragraph.
- Order: visual style → subject and setting → what moves (action) → camera movement and framing → lighting → ambient sound / music (and short dialogue only if the brief asks for speech, in quotes).
- One continuous shot unless the brief asks for cuts. Keep motion simple and physically plausible.
- Commerce: the product is the hero, fully in frame, true to its real shape. No invented logos or random on-screen text unless the brief asks for it.
- Follow the brand tone. If REVIEWER FEEDBACK is given, fix exactly those problems.
- Negative prompt: short list (e.g. "morphing, flicker, distorted product, garbled text, extra fingers").

Output ONLY a JSON object, nothing else:
{"positive": "...", "negative": "..."}`;

const REF_VIDEO_PROMPT_SYSTEM = `You are the prompt engineer of an automated commerce pipeline that uses a REFERENCE-TO-VIDEO model with native audio (MiniMax H3 class).
The model receives numbered reference images and must be told which one is which with tags like {TOKEN_EXAMPLE}, in connection order.
The user gives a brief (often in Korean), the list of reference images, an optional brand tone and sometimes reviewer feedback.

Rules:
- Natural English, 80-150 words. Start with the visual style, then: "Use {TOKEN_EXAMPLE} as ..." for every reference listed (product, character, location, style).
- Keep identity: the product shape, colors, label and logo stay identical to its reference; the character's face and outfit stay identical.
- Then describe the action, camera movement and framing, lighting, and the audio (ambience, music, sound effects; dialogue only if the brief asks, in quotes).
- One continuous shot unless the brief asks for cuts. Keep the product label facing the camera when it matters.
- If REVIEWER FEEDBACK is given, fix exactly those problems.
- Negative prompt: short list (e.g. "identity drift, morphing, garbled text, distorted product, flicker").

Output ONLY a JSON object, nothing else:
{"positive": "...", "negative": "..."}`;

const MOTION_PROMPT_SYSTEM = `You write the MOTION prompt for an image-to-video model (LTX-2.5 class). The first frame already exists, so do not re-describe its look in detail.
The user gives a short motion idea (often in Korean) and an optional brand tone.
Rules:
- English, 40-90 words, present tense, one paragraph.
- Start with: "Use the provided start image as the first frame."
- Describe what moves (subject action), how the camera moves (push in, orbit, pan, static), pacing, and ambient sound.
- Keep the product shape, colors and the person identity unchanged. No morphing, no new objects appearing.
- End with: "No text, no black frame."
Output ONLY JSON: {"positive": "..."}`;

function reviewSystem(video = false, refs = false, refPanel = false, profile: QcProfile = 'default') {
  const codes = Object.entries(DEFECT_CODES).filter(([k]) => (video || k !== 'motion_artifact') && (k !== 'sheet_rule' || profile === 'character_sheet') && (k !== 'location_rule' || profile === 'location')).map(([k, v]) => `- "${k}": ${v}`).join('\n');
  const intro = video
    ? `You are a strict quality reviewer for short commercial brand VIDEOS in an automated pipeline.
${refPanel ? 'You receive ONE image with four panels side by side: the REFERENCE image the clip must start from (leftmost — the real product / approved key frame), then the FIRST, MIDDLE and LAST frames of the generated video.\nCompare the video frames with the REFERENCE: product shape, colors, logo and the MAIN label text (brand name, big words) must match it.' : 'You receive ONE image that shows three frames of the same generated video side by side: FIRST frame (left), MIDDLE frame (center), LAST frame (right).'}
Judge the whole clip from these frames. Also check consistency between frames: the subject or product must keep the same shape, identity, colors and count; no morphing, melting or sudden jumps (motion_artifact).`
    : `You are a strict quality reviewer for commercial brand imagery in an automated pipeline.
You receive ONE generated image, the original brief, the brand tone note and the prompt that was used.`;
  return `${intro}
Decide whether the image can be published as-is on a commerce detail page or brand SNS.

Check in this order:
1. Brief fit: does the image show what the brief asked for? (off_brief)
2. Product: real-looking shape, proportions, materials; no melted or duplicated parts. (product_distortion)
3. People: hands, fingers, faces, limbs anatomically correct. (anatomy)
4. Text: ${video
    ? (refPanel
      ? 'compare with the REFERENCE panel. Flag text_artifact ONLY if the product\'s brand name or other LARGE text clearly differs from the reference, is scrambled, or changes between frames. Small print (ingredients, volume, taglines) that becomes soft, blurry or slightly misspelled at video resolution is NOT a defect — do not read small print letter by letter. (text_artifact)'
      : 'only judge text that is LARGE and clearly visible. Small label text that is simply soft or unreadable because of video resolution, distance or motion is NOT a defect. It is a defect only when prominent letters are clearly garbled, misspelled, or change between frames. (text_artifact)')
    : 'if any visible letters, signs, labels or plates are NOT real, correctly spelled words (including broken Korean Hangul), it is a defect. (text_artifact)'}${refs ? `
   This image was composed from reference photos: judge ONLY the brand name / logo and other LARGE label text against the real product — invented or scrambled big wording is text_artifact. Small print (ingredients, address, expiry date, volume, taglines, barcodes, fine print at the bottom of a label) that is soft, blurry or slightly scrambled is NOT a defect at this resolution — do not read small print letter by letter.` : ''}
5. Technical quality: noise, smearing, banding, over-saturation, plastic skin. (low_quality)
6. Composition: subject cut off, awkward crop, cluttered frame. (composition)
7. Tone: palette, light and mood match the brand tone note. (brand_tone)

Score 0-10 (10 = ready to publish, 7 = acceptable with no visible defects, 4 = clear defect, 0 = unusable).
Pick defects ONLY from these codes (empty list if none):
${codes}

Write "reason" in Korean, one short sentence a designer can act on (what is wrong and where).
Output ONLY a JSON object, nothing else:
{"score": <int 0-10>, "defects": ["code", ...], "reason": "..."}`;
}

export function extractJson(text: string): any {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('LLM 응답에서 JSON을 찾지 못했어요: ' + text.slice(0, 200));
  return JSON.parse(t.slice(s, e + 1));
}

async function post(url: string, body: any, headers: Record<string, string>, ms = 240000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`LLM 호출 실패 (${r.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('LLM 응답 시간 초과');
    if (e?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(e?.message)) throw new Error('LLM 서버에 연결할 수 없어요. LM Studio(1234) 또는 설정한 LLM 서버가 켜져 있는지 확인해 주세요.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// LLM 호출은 한 번에 하나씩 (미리보기와 작업이 동시에 Gemma를 부르거나, 쓰는 중에 모델이 내려가는 충돌 방지)
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

const PROMPT_SCHEMA = { type: 'object', properties: { positive: { type: 'string' }, negative: { type: 'string' } }, required: ['positive', 'negative'] };
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 10 },
    defects: { type: 'array', items: { type: 'string', enum: Object.keys(DEFECT_CODES) } },
    reason: { type: 'string' },
  },
  required: ['score', 'defects', 'reason'],
};

/** 주소 끝이 /v1 이든 아니든 /v1/chat/completions 로 */
const baseV1 = (u: string) => { const b = u.replace(/\/+$/, ''); return /\/v1$/.test(b) ? b : b + '/v1'; };
const chatUrl = (u: string) => baseV1(u) + '/chat/completions';

/** noThink: 생각(reasoning)하는 모델(Gemma 4 등)의 생각 단계를 끔. 프롬프트 작성처럼 형식만 지키면 되는 호출용.
 *  생각이 길어지면 max_tokens를 다 써서 content가 비고, 생각 메모만 돌아와 JSON을 못 찾음 */
async function chatRaw(system: string, user: string, imageJpeg: Buffer | undefined, maxTokens: number, schema?: any, noThink = false): Promise<string> {
  const s = getSettings().llm;
  if (s.backend === 'claude') {
    if (!s.anthropicKey) throw new Error('Claude API 키가 없어요. [설정]에서 입력해 주세요.');
    const content: any[] = [{ type: 'text', text: user }];
    if (imageJpeg) content.unshift({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageJpeg.toString('base64') } });
    const r = await post('https://api.anthropic.com/v1/messages', {
      model: s.claudeModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content }],
    }, { 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01' });
    return (r.content ?? []).map((b: any) => b.text ?? '').join('');
  }
  const content: any[] = [{ type: 'text', text: user }];
  if (imageJpeg) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageJpeg.toString('base64') } });
  const generic = s.backend === 'openai';
  const body: any = {
    model: generic ? s.openaiModel : s.lmstudioModel,
    temperature: s.temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
  };
  if (!generic) body.ttl = getSettings().vramSaver ? 60 : 900; // LM Studio 전용: 자동 언로드 시간
  if (!generic && noThink) body.reasoning_effort = 'none'; // LM Studio: 생각 단계 끄기 (지원 안 하는 모델은 무시)
  // 구조화 출력: JSON 형식을 강제 (지원 안 하면 한 번 빼고 다시)
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } };
  const url = chatUrl(generic ? s.openaiUrl : s.lmstudioUrl);
  const headers: Record<string, string> = generic && s.openaiKey ? { Authorization: `Bearer ${s.openaiKey}` } : {};
  let r: any;
  try { r = await post(url, body, headers); }
  catch (e: any) {
    if (!schema || !/\(4\d\d\)/.test(e.message) || /unloaded/i.test(e.message)) throw e;
    delete body.response_format;
    r = await post(url, body, headers);
  }
  const msg = r.choices?.[0]?.message ?? {};
  return msg.content || msg.reasoning_content || '';
}

/** JSON을 못 받으면 한 번 더 요청 (모델이 내려갔다는 오류도 한 번 재시도) */
async function chatJson(system: string, user: string, imageJpeg: Buffer | undefined, maxTokens: number, schema?: any, noThink = false): Promise<any> {
  return exclusive(async () => {
    let lastErr: any;
    for (let i = 0; i < 2; i++) {
      try {
        const raw = await chatRaw(system, i === 0 ? user : user + '\n\nIMPORTANT: Reply with ONLY the JSON object. No analysis, no markdown.', imageJpeg, maxTokens, schema, noThink);
        return extractJson(raw);
      } catch (e: any) { lastErr = e; }
    }
    throw lastErr;
  });
}

export async function chat(system: string, user: string, imageJpeg?: Buffer, maxTokens = 1500): Promise<string> {
  return exclusive(() => chatRaw(system, user, imageJpeg, maxTokens));
}

/** refs: 참조 이미지가 있으면 각 번호의 설명 (예: ["제품", "인물", "라벨/로고"]) — 있으면 레퍼런스 편집용 지시문으로 작성 */
export interface PromptOpts {
  video?: boolean;
  refToken?: string;
  /** Seedance 계열 모듈: Seedance 프롬프트 스킬 적용 */
  seedance?: boolean;
  /** 검수 프로필 = 만드는 에셋 종류 (캐릭터 시트 / 로케이션이면 그 스킬 규칙으로 작성) */
  profile?: QcProfile;
}

/** 스킬 규칙 묶음 (compact 규칙 + full 모드면 원문 스킬) */
function skillAppendix(kind: SlotKind, o: PromptOpts): string {
  const parts = [CORE_RULES];
  if (o.profile === 'location') parts.push(LOCATION_RULES);
  if (kind !== 'image' && o.seedance) parts.push(SEEDANCE_RULES);
  if (o.profile !== 'location' && o.profile !== 'character_sheet') parts.push(COMMERCE_RULES);
  if (skillMode() === 'full') {
    const full = kind !== 'image' && o.seedance ? skillText('seedance') : o.profile === 'location' ? skillText('leera') : '';
    if (full) parts.push(`FULL STUDIO SKILL — follow it where it does not conflict with the required output format. Never ask questions; when something is missing, choose a sensible default and state it in the prompt.\n${full}`);
  }
  return parts.join('\n\n');
}

/** 기존 시스템 프롬프트의 출력 형식 줄 앞에 스킬 규칙을 끼움 */
const withSkills = (system: string, appendix: string) =>
  system.includes('Output ONLY') ? system.replace(/Output ONLY/, `${appendix}\n\nOutput ONLY`) : `${system}\n\n${appendix}`;

/** 참조 이미지가 프롬프트에서 빠졌으면 코드가 앞에 붙임 (작은 모델이 자주 빠뜨림) */
function ensureRefs(text: string, labels: string[], tok: (n: number) => string, video: boolean) {
  const lower = text.toLowerCase();
  const miss = labels.map((l, i) => ({ l, t: tok(i + 1) })).filter((x) => !lower.includes(x.t.toLowerCase()));
  if (!miss.length) return text;
  const name = (l: string) => { const x = l.replace(/\s*\(default slot role.*\)$/, ''); return /[^\x00-\x7F]/.test(x) ? 'reference subject' : x; };
  const lead = miss.map(({ l, t }) => (video ? `Use ${t} as the ${name(l)}.` : `Keep the ${name(l)} from ${t} identical.`)).join(' ');
  return `${lead} ${text}`;
}

/** compact 모드: 작은 모델은 JSON 빈칸만 채우고, 문장 조립·규칙 점검은 코드가 */
async function slotPrompt(kind: SlotKind, system: string, user: string) {
  let d = await chatJson(system, user, undefined, 1200, SLOT_SCHEMAS[kind], true);
  let r = assembleSlots(kind, d);
  if (r.missing.length) {
    d = await chatJson(system, `${user}\n\nYour previous answer left these fields empty: ${r.missing.join(', ')}. Fill EVERY field with something concrete.`, undefined, 1200, SLOT_SCHEMAS[kind], true);
    r = assembleSlots(kind, d);
  }
  if (!r.positive.trim()) throw new Error('LLM이 빈 프롬프트를 돌려줬어요');
  return r;
}

const SLOT_SYSTEM = (what: string, refsNote: string, appendix: string, kind: SlotKind) => `You fill a JSON form that an automated pipeline turns into one ${what} prompt.
Write every field in plain English: one or two short, concrete sentences. No lists, no mood words.
${refsNote}
${appendix}
If REVIEWER FEEDBACK is given, change only what it asks for and keep everything else.
Output ONLY the JSON object with the fields: ${Object.keys(SLOT_SCHEMAS[kind].properties).join(', ')}.`;

/** character-sheet 스킬의 고정 템플릿 — LLM은 CHARACTER 블록만 씀 */
function characterSheetTemplate(subject: string, character: string) {
  return `Character reference sheet of a single consistent ${subject}, presented on a pure clean deep neutral grey (#3a3a3c) seamless studio background, clean editorial layout arranged in three vertical sections, horizontal landscape composition read left to right, identical character identity, lighting and color grading across every panel for perfect consistency: COLUMN 1 (largest, leftmost, about 30% of the frame): chest-up portrait, slightly off-frontal three-quarter view, head and upper chest in frame, sharp focus on the eyes, clearly visible iris color, soft catchlights in both eyes, natural slight facial asymmetry. COLUMN 2: full-body front view framed from the shoulders down with the head cropped out of frame, standing relaxed neutral A-pose, arms slightly away from the body. COLUMN 3 (rightmost): full-body back view framed from the shoulders down, same pose mirrored, showing back posture, garment fit and shoe heels. CHARACTER (must remain identical in all panels): ${character} LIGHTING & RENDER: clean soft even studio lighting, large diffused key light with gentle fill, soft natural shadows, no rim light, no harsh highlights, true-to-life skin tones with visible pores, neutral white balance, photographic not a 3D game render, shot on full-frame camera with an 85mm lens look, crisp detail.`;
}

async function characterSheetPrompt(brief: string, tone: string, feedback: string) {
  const system = `You write the CHARACTER block of a character reference sheet (the layout is fixed by the pipeline).
Cover in order, with concrete visible detail (concrete nouns, never quality words): species/type, age range, build/height, face shape and features, skin texture, eye color (never black), hair, distinguishing marks, default expression, outfit in concrete material terms.
Also give a short "subject" noun phrase (e.g. "young Korean woman", "old fisherman", "small forest creature").
If REVIEWER FEEDBACK is given, fix exactly that.
${skillMode() === 'full' && skillText('characterSheet') ? 'STUDIO SKILL:\n' + skillText('characterSheet', 8000) + '\n' : ''}Output ONLY JSON: {"subject": "...", "character": "..."}`;
  const user = `BRIEF: ${brief}\nBRAND TONE / LOOK: ${tone || '(none)'}${feedback ? `\nREVIEWER FEEDBACK ON PREVIOUS SHEET: ${feedback}` : ''}`;
  const d = await chatJson(system, user, undefined, 1000, { type: 'object', properties: { subject: { type: 'string' }, character: { type: 'string' } }, required: ['subject', 'character'] }, true);
  const character = lintPrompt(String(d.character ?? '').trim()).text;
  if (!character) throw new Error('LLM이 캐릭터 설명을 만들지 못했어요');
  return { positive: characterSheetTemplate(String(d.subject || 'character').trim(), character), negative: 'white background, black background, black eyes, dead eyes, symmetrical face, waxy skin, 3D render, game character, rim light, text, watermark' };
}

/** refs: 참조 이미지가 있으면 각 번호의 설명 (예: ["제품", "인물", "라벨/로고"]) — 있으면 레퍼런스 편집용 지시문으로 작성 */
export async function enhancePrompt(brief: string, tone: string, feedback = '', refs: string[] | boolean = false, opt: PromptOpts = {}) {
  const refList = Array.isArray(refs) ? refs : [];
  const useRef = Array.isArray(refs) ? refList.length > 0 : !!refs;
  const tok = (n: number) => (opt.refToken ?? 'image {n}').replace('{n}', String(n));
  const mode = skillMode();
  let user = `BRIEF: ${brief}\nBRAND TONE: ${tone || '(none)'}`;
  if (useRef) user += refList.length ? `\nREFERENCE IMAGES:\n${refList.map((l, i) => `- ${tok(i + 1)}: ${l}`).join('\n')}` : '\nREFERENCE IMAGES: attached to the workflow';
  if (feedback) user += `\nREVIEWER FEEDBACK ON PREVIOUS ${opt.video ? 'CLIP' : 'IMAGE'}: ${feedback}`;
  const kind: SlotKind = opt.video ? 'video' : 'image';

  // 캐릭터 시트: 고정 템플릿 + CHARACTER 블록만 LLM
  if (opt.profile === 'character_sheet' && !opt.video && !useRef && mode !== 'off') {
    try { return await characterSheetPrompt(brief, tone, feedback); } catch (e: any) { console.warn('[prompt] 캐릭터 시트 작성 실패, 기본 방식으로:', e.message); }
  }

  // compact: 빈칸 채우기
  if (mode === 'compact') {
    try {
      const refsNote = useRef
        ? `Reference images are attached. Refer to each one exactly by its tag (${refList.length ? refList.map((_, i) => tok(i + 1)).join(', ') : tok(1)}) inside "subject". The product's shape, colours, label and logo, and a person's face, hair and outfit stay identical to the reference.`
        : 'No reference images: describe the subject fully.';
      const r = await slotPrompt(kind, SLOT_SYSTEM(opt.video ? 'video' : 'image', refsNote, skillAppendix(kind, opt), kind), user);
      let positive = lintPrompt(r.positive).text;
      if (useRef && refList.length) positive = ensureRefs(positive, refList, tok, !!opt.video);
      return { positive, negative: r.negative || 'garbled text, distorted product, extra fingers, blurry, watermark' };
    } catch (e: any) { console.warn('[prompt] 슬롯 방식 실패, 기본 방식으로:', e.message); }
  }

  let system = opt.video
    ? (useRef ? REF_VIDEO_PROMPT_SYSTEM.replaceAll('{TOKEN_EXAMPLE}', `${tok(1)}, ${tok(2)}`) : VIDEO_PROMPT_SYSTEM)
    : (useRef ? REF_PROMPT_SYSTEM : PROMPT_GEN_SYSTEM);
  if (mode !== 'off') system = withSkills(system, skillAppendix(kind, opt));
  const finish = (positive: string, negative: string) => {
    if (mode === 'off') return { positive, negative };
    let p = lintPrompt(positive).text;
    if (useRef && refList.length) p = ensureRefs(p, refList, tok, !!opt.video);
    return { positive: p, negative };
  };
  try {
    const d = await chatJson(system, user, undefined, mode === 'full' ? 2500 : 1500, PROMPT_SCHEMA, true);
    const positive = String(d.positive ?? '').trim();
    if (positive) return finish(positive, String(d.negative ?? '').trim());
  } catch { /* 아래 텍스트 모드로 한 번 더 */ }
  // JSON을 못 지키는 모델 대비: 프롬프트 문장만 받아서 사용
  const raw = await chat(system.replace(/Output ONLY a JSON object[\s\S]*$/, 'Output ONLY the final English prompt as one paragraph. No analysis, no bullet points, no headings, no JSON.'), user, undefined, 800);
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').split(/\n\s*\n/).map((x) => x.replace(/^[\s*#>-]+/gm, '').trim()).filter((x) => x.length > 60 && !/^(brief|brand tone|reference|analysis)\b/i.test(x)).pop();
  if (!text) throw new Error('LLM이 프롬프트를 만들지 못했어요');
  return finish(text.slice(0, 1200), 'garbled text, misspelled label, distorted product, extra fingers, blurry, watermark');
}

export async function enhanceMotionPrompt(idea: string, tone: string, labelSafe = false, refToken?: string, opt: PromptOpts = {}) {
  const extra = labelSafe ? '\nLABEL-SAFE MODE: the product label/logo must stay readable. Keep the product upright, facing the camera and mostly still; NO rotating, turning, flipping or tilting the product; no hands covering the label. Prefer a slow camera push-in or gentle parallax, soft light changes, subtle background motion.' : '';
  const tokenNote = refToken ? `\nThe start image is referred to as ${refToken.replace('{n}', '1')} in this model; mention it once (e.g. "the product from ${refToken.replace('{n}', '1')}").` : '';
  const user = `MOTION IDEA: ${idea}\nBRAND TONE: ${tone || '(none)'}${extra}${tokenNote}`;
  const mode = skillMode();
  if (mode === 'compact') {
    try {
      const r = await slotPrompt('motion', SLOT_SYSTEM('image-to-video MOTION (the first frame already exists — do not re-describe its look)', 'Keep the product shape, colours and any person identity unchanged. No morphing, no new objects appearing.', skillAppendix('motion', { ...opt, video: true }), 'motion'), user);
      let positive = lintPrompt(r.positive).text;
      if (refToken && !positive.toLowerCase().includes(refToken.replace('{n}', '1').toLowerCase())) positive = positive.replace('Use the provided start image as the first frame.', `Use the provided start image (${refToken.replace('{n}', '1')}) as the first frame.`);
      return positive;
    } catch (e: any) { console.warn('[prompt] 모션 슬롯 방식 실패, 기본 방식으로:', e.message); }
  }
  const system = mode === 'off' ? MOTION_PROMPT_SYSTEM : withSkills(MOTION_PROMPT_SYSTEM, skillAppendix('motion', { ...opt, video: true }));
  const d = await chatJson(system, user, undefined, mode === 'full' ? 2000 : 1200, { type: 'object', properties: { positive: { type: 'string' } }, required: ['positive'] }, true);
  const positive = String(d.positive ?? '').trim();
  if (!positive) throw new Error('LLM이 빈 모션 프롬프트를 돌려줬어요');
  return mode === 'off' ? positive : lintPrompt(positive).text;
}

// ───────────────────────── 검수 (shot-prep: 3단계 검증 · 슬롭 검사 · 원인 진단) ─────────────────────────

export interface ReviewCtx {
  brief: string;
  tone: string;
  prompt: string;
  video?: boolean;
  refs?: boolean;
  refPanel?: boolean;
  profile?: QcProfile;
  /** 생성 모델 이름 (모델별 슬롭 특징 안내용) */
  modelHint?: string;
}
export interface ReviewResult { score: number; defects: string[]; reason: string; cause?: 'source' | 'motion' | 'none' }

function fingerprints(hint = '') {
  if (/gpt[\s_-]*image/i.test(hint)) return '- This image came from GPT Image: watch for cranked sharpness and hard edge halos, no depth-of-field separation, warm/yellow white balance, plastic-smooth materials, one texture pattern repeated over unrelated surfaces (slop_texture).';
  if (/nano[\s_-]*banana|gemini/i.test(hint)) return '- This image came from Nano Banana: watch for ruler-straight symmetry, everything parallel, flat even light (staged stock-photo feel), edits applied far too literally (unrequested_change).';
  return '';
}

const PROFILE_RULES: Record<QcProfile, string> = {
  default: '',
  character_sheet: `CHARACTER SHEET RULES (code sheet_rule unless another code fits better):
- background is a flat deep neutral grey (#3a3a3c) — not white, not black, no mottled or grimy patches
- leftmost portrait panel is the largest (about 25-30% of the frame), chest-up, angled slightly off-frontal (not dead-on)
- eyes: iris colour clearly readable (never black), a catchlight in both eyes
- full-body front and back panels show the same outfit and build as the portrait; if their heads are visible the faces must match the portrait (identity_drift if not)
- the face is not perfectly mirror-symmetric; skin has pores and texture (waxy / soapy skin = slop_texture)
- photographic, not a 3D game render; no baked-in rim light`,
  location: `LOCATION PLATE RULES (code location_rule unless another code fits better):
- one consistent light source; every shadow falls the same way; smooth falloff, no crushed shadows, no blown highlights
- 3/4 view that shows side geometry and separates foreground, midground and background (a flat dead-on backdrop = location_rule)
- one clear anchor object exists for later blocking
- atmospheric depth: far elements slightly softer and hazier than near ones (near and far equally sharp = location_rule)
- doors, windows, stairs and structures are believable (geometry_break if not); real material texture (oily surfaces = slop_texture)`,
};

const REVIEW_SCHEMA2 = {
  type: 'object',
  properties: {
    checks: {
      type: 'object',
      properties: {
        landed: { type: 'string', enum: ['yes', 'no'] },
        unchanged: { type: 'string', enum: ['yes', 'no', 'n/a'] },
        clean: { type: 'string', enum: ['yes', 'no'] },
      },
      required: ['landed', 'unchanged', 'clean'],
    },
    score: { type: 'integer', minimum: 0, maximum: 10 },
    defects: { type: 'array', items: { type: 'string', enum: Object.keys(DEFECT_CODES) } },
    cause: { type: 'string', enum: ['source', 'motion', 'none'] },
    reason: { type: 'string' },
  },
  required: ['checks', 'score', 'defects', 'cause', 'reason'],
};

function reviewSystem2(c: ReviewCtx): string {
  const profile = c.profile ?? 'default';
  const base = reviewSystem(!!c.video, !!c.refs, !!c.refPanel, profile).replace(/Score 0-10[\s\S]*$/, '');
  const codes = Object.entries(DEFECT_CODES)
    .filter(([k]) => (c.video || k !== 'motion_artifact') && (k !== 'sheet_rule' || profile === 'character_sheet') && (k !== 'location_rule' || profile === 'location'))
    .map(([k, v]) => `- "${k}": ${v}`).join('\n');
  const full = skillMode() === 'full' ? [skillText('shotPrep', 9000), profile === 'character_sheet' ? skillText('characterSheet', 6000) : ''].filter(Boolean).join('\n\n') : '';
  return `${base}
${PROFILE_RULES[profile] ? PROFILE_RULES[profile] + '\n' : ''}
VERIFY — proof, not promises (fill "checks"; judge the actual pixels, never the prompt's claims):
- landed: did the specific ask of the brief actually land? ("no" → off_brief)
- unchanged: is everything that must stay the same still the same — product or character identity versus the reference, layout, materials? "n/a" when there is no reference. ("no" → identity_drift or product_distortion)
- clean: nothing broken or silently added — no new artifacts, shifted layout, hidden face, tone shift or objects nobody asked for? ("no" → unrequested_change or geometry_break)
SLOP SCAN — a visible still-frame defect is already a fail, do not wait for motion:
- broken-but-plausible objects (railings, crates, fingers, cables that would turn to mush in motion) → geometry_break
- oily / soapy / waxy surfaces, plastic skin, cranked sharpness with hard edge halos, one texture repeated over unrelated surfaces → slop_texture
- local logic breaks (an effect confined to one part of the frame) → geometry_break
${fingerprints(c.modelHint)}
${c.video ? `CAUSE (fill "cause"): when there is a defect, say whether it is already visible in the ${c.refPanel ? 'leftmost REFERENCE panel' : 'FIRST frame'} or tied to the same feature in every frame ("source" — the input asset must be fixed), or appears only through the movement ("motion" — the motion/camera direction must be revised). "none" when there is no defect.` : 'CAUSE: always "none" for still images.'}
${full ? `\nSTUDIO REVIEW SKILL (apply its verification and slop rules; ignore its output format):\n${full}\n` : ''}
Score 0-10 (10 = ready to publish, 7 = acceptable with no visible defects, 4 = clear defect, 0 = unusable). Any "no" in checks means score 6 or lower.
Pick defects ONLY from these codes (empty list if none):
${codes}

Write "reason" in Korean, one short sentence a designer can act on (what is wrong and where).
Output ONLY a JSON object, nothing else:
{"checks": {"landed": "yes|no", "unchanged": "yes|no|n/a", "clean": "yes|no"}, "score": <int 0-10>, "defects": ["code", ...], "cause": "source|motion|none", "reason": "..."}`;
}

/** 작은 비전 모델용: 예/아니오 질문 여러 번 (질문이 짧을수록 작은 모델이 정확함) */
async function reviewSplit(img: Buffer, c: ReviewCtx): Promise<ReviewResult> {
  const profile = c.profile ?? 'default';
  const what = c.video ? (c.refPanel ? 'This image shows a REFERENCE panel (leftmost) and the first, middle and last frames of a generated video.' : 'This image shows the first, middle and last frames of a generated video side by side.') : 'This is a generated image.';
  const Q: { code: string; q: string; ko: string }[] = [
    { code: 'off_brief', q: `Does it clearly show what this brief asks for? BRIEF: ${c.brief}`, ko: '기획 내용과 다름' },
  ];
  if (c.refs || c.refPanel) Q.push({ code: 'product_distortion', q: 'Does the product keep the same shape, colours, cap and label layout as in the reference (small blurry print does not matter)?', ko: '제품 형태·라벨이 원본과 다름' });
  Q.push({ code: 'identity_drift', q: c.video ? 'Do all people and characters keep the same face, hair and outfit in every frame (answer YES if there are no people)?' : 'If a reference person or character is involved, do the face, hair and outfit match it? (answer YES if not applicable)', ko: '인물·캐릭터 얼굴이나 의상이 달라짐' });
  Q.push({ code: 'anatomy', q: 'Are all visible hands, fingers, faces and limbs anatomically correct? (answer YES if there are no people)', ko: '손·얼굴·인체가 깨짐' });
  Q.push({ code: 'text_artifact', q: 'Is every LARGE visible text made of correctly spelled real words (answer YES if there is no large text)?', ko: '큰 글자가 깨지거나 철자가 틀림' });
  Q.push({ code: 'slop_texture', q: 'Do the surfaces look like real materials — no oily, waxy or plastic sheen and no over-sharpened halos?', ko: '번들거리거나 플라스틱 같은 질감' });
  Q.push({ code: 'geometry_break', q: 'Are all objects and structures physically coherent — nothing melted, merged or impossible?', ko: '물체·구조물이 녹거나 말이 안 되는 형태' });
  if (c.video) Q.push({ code: 'motion_artifact', q: 'Across the video frames, does everything keep the same shape and count, with no morphing or sudden jumps?', ko: '프레임 사이에 형태가 변함' });
  if (c.tone) Q.push({ code: 'brand_tone', q: `Do the colours, light and mood match this look: ${c.tone}?`, ko: '톤앤매너가 다름' });
  if (profile === 'character_sheet') {
    Q.push({ code: 'sheet_rule', q: 'Is the largest panel a chest-up portrait on the left, slightly off-frontal, with clearly coloured irises (not black) and a catchlight in each eye?', ko: '초상 패널·눈(홍채·캐치라이트) 규칙 위반' });
    Q.push({ code: 'sheet_rule', q: 'Does the face look natural and slightly asymmetric with real skin texture, photographic rather than a 3D game render?', ko: '대칭 얼굴·3D 렌더 느낌' });
  }
  if (profile === 'location') {
    Q.push({ code: 'location_rule', q: 'Is there one consistent light source with all shadows falling the same way?', ko: '광원·그림자 방향이 맞지 않음' });
    Q.push({ code: 'location_rule', q: 'Is the view a 3/4 angle with clear foreground, midground and background depth (not a flat dead-on backdrop)?', ko: '3/4 시점·깊이감 부족' });
  }
  const failed: typeof Q = [];
  for (const x of Q) {
    try {
      const d = await chatJson('You are a strict visual inspector. Look at the image and answer the question with yes or no only.', `${what}\nQUESTION: ${x.q}\nOutput ONLY JSON: {"answer": "yes"} or {"answer": "no"}`, img, 60, { type: 'object', properties: { answer: { type: 'string', enum: ['yes', 'no'] } }, required: ['answer'] });
      if (String(d.answer).toLowerCase().startsWith('n')) failed.push(x);
    } catch { /* 이 질문만 건너뜀 */ }
  }
  let cause: ReviewResult['cause'] = 'none';
  if (c.video && failed.length) {
    try {
      const d = await chatJson('You are a strict visual inspector. Answer with yes or no only.', `${what}\nQUESTION: Is this problem already visible in the ${c.refPanel ? 'leftmost REFERENCE panel' : 'FIRST frame'}: ${failed.map((f) => f.q).join(' / ')} — answer YES if the problem is already there before any motion.\nOutput ONLY JSON: {"answer": "yes"} or {"answer": "no"}`, img, 60, { type: 'object', properties: { answer: { type: 'string', enum: ['yes', 'no'] } }, required: ['answer'] });
      cause = String(d.answer).toLowerCase().startsWith('y') ? 'source' : 'motion';
    } catch { cause = 'none'; }
  }
  const defects = [...new Set(failed.map((f) => f.code))];
  const major = failed.some((f) => ['off_brief', 'product_distortion', 'identity_drift'].includes(f.code));
  const score = failed.length ? Math.max(1, Math.min(major ? 4 : 6, 9 - 2 * failed.length)) : 9;
  return { score, defects, reason: failed.length ? [...new Set(failed.map((f) => f.ko))].join(', ') : '예·아니오 점검 항목을 모두 통과했어요', cause };
}

/** 검수: single(체크리스트 한 번) / split(작은 질문 여러 번). 프로필·스킬 규칙 반영 */
export async function review(img: Buffer, c: ReviewCtx): Promise<ReviewResult> {
  const s = getSettings().llm;
  if (skillMode() === 'off' && (c.profile ?? 'default') === 'default') {
    const r = await reviewImage(img, c.brief, c.tone, c.prompt, c.video, c.refs, c.refPanel);
    return { ...r, cause: 'none' };
  }
  if (s.qcMode === 'split') return reviewSplit(img, c);
  const user = `BRIEF: ${c.brief}\nBRAND TONE: ${c.tone || '(none)'}\nPROMPT USED: ${c.prompt}`;
  let d: any;
  try { d = await chatJson(reviewSystem2(c), user, img, 2500, REVIEW_SCHEMA2); }
  catch {
    // 형식을 못 지키면 기존 방식(점수·결함·사유만)으로
    const r = await reviewImage(img, c.brief, c.tone, c.prompt, c.video, c.refs, c.refPanel);
    return { ...r, cause: 'none' };
  }
  let score = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)));
  const defects = new Set<string>((Array.isArray(d.defects) ? d.defects : []).map(String).filter((x: string) => x in DEFECT_CODES));
  const ch = d.checks ?? {};
  // 체크가 "아니오"인데 결함 목록이 비어 있으면 코드가 채움 (작은 모델이 자주 빠뜨림)
  if (ch.landed === 'no' && !defects.has('off_brief')) defects.add('off_brief');
  if (ch.unchanged === 'no' && !defects.has('identity_drift') && !defects.has('product_distortion')) defects.add(c.refs ? 'identity_drift' : 'product_distortion');
  if (ch.clean === 'no' && !['unrequested_change', 'geometry_break', 'slop_texture', 'low_quality', 'text_artifact', 'anatomy'].some((k) => defects.has(k))) defects.add('unrequested_change');
  if (defects.size || [ch.landed, ch.unchanged, ch.clean].includes('no')) score = Math.min(score, 6);
  const cause = c.video && ['source', 'motion'].includes(d.cause) && defects.size ? d.cause : 'none';
  return { score, defects: [...defects], reason: String(d.reason ?? '').slice(0, 300), cause };
}

export async function reviewImage(imageJpeg: Buffer, brief: string, tone: string, prompt: string, video = false, refs = false, refPanel = false) {
  const user = `BRIEF: ${brief}\nBRAND TONE: ${tone || '(none)'}\nPROMPT USED: ${prompt}`;
  let d: any;
  try { d = await chatJson(reviewSystem(video, refs, refPanel), user, imageJpeg, 2000, REVIEW_SCHEMA); }
  catch {
    // JSON 대신 분석 메모를 길게 쓰다 잘리는 경우 대비: 정해진 3줄 형식으로 다시 받아서 파싱
    const sys = reviewSystem(video, refs, refPanel).replace(/Output ONLY a JSON object[\s\S]*$/, 'Do NOT analyse step by step. Answer in exactly three lines:\nSCORE: <0-10>\nDEFECTS: <comma separated codes or none>\nREASON: <one short Korean sentence>');
    const raw = (await chat(sys, user, imageJpeg, 400)).replace(/<think>[\s\S]*?<\/think>/g, '');
    const sc = raw.match(/SCORE\s*[:：]\s*(\d+)/i);
    if (!sc) throw new Error('검수 응답 형식을 읽지 못했어요');
    const df = raw.match(/DEFECTS\s*[:：]\s*([^\n]*)/i)?.[1] ?? '';
    d = { score: Number(sc[1]), defects: /none|없음/i.test(df) ? [] : df.split(/[,\s]+/).filter(Boolean), reason: raw.match(/REASON\s*[:：]\s*([^\n]*)/i)?.[1] ?? '' };
  }
  const score = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)));
  const defects = [...new Set<string>((Array.isArray(d.defects) ? d.defects : []).map(String))].filter((x) => x in DEFECT_CODES);
  return { score, defects, reason: String(d.reason ?? '').slice(0, 300) };
}

/** VRAM 교대: 이미지 생성 전에 LM Studio 모델을 내림. 다른 LLM 요청이 끝난 뒤에만 실행 (실패해도 무시) */
export async function unloadLlm() {
  const s = getSettings().llm;
  if (s.backend !== 'lmstudio') return;
  await exclusive(async () => {
    try {
      await fetch(s.lmstudioUrl.replace(/\/+$/, '') + '/api/v1/models/unload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instance_id: s.lmstudioModel }),
        signal: AbortSignal.timeout(8000),
      });
    } catch { /* 이미 내려가 있으면 무시 */ }
  });
}

export async function llmStatus() {
  const s = getSettings().llm;
  if (s.backend === 'claude') return { ok: !!s.anthropicKey, backend: 'claude', model: s.claudeModel, models: [s.claudeModel], hasModel: !!s.anthropicKey, error: s.anthropicKey ? null : 'API 키 없음' };
  if (s.backend === 'openai') {
    try {
      const r = await fetch(baseV1(s.openaiUrl) + '/models', { headers: s.openaiKey ? { Authorization: `Bearer ${s.openaiKey}` } : {}, signal: AbortSignal.timeout(4000) });
      const j: any = await r.json();
      const models: string[] = (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
      const has = !s.openaiModel ? false : models.length ? models.includes(s.openaiModel) : true;
      return { ok: r.ok, backend: 'openai', model: s.openaiModel, models, hasModel: has, error: !s.openaiModel ? '모델 이름을 입력해 주세요' : has ? null : '설정한 모델이 목록에 없어요' };
    } catch {
      return { ok: false, backend: 'openai', model: s.openaiModel, models: [], hasModel: false, error: 'LLM 서버에 연결할 수 없어요' };
    }
  }
  try {
    const r = await fetch(s.lmstudioUrl.replace(/\/+$/, '') + '/v1/models', { signal: AbortSignal.timeout(3000) });
    const j: any = await r.json();
    const models: string[] = (j.data ?? []).map((m: any) => m.id);
    return { ok: true, backend: 'lmstudio', model: s.lmstudioModel, models, hasModel: models.includes(s.lmstudioModel), error: models.includes(s.lmstudioModel) ? null : '설정한 모델이 목록에 없어요' };
  } catch {
    return { ok: false, backend: 'lmstudio', model: s.lmstudioModel, models: [], hasModel: false, error: 'LM Studio 서버 꺼짐' };
  }
}
