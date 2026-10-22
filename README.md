# AutoQC Studio

**ComfyUI 생성 → Vision LLM 자동 검수 → 결함별 재생성 → 자동 분류**를 한 번에 돌리는 로컬 AI 이미지·영상 제작 파이프라인입니다.
Claude Code가 MCP로 직접 조작할 수 있어, 자연어 지시만으로 제품 여러 개의 대표컷·연출컷·숏폼을 무인으로 뽑을 수 있습니다.

> 2026 독자 R&D · 송준호 (Junho Song)

---

## 한눈에 보기

```
[한국어 기획 문장 / 제품 사진]
        │
        ▼
 ① 프롬프트 확장 (LLM)      브랜드 톤 · 모듈 특성에 맞춰 영문 프롬프트로 확장
        │
        ▼
 ② ComfyUI 생성             HTTP /prompt + WebSocket 진행률, 노드 파라미터 자동 주입
        │                   (seed · steps · cfg · 해상도 · 길이 · LoRA · 레퍼런스 이미지)
        ▼
 ③ 자동 검수 (Vision LLM)    점수 0~10 + 결함 코드 + 사유
        │
   ┌────┴─────┐
  통과        실패 → 결함 유형별 재시도 전략
   │               · off_brief / brand_tone / text_artifact → 검수 사유 반영해 프롬프트 재작성 + 새 시드
   │               · product_distortion / anatomy / low_quality / composition → 새 시드 (+ 해상도 조정)
   ▼
 outputs/_passed/   (최대 시도 초과 시 최고점 컷 → outputs/_failed/ + 사유 기록)
        │
        ▼
 ④ 통계 · 리포트            첫 시도 통과율, 최종 통과율, 결함 분포, 단계별 소요 시간, 크레딧 사용량
```

## 주요 기능

| 영역 | 내용 |
|---|---|
| **이미지 · 영상 생성** | 모듈(워크플로우 폴더) 선택, LLM 프롬프트 확장·미리보기, 브랜드 톤, 레퍼런스 이미지, LoRA, 비율·해상도, 장수·시드, 고급 노드 값 |
| **자동 검수 (Auto-QC)** | Vision LLM이 기획 순응도 · 제품 변형 · 인체 파손 · 텍스트 깨짐 · 화질 · 구도 · 브랜드 톤을 평가 → 결함 코드 7종으로 분류 |
| **자가 치유 재생성** | 결함 원인에 따라 프롬프트 재작성 / 시드 변경 / 해상도 조정을 다르게 적용, 최대 N회 |
| **배치 제작** | 제품 사진 여러 장 × 컷 구성(대표컷 → 연출컷 → 숏폼)을 한 번에. 앞 단계 결과를 다음 단계 입력으로 연결 |
| **유료 / 로컬 모델 혼용** | 로컬: Qwen Image · Krea · LTX · Wan 계열 / 유료 API 노드: GPT Image 2, Seedance 2.0, MiniMax 등 |
| **크레딧 관리** | Comfy 크레딧 잔액, 현재 설정 기준 예상 차감, 생성 후 잔액, 작업별 실제 사용량 기록 |
| **VRAM 절약 모드** | 12GB GPU에서 LLM ↔ 이미지 모델이 번갈아 VRAM을 쓰도록 단계마다 언로드 (LM Studio unload + ComfyUI `/free`) |
| **검수 신뢰도** | 사람이 갤러리에서 채택/반려하면 자동 검수 판정과의 일치율 · 오판 건수 계산 |
| **제작 스킬 적용** | 실제 제작에 쓰는 스킬(shot-prep · Seedance 프롬프트 · Leera 로케이션 · 캐릭터 시트)을 프롬프트 작성과 검수 규칙으로 변환 |
| **원인 진단 재시도** | 영상 결함이 원본(시작 이미지·레퍼런스)에 이미 있었는지, 움직임에서 생겼는지 판정 → 원본 문제면 재시도 중단(크레딧 절약), 움직임 문제면 움직임 문장만 수정 |
| **단독 검수** | 생성 없이 이미 있는 이미지(다른 툴에서 만든 캐릭터 시트·로케이션)를 같은 기준으로 점검 |
| **LLM 선택** | LM Studio(로컬) · OpenAI 호환 서버(Ollama, OpenRouter 등) · Claude API 중 선택 — 특정 모델에 묶이지 않음 |
| **MCP 서버** | Claude Code / Claude Desktop에서 툴을 직접 제어 (아래 참고) |

## 제작 스킬 → 파이프라인 규칙

| 스킬 | 파이프라인에서 하는 일 |
|---|---|
| shot-prep | 생성 후 3단계 검증(요청대로 바뀌었나 / 바뀌면 안 되는 게 그대로인가 / 몰래 깨지거나 추가된 게 없나) · 슬롭 검사 · 영상 결함 원인 진단 |
| Seedance 프롬프트 | "보이는 것만 쓰기", 레퍼런스 태깅, 샷 단위 독립 문서, 카메라·오디오 규칙 |
| Leera | 로케이션: 3/4 시점 · 앵커 오브젝트 · 단일 광원 · 깊이감 |
| character-sheet | 고정 템플릿(#3a3a3c 회색 배경 3열) + 홍채·캐치라이트·머리 크롭·비대칭 검사, 배경색은 픽셀로 측정 |

두 단계로 적용합니다.

- **압축 규칙**: 작은 로컬 모델도 따라오도록 LLM은 JSON 빈칸(피사체·동작·배경·빛·카메라·제약)만 채우고, 문장 조립과 금지어(epic, stunning…) 제거·레퍼런스 누락 검사는 코드가 합니다. 검수도 "예/아니오" 질문 여러 개로 나눠 물을 수 있습니다.
- **원문 스킬**: Claude처럼 긴 규칙을 소화하는 모델이면 `skills/` 폴더의 원문을 그대로 붙입니다.

## Claude Code로 제어하기 (MCP)

`tools/mcp-server.ts`가 AutoQC Studio를 MCP 도구 10개로 노출합니다.

| 도구 | 하는 일 |
|---|---|
| `autoqc_start` | 서버가 꺼져 있으면 독립 창으로 실행 |
| `autoqc_status` | 연결 상태, 모듈 목록, LoRA, 크레딧 잔액 |
| `autoqc_generate` | 단일 생성 (모듈 · 프롬프트 · 시드 · 스텝 · LoRA · 레퍼런스 · 검수 설정) |
| `autoqc_job` | 작업 진행 상황 · 결과 · 검수 사유 |
| `autoqc_batch_recipe` | 현재 배치 컷 구성 조회 |
| `autoqc_batch` | 폴더 / 파일 / 제품 목록 + 단계별 설정으로 배치 시작 |
| `autoqc_batch_status` | 배치 진행 상황 |
| `autoqc_cancel` | 작업 · 배치 취소 |
| `autoqc_stats` | 통과율 · 결함 분포 · 단계별 시간 통계 |
| `autoqc_check_image` | 생성 없이 이미지 단독 검수 (캐릭터 시트 · 로케이션 · 일반) |

등록 (Windows, 프로젝트 폴더에서):

```bash
claude mcp add autoqc -- cmd /c tools\mcp-autoqc.cmd
```

## 실행

준비물

- Node.js 20+
- [ComfyUI Desktop](https://www.comfy.org/) 실행 중 (기본 `http://127.0.0.1:8188`)
- [LM Studio](https://lmstudio.ai/) 서버 실행 중 (기본 `1234`, 검수용으로 Vision 지원 모델) — 또는 Claude API

실행

- Windows: **`start.bat` 더블클릭** → 패키지 설치 후 `http://localhost:5178` 자동 오픈
- 직접 실행: `npm install` → `npm start`

처음 한 번

1. **[모듈 · 설정]** 탭에서 ComfyUI · LM Studio 주소와 모델 이름 확인
2. 유료 API 노드(GPT Image 2, Seedance 등)를 쓰려면 [Comfy API 키](https://platform.comfy.org/profile/api-keys)를 설정 화면에 입력
3. 새 워크플로우는 ComfyUI에서 한 번 실행한 뒤 **ComfyUI 최근 실행에서 가져오기**로 모듈 등록

> API 키 · 토큰은 `data/settings.json`에만 저장되며 이 저장소에는 포함되지 않습니다.

## 폴더 구조

```
server/      서버 (Express + TS)
  ├ comfy.ts        ComfyUI HTTP / WebSocket 연동
  ├ modules.ts      워크플로우 모듈 인식 · 파라미터 주입
  ├ jobs.ts         생성 → 검수 → 재시도 파이프라인
  ├ llm.ts / qc.ts  프롬프트 확장 · Vision 검수
  ├ batch.ts        배치 제작
  ├ skills.ts       제작 스킬 → 압축 규칙 · 슬롯 · 프롬프트 점검
  ├ credits.ts      Comfy 크레딧 잔액 · 비용 추정
  └ video.ts        영상 프레임 추출 (검수용)
web/         화면 (React + TypeScript + Vite)
modules/     모듈 16종 (폴더 하나 = workflow.json + manifest.json)
skills/      제작 스킬 원문 (.md, 개인 파일은 저장소 제외)
tools/       MCP 서버, GPU 없이 테스트하는 가짜 ComfyUI / LM Studio
docs/        진행 기록 · 인수인계(HANDOFF.md)
```

모듈 작성 규칙: [`modules/README.md`](modules/README.md)

## 포함된 모듈

| 종류 | 모듈 |
|---|---|
| 이미지 (로컬) | `qwen_t2i`, `qwen_edit`, `krea2_turbo_t2i`, `ideogram4_t2i` |
| 이미지 (유료 API) | `gpt_image2_t2i`, `gpt_image2_edit` |
| 영상 (로컬) | `ltx25_t2v`, `ltx25_i2v`, `ltx25_flf2v`, `elements_video` |
| 영상 (유료 API) | `seedance2_i2v`, `seedance2_ref`, `seedance25_ref` (레퍼런스 최대 6장 + 오디오 동시 생성) |
| 영상 (로컬 · MiniMax H3) | `minimax_h3_t2v`, `minimax_h3_i2v`, `minimax_h3_r2v` |

## 개발 · 테스트

- `npm run dev` — 화면 코드 수정 시 바로 반영
- `npm run mock` — GPU 없이 가짜 ComfyUI(8188) · LM Studio(1234) 실행 (`tools/test-module`을 `modules/`에 복사해 사용)
- `npm run typecheck` — 타입 검사

## 기술 스택

TypeScript · React 18 · Vite · Express · WebSocket · sharp · ffmpeg · ComfyUI API · LM Studio (OpenAI 호환) · Claude API · Model Context Protocol
