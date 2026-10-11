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
