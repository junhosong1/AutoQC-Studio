import { fileUrl, isVideo } from '../api';

/** 이미지면 img, 영상이면 video (마우스를 올리면 재생) */
export default function Media({ file, poster, controls = false, style, className }: { file?: string; poster?: string; controls?: boolean; style?: React.CSSProperties; className?: string }) {
  if (!file) return null;
  if (isVideo(file)) {
    return (
      <video
        className={className} style={style} src={fileUrl(file)} poster={poster ? fileUrl(poster) : undefined} muted={!controls} loop playsInline preload="metadata" controls={controls} autoPlay={controls}
        onMouseEnter={(e) => { if (!controls) e.currentTarget.play().catch(() => {}); }}
        onMouseLeave={(e) => { if (!controls) { e.currentTarget.pause(); } }}
      />
    );
  }
  return <img className={className} style={style} src={fileUrl(file)} alt="" loading="lazy" />;
}
