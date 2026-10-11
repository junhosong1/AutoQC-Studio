// 상품 사진 정리: AVIF/HEIC/TIFF/GIF → PNG, 투명 배경 → 흰색, 휴대폰 사진 회전(EXIF) 바로잡기
import sharp from 'sharp';

export const PRODUCT_EXT = /\.(png|jpe?g|webp|avif|heic|heif|tiff?|gif)$/i;

export async function normalizeProduct(buf: Buffer, name: string): Promise<{ buf: Buffer; name: string; changed: string[] }> {
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const changed: string[] = [];
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '')) changed.push(`${(name.split('.').pop() || meta.format || '').toLowerCase()}→png`);
    if (meta.hasAlpha) changed.push('투명 배경→흰색');
    if ((meta.orientation ?? 1) > 1) changed.push('회전 보정');
    if (!changed.length) return { buf, name, changed };
    const out = await sharp(buf, { failOn: 'none', pages: 1 }).rotate().flatten({ background: '#ffffff' }).png().toBuffer();
    return { buf: out, name: name.replace(/\.[^.]+$/, '') + '.png', changed };
  } catch {
    return { buf, name, changed: [] }; // 읽을 수 없으면 원본 그대로 (ComfyUI가 판단)
  }
}
