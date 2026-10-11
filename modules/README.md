# 모듈 추가하는 법

폴더 하나 = 모듈 하나입니다. 코드를 고치지 않고 폴더만 넣으면 화면 메뉴에 나타나요.

```
modules/
  qwen_t2i/
    workflow.json    ← ComfyUI 워크플로우 (API 형식)
    manifest.json    ← 이름, 설명, 라이선스 등 (선택)
```

## 방법 1. 앱에서 가져오기 (가장 쉬움)

1. ComfyUI에서 원하는 워크플로우를 한 번 실행
2. AutoQC Studio → [모듈 · 설정] → **ComfyUI 최근 실행에서 가져오기**
3. 목록에서 고르고 ID·이름을 정한 뒤 가져오기

- 프롬프트 칸은 자동으로 `PROMPT_HERE`로 바뀝니다.
- Deno 같은 LLM 노드는 자동으로 빠집니다 (프롬프트 확장·검수는 앱이 담당).

## 방법 2. Export (API) 파일 넣기

1. ComfyUI에서 프롬프트 칸에 `PROMPT_HERE`, (선택) 네거티브 칸에 `NEGATIVE_HERE` 입력
2. Workflow → **Export (API)** 로 저장
3. `modules/<새 폴더>/workflow.json` 으로 넣고 [모듈 새로고침]

## 자동으로 인식하는 것

| 항목 | 인식 기준 |
|---|---|
| 프롬프트 | 문자열에 `PROMPT_HERE`가 들어간 입력 (없으면 텍스트 인코더의 가장 긴 text) |
| 네거티브 | `NEGATIVE_HERE` |
| 시드 | 모든 `seed` / `noise_seed` 입력 |
| 해상도 | `Empty...LatentImage` 노드의 width / height |
| 참조 이미지 | `LoadImage` 노드 (노드 제목이 화면 라벨이 됨) |
| LoRA | LoRA 노드가 있으면 그 값을 바꾸고, 없으면 모델 로더 뒤에 자동 삽입 |
| 고급 설정 | KSampler(steps, cfg, sampler, scheduler, denoise), shift, guidance |

## manifest.json 예시

```json
{
  "name": "Qwen Image 2.1 · 텍스트→이미지",
  "category": "image",
  "description": "기본 이미지 생성용",
  "license": "Apache-2.0",
  "cost": "local",
  "vram": "RTX 3080 12GB (int8)",
  "params": [
    { "key": "75:3.steps", "label": "샘플링 스텝", "min": 4, "max": 40 },
    { "key": "75:66.shift", "hide": true },
    { "key": "75:58.batch_size", "node": "75:58", "input": "batch_size", "type": "int", "label": "배치" }
  ]
}
```

- `category`: `image` | `edit` | `video` | `tool`
- `cost`: `local` | `paid` (유료 API 노드면 paid)
- `params`: 자동 인식된 고급 설정의 라벨·범위 변경, `hide`로 숨기기, 새 노드 값 노출
- 자동 인식이 틀리면 `prompt`, `seeds`, `size`, `images`, `lora`를 직접 지정할 수 있어요.
  예: `"prompt": { "node": "75:6", "input": "text" }`
