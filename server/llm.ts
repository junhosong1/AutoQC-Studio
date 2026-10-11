// LLM 어댑터 — 두 가지 역할
//   1) 프롬프트 생성기 : 한국어 기획 문장 → 이미지 모델용 영어 프롬프트(JSON)
//   2) 검수자(Reviewer): 생성 이미지 + 기획 의도 → 점수/결함 코드/사유(JSON)
// 백엔드: LM Studio(로컬, OpenAI 호환) 또는 Claude API
import { getSettings } from './config.js';

export const DEFECT_CODES: Record<string, string> = {
  off_brief: '기획 의도·프롬프트와 내용 불일치',
  product_distortion: '제품 형태·로고·비율 변형',
  anatomy: '손·얼굴·인체 파손',
  text_artifact: '깨진 글자·의미 없는 텍스트',
  low_quality: '노이즈·뭉개짐·과포화 등 저품질',
  composition: '구도·크롭 문제 (주제가 잘림 등)',
  brand_tone: '톤앤매너(색감·무드) 불일치',
  motion_artifact: '영상: 프레임 간 형태 변형·깜빡임·멈춤',
};

/** 이 결함들은 프롬프트를 고쳐야 해결됨 → 피드백을 넣어 프롬프트 재작성. 나머지는 시드만 바꿔 재시도 */
export const PROMPT_DEFECTS = new Set(['off_brief', 'brand_tone', 'text_artifact']);

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

function reviewSystem(video = false, refs = false, refPanel = false) {
  const codes = Object.entries(DEFECT_CODES).filter(([k]) => video || k !== 'motion_artifact').map(([k, v]) => `- "${k}": ${v}`).join('\n');
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
   This image was composed from reference photos: the product label / logo should match the real product. Invented or scrambled label wording is text_artifact; tiny print that is just too small to read is fine.` : ''}
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
    if (e?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(e?.message)) throw new Error('LLM 서버에 연결할 수 없어요. LM Studio 서버(1234)가 켜져 있는지 확인해 주세요.');
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

async function chatRaw(system: string, user: string, imageJpeg: Buffer | undefined, maxTokens: number, schema?: any): Promise<string> {
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
  const body: any = {
    model: s.lmstudioModel,
    temperature: s.temperature,
    max_tokens: maxTokens,
    ttl: getSettings().vramSaver ? 60 : 900,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
  };
  // LM Studio 구조화 출력: JSON 형식을 강제 (지원 안 하면 한 번 빼고 다시)
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } };
  let r: any;
  try { r = await post(s.lmstudioUrl.replace(/\/+$/, '') + '/v1/chat/completions', body, {}); }
  catch (e: any) {
    if (!schema || !/\(4\d\d\)/.test(e.message) || /unloaded/i.test(e.message)) throw e;
    delete body.response_format;
    r = await post(s.lmstudioUrl.replace(/\/+$/, '') + '/v1/chat/completions', body, {});
  }
  const msg = r.choices?.[0]?.message ?? {};
  return msg.content || msg.reasoning_content || '';
}

/** JSON을 못 받으면 한 번 더 요청 (모델이 내려갔다는 오류도 한 번 재시도) */
async function chatJson(system: string, user: string, imageJpeg: Buffer | undefined, maxTokens: number, schema?: any): Promise<any> {
  return exclusive(async () => {
    let lastErr: any;
    for (let i = 0; i < 2; i++) {
      try {
        const raw = await chatRaw(system, i === 0 ? user : user + '\n\nIMPORTANT: Reply with ONLY the JSON object. No analysis, no markdown.', imageJpeg, maxTokens, schema);
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
export async function enhancePrompt(brief: string, tone: string, feedback = '', refs: string[] | boolean = false, opt: { video?: boolean; refToken?: string } = {}) {
  const refList = Array.isArray(refs) ? refs : [];
  const useRef = Array.isArray(refs) ? refList.length > 0 : !!refs;
  const tok = (n: number) => (opt.refToken ?? 'image {n}').replace('{n}', String(n));
  let user = `BRIEF: ${brief}\nBRAND TONE: ${tone || '(none)'}`;
  if (useRef) user += refList.length ? `\nREFERENCE IMAGES:\n${refList.map((l, i) => `- ${tok(i + 1)}: ${l}`).join('\n')}` : '\nREFERENCE IMAGES: attached to the workflow';
  if (feedback) user += `\nREVIEWER FEEDBACK ON PREVIOUS ${opt.video ? 'CLIP' : 'IMAGE'}: ${feedback}`;
  const system = opt.video
    ? (useRef ? REF_VIDEO_PROMPT_SYSTEM.replaceAll('{TOKEN_EXAMPLE}', `${tok(1)}, ${tok(2)}`) : VIDEO_PROMPT_SYSTEM)
    : (useRef ? REF_PROMPT_SYSTEM : PROMPT_GEN_SYSTEM);
  try {
    const d = await chatJson(system, user, undefined, 1500, PROMPT_SCHEMA);
    const positive = String(d.positive ?? '').trim();
    if (positive) return { positive, negative: String(d.negative ?? '').trim() };
  } catch { /* 아래 텍스트 모드로 한 번 더 */ }
  // JSON을 못 지키는 모델 대비: 프롬프트 문장만 받아서 사용
  const raw = await chat(system.replace(/Output ONLY a JSON object[\s\S]*$/, 'Output ONLY the final English prompt as one paragraph. No analysis, no bullet points, no headings, no JSON.'), user, undefined, 800);
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').split(/\n\s*\n/).map((x) => x.replace(/^[\s*#>-]+/gm, '').trim()).filter((x) => x.length > 60 && !/^(brief|brand tone|reference|analysis)\b/i.test(x)).pop();
  if (!text) throw new Error('LLM이 프롬프트를 만들지 못했어요');
  return { positive: text.slice(0, 1200), negative: 'garbled text, misspelled label, distorted product, extra fingers, blurry, watermark' };
}

export async function enhanceMotionPrompt(idea: string, tone: string, labelSafe = false, refToken?: string) {
  const extra = labelSafe ? '\nLABEL-SAFE MODE: the product label/logo must stay readable. Keep the product upright, facing the camera and mostly still; NO rotating, turning, flipping or tilting the product; no hands covering the label. Prefer a slow camera push-in or gentle parallax, soft light changes, subtle background motion.' : '';
  const tokenNote = refToken ? `\nThe start image is referred to as ${refToken.replace('{n}', '1')} in this model; mention it once (e.g. "the product from ${refToken.replace('{n}', '1')}").` : '';
  const d = await chatJson(MOTION_PROMPT_SYSTEM, `MOTION IDEA: ${idea}\nBRAND TONE: ${tone || '(none)'}${extra}${tokenNote}`, undefined, 1200, { type: 'object', properties: { positive: { type: 'string' } }, required: ['positive'] });
  const positive = String(d.positive ?? '').trim();
  if (!positive) throw new Error('LLM이 빈 모션 프롬프트를 돌려줬어요');
  return positive;
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
  try {
    const r = await fetch(s.lmstudioUrl.replace(/\/+$/, '') + '/v1/models', { signal: AbortSignal.timeout(3000) });
    const j: any = await r.json();
    const models: string[] = (j.data ?? []).map((m: any) => m.id);
    return { ok: true, backend: 'lmstudio', model: s.lmstudioModel, models, hasModel: models.includes(s.lmstudioModel), error: models.includes(s.lmstudioModel) ? null : '설정한 모델이 목록에 없어요' };
  } catch {
    return { ok: false, backend: 'lmstudio', model: s.lmstudioModel, models: [], hasModel: false, error: 'LM Studio 서버 꺼짐' };
  }
}
