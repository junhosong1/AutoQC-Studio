// 제작 스킬 → 파이프라인 규칙
//
// 두 단계로 씁니다.
//   compact : 어떤 LLM(LM Studio 로컬 모델 포함)도 따라올 수 있게 핵심만 압축한 규칙 (이 파일 안)
//   full    : skills/ 폴더의 원문 스킬(.md)을 그대로 붙임 — Claude처럼 긴 규칙을 소화하는 모델용
//
// skills/ 폴더 파일 이름 (있으면 full 모드에서 자동 사용)
//   seedance.md       영상 프롬프트 (Seedance 프롬프트 스킬)
//   leera.md          로케이션·이미지 프롬프트 (Leera 4-D)
//   shot-prep.md      검수 기준 (생성 후 3단계 검증·슬롭 검사·원인 진단)
//   character-sheet.md 캐릭터 시트 검사
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getSettings } from './config.js';

export const SKILLS_DIR = path.join(ROOT, 'skills');
export const SKILL_FILES = {
  seedance: 'seedance.md',
  leera: 'leera.md',
  shotPrep: 'shot-prep.md',
  characterSheet: 'character-sheet.md',
} as const;
export type SkillKey = keyof typeof SKILL_FILES;

const cache = new Map<string, { mtime: number; text: string }>();
/** skills/ 폴더의 원문 스킬. 없으면 '' (frontmatter 제거, 너무 길면 자름) */
export function skillText(key: SkillKey, maxChars = 16000): string {
  const file = path.join(SKILLS_DIR, SKILL_FILES[key]);
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.text;
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/^---[\s\S]*?\n---\s*\n/, '').trim().slice(0, maxChars);
    cache.set(file, { mtime: st.mtimeMs, text });
    return text;
  } catch { return ''; }
}

export function skillStatus() {
  return Object.entries(SKILL_FILES).map(([key, file]) => {
    const p = path.join(SKILLS_DIR, file);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* 없음 */ }
    return { key, file, found: size > 0, size };
  });
}

/** 지금 설정에서 원문 스킬(full)을 쓸지: auto = Claude면 full, 그 외(로컬·범용 모델)는 compact */
export function skillMode(): 'off' | 'compact' | 'full' {
  const s = getSettings().llm;
  const mode = s.skillMode ?? 'auto';
  if (mode === 'auto') return s.backend === 'claude' ? 'full' : 'compact';
  return mode;
}

// ───────────────────────── compact 규칙 (원문 스킬을 짧게 다시 쓴 것) ─────────────────────────

/** shot-prep 1장 + Seedance 스킬의 핵심 원칙: 보이는 것만, 6개 슬롯 */
export const CORE_RULES = `HOUSE RULES (from the studio's shot-prep and prompt skills):
- WRITE THE VISIBLE: describe what a camera would record — concrete nouns, materials, positions, light direction. Never mood or quality words (epic, stunning, beautiful, amazing, masterpiece, breathtaking, perfect, cinematic masterpiece).
- Resolve six decisions explicitly: subject, action, setting, light, camera/framing (and motion for video), constraints. A hint like "summer day" does not say where the light comes from — say it.
- Do not silently add weather, props, people, style or camera moves the brief did not ask for.
- One clear light source with shadows falling away from it; soft sources for interiors.
- The first frame must not be empty: the subject is visible and placed (left third / centre / right third).`;

/** Seedance 프롬프트 스킬 압축본 */
export const SEEDANCE_RULES = `SEEDANCE RULES:
- The prompt is a sealed single-shot document: no scene numbers, no "as before", no characters or props that are not in this shot.
- References: the reference image sets appearance and identity; the text sets what happens. Keep the description of a referenced character or product minimal (role, state, unique visible features, action-critical details). Never mention a reference that is not in this shot.
- State critical small details in words even if they are on the reference (logo colour, label wording, eye colour).
- Style is distributed through the shot (light, lens, texture, grade), not one prefix line of adjectives.
- Say where the subject is, where it looks, how it moves and where it ends. One continuous shot unless cuts are asked for.
- Camera: one named move (static, slow push-in, dolly left, orbit 30 degrees, handheld follow) with speed.
- Audio: ambience and sound effects that match the action; spoken lines only if the brief has them, in double quotes, with who says them.`;

/** Leera(로케이션) 압축본 */
export const LOCATION_RULES = `LOCATION RULES:
- Default camera: 3/4 view that shows side geometry and separates foreground, midground and background — not dead-on.
- Name one anchor object (a sofa, a doorway, a banner, a counter) that later blocking can refer to.
- Explicit light: one sun or one key source; soft sources for interiors; hard visible rays only if asked.
- Tonal palette with smooth falloff, no crushed shadows, no blown highlights; light atmospheric haze for depth.
- Concrete materials ("weathered wood siding", "brushed concrete floor"), never quality words.`;

/** 커머스 공통 (기존 규칙 요약) */
export const COMMERCE_RULES = `COMMERCE RULES:
- The product is the hero, fully inside the frame, true to its real shape, colours and label.
- Never invent logos or readable text. Without reference images ask for no visible text. With reference images the product's own label and logo stay exactly as in the reference.`;

/** 금지어: 분위기·품질 단어 (보이는 것이 아님) */
export const BANNED_WORDS = ['epic', 'stunning', 'breathtaking', 'beautiful', 'beautifully', 'gorgeous', 'amazing', 'awesome', 'masterpiece', 'perfect', 'perfectly', 'incredible', 'magnificent', 'spectacular', 'mesmerizing', 'jaw-dropping', 'best quality', 'ultra quality', 'award-winning', 'award winning'];

/** 프롬프트 점검: 금지어 제거 + 문제 목록 (LLM이 아니라 코드가 검사) */
export function lintPrompt(text: string, opt: { refToken?: string; minWords?: number; maxWords?: number } = {}) {
  const issues: string[] = [];
  let out = text;
  for (const w of BANNED_WORDS) {
    const re = new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\b,?\\s*`, 'gi');
    if (re.test(out)) { issues.push(`mood word "${w}"`); out = out.replace(re, ''); }
  }
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/,\s*\./g, '.').replace(/^[,.\s]+/, '').trim();
  const words = out.split(/\s+/).filter(Boolean).length;
  if (opt.minWords && words < opt.minWords) issues.push(`too short (${words} words)`);
  if (opt.maxWords && words > opt.maxWords) issues.push(`too long (${words} words)`);
  if (opt.refToken && !out.toLowerCase().includes(opt.refToken.toLowerCase())) issues.push(`reference ${opt.refToken} not mentioned`);
  return { text: out, issues };
}

// ───────────────────────── 슬롯 (작은 모델은 빈칸만 채우고, 문장은 코드가 조립) ─────────────────────────

export type SlotKind = 'image' | 'video' | 'motion';

const S = (d: string) => ({ type: 'string', description: d });
export const SLOT_SCHEMAS: Record<SlotKind, any> = {
  image: {
    type: 'object',
    properties: {
      subject: S('main subject with concrete visible details; with references say "the product from image 1"'),
      setting: S('where it is: surfaces, background, anchor object'),
      light: S('light source, direction, softness, colour'),
      camera: S('shot size, angle, lens feel, framing'),
      style: S('grade, texture, palette following the brand tone'),
      constraints: S('what must stay true (identity, label, no text)'),
      negative: S('short comma list of things to avoid'),
    },
    required: ['subject', 'setting', 'light', 'camera', 'style', 'constraints', 'negative'],
  },
  video: {
    type: 'object',
    properties: {
      style: S('visual style carried by light, lens, texture, grade'),
      subject: S('who/what is in frame with concrete visible details; references by their tag'),
      action: S('what moves, start to end, in plain present tense'),
      setting: S('place and anchor object'),
      camera: S('one named camera move with speed, and framing'),
      light: S('light source, direction, quality'),
      audio: S('ambience and sound effects; spoken lines in double quotes only if the brief has them'),
      constraints: S('continuity locks: identity, label, no morphing, no on-screen text'),
      negative: S('short comma list of things to avoid'),
    },
    required: ['style', 'subject', 'action', 'setting', 'camera', 'light', 'audio', 'constraints', 'negative'],
  },
  motion: {
    type: 'object',
    properties: {
      action: S('what moves in the existing first frame, start to end'),
      camera: S('one named camera move with speed'),
      pacing: S('timing / speed of the motion'),
      audio: S('ambience and sound effects'),
    },
    required: ['action', 'camera', 'pacing', 'audio'],
  },
};

const sent = (s?: string) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return /[.!?"]$/.test(t) ? t : t + '.';
};

/** 슬롯 → 한 문단 프롬프트 */
export function assembleSlots(kind: SlotKind, d: any): { positive: string; negative: string; missing: string[] } {
  const req: string[] = SLOT_SCHEMAS[kind].required.filter((k: string) => k !== 'negative');
  const missing = req.filter((k) => !String(d?.[k] ?? '').trim());
  let positive = '';
  if (kind === 'image') {
    positive = [d.subject, d.setting, d.light, d.camera, d.style, d.constraints].map(sent).filter(Boolean).join(' ');
  } else if (kind === 'video') {
    positive = [d.style, d.subject, d.action, d.setting, d.camera, d.light, d.audio ? `Sound: ${String(d.audio).replace(/^sound:\s*/i, '')}` : '', d.constraints].map(sent).filter(Boolean).join(' ');
  } else {
    positive = ['Use the provided start image as the first frame.', d.action, d.camera, d.pacing, d.audio ? `Sound: ${String(d.audio).replace(/^sound:\s*/i, '')}` : '', 'No text, no black frame.'].map(sent).filter(Boolean).join(' ');
  }
  return { positive, negative: String(d?.negative ?? '').trim(), missing };
}
