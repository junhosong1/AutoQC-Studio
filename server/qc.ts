// 1차 규칙 검수 + 이미지 유틸
// LLM은 느리고 VRAM을 쓰므로, 규칙으로 확실히 잡히는 불량(해상도 틀림, 거의 단색)은 여기서 바로 FAIL.
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export interface Raw { width: number; height: number; data: Buffer | Uint8Array }

export function decode(buf: Buffer): Raw | null {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const p = PNG.sync.read(buf);
      return { width: p.width, height: p.height, data: p.data };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      return { width: j.width, height: j.height, data: j.data };
    }
  } catch { /* */ }
  return null;
}

export function precheck(img: Raw | null, expectW: number | undefined, expectH: number | undefined, minStd: number) {
  if (!img) return { passed: true, defects: [] as string[], reason: '이미지 해석 불가 — 규칙 검수 생략', std: null as number | null, warn: undefined as string | undefined };
  // 해상도가 요청과 다른 건 워크플로우 설정 문제이지 이미지 품질 문제가 아님 → 탈락시키지 않고 메모만
  let warn: string | undefined;
  if (expectW && expectH && (Math.abs(img.width - expectW) > 16 || Math.abs(img.height - expectH) > 16)) {
    warn = `요청 해상도와 다름: ${img.width}×${img.height} (요청 ${expectW}×${expectH})`;
  }
  // 밝기 표준편차 (샘플링)
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 40000));
  let sum = 0, sq = 0, cnt = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    const y = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
    sum += y; sq += y * y; cnt++;
  }
  const mean = sum / cnt;
  const std = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
  if (std < minStd) return { passed: false, defects: ['low_quality'], reason: `거의 단색 이미지 (밝기 표준편차 ${std.toFixed(1)})`, std, warn };
  return { passed: true, defects: [] as string[], reason: '규칙 검수 통과', std, warn };
}

/** 검수용으로 줄인 JPEG (긴 변 maxSide) — LLM 전송량과 처리 시간을 줄임 */
export function toJpeg(img: Raw, maxSide = 896, quality = 85): Buffer {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(w * h * 4);
  const fx = img.width / w, fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
      let r = 0, g = 0, b = 0, c = 0;
      // 박스 평균 (최대 3x3 샘플로 제한해 속도 유지)
      const sy = Math.max(1, Math.floor((y1 - y0) / 3)), sx = Math.max(1, Math.floor((x1 - x0) / 3));
      for (let yy = y0; yy < y1; yy += sy) for (let xx = x0; xx < x1; xx += sx) {
        const o = (yy * img.width + xx) * 4;
        r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; c++;
      }
      const p = (y * w + x) * 4;
      out[p] = r / c; out[p + 1] = g / c; out[p + 2] = b / c; out[p + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: out, width: w, height: h }, quality).data);
}

/** 검수 프로필별 픽셀 규칙 (LLM 없이 확실히 판정되는 것만)
 *  character_sheet: 배경이 #3a3a3c 진회색인지 (테두리 띠를 샘플링)
 *  location: 하이라이트 날아감 / 그림자 뭉개짐 비율
 *  문제없으면 null */
export function profileCheck(img: Raw | null, profile: string): { defects: string[]; reason: string } | null {
  if (!img) return null;
  const { width: W, height: H, data } = img;
  const px = (x: number, y: number) => { const o = (y * W + x) * 4; return [data[o], data[o + 1], data[o + 2]]; };
  if (profile === 'character_sheet') {
    // 위·아래 4% 띠 (패널 사이가 아닌 바깥 여백)
    const band = Math.max(2, Math.round(H * 0.04));
    let n = 0, sr = 0, sg = 0, sb = 0, sq = 0;
    const stepX = Math.max(1, Math.floor(W / 200));
    for (const y0 of [0, H - band]) for (let y = y0; y < y0 + band; y += Math.max(1, Math.floor(band / 4))) for (let x = 0; x < W; x += stepX) {
      const [r, g, b] = px(x, y);
      sr += r; sg += g; sb += b; sq += (r + g + b) * (r + g + b) / 9; n++;
    }
    const mr = sr / n, mg = sg / n, mb = sb / n, lum = (mr + mg + mb) / 3;
    const std = Math.sqrt(Math.max(0, sq / n - lum * lum));
    const chroma = Math.max(mr, mg, mb) - Math.min(mr, mg, mb);
    const problems: string[] = [];
    if (lum > 110) problems.push(`배경이 너무 밝아요 (평균 ${Math.round(lum)}, 기준 #3a3a3c≈58) — 흰 배경은 영상에서 로케이션을 씻어냄`);
    else if (lum < 25) problems.push(`배경이 너무 어두워요 (평균 ${Math.round(lum)}) — 검은 배경은 디테일을 먹음`);
    if (chroma > 22) problems.push('배경에 색이 섞여 있어요 (무채색 회색이어야 함)');
    if (std > 22) problems.push('배경이 얼룩지거나 고르지 않아요');
    return problems.length ? { defects: ['sheet_rule'], reason: '[시트 배경] ' + problems.join(' / ') } : null;
  }
  if (profile === 'location') {
    const n = W * H, step = Math.max(1, Math.floor(n / 60000));
    let hi = 0, lo = 0, c = 0;
    for (let i = 0; i < n; i += step) {
      const o = i * 4;
      const y = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      if (y >= 252) hi++; else if (y <= 4) lo++;
      c++;
    }
    const problems: string[] = [];
    if (hi / c > 0.03) problems.push(`하이라이트가 날아간 영역 ${(100 * hi / c).toFixed(1)}%`);
    if (lo / c > 0.08) problems.push(`그림자가 뭉개진 영역 ${(100 * lo / c).toFixed(1)}%`);
    return problems.length ? { defects: ['location_rule'], reason: '[노출] ' + problems.join(' / ') + ' — 부드러운 계조가 필요해요' } : null;
  }
  return null;
}
