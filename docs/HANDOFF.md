# AutoQC Studio — 인수인계 (Claude Code용)

> 최종 정리: 2026-10-22 · 작성: Claude (claude.ai 대화 세션에서 설계·구현한 내용을 정리)
> 작업을 시작하기 전에 이 문서를 먼저 읽고, 코드에서 사실을 다시 확인한 뒤 진행한다.
> `docs/PROJECT_STATUS.md`는 10-11 기준의 초기 문서라 일부가 지금과 다르다. 충돌하면 이 문서와 코드가 우선.

---

## 1. 무엇인가

한국어 기획 문장·상품 사진 → LLM 프롬프트 확장 → ComfyUI 생성(이미지·영상) → Vision LLM 자동 검수 → 결함별 재생성 → 상품별 폴더 분류 → 통계.
2026 독자 R&D 포트폴리오 (카페24 경험아키텍처팀 "AI 영상 제작 엔지니어" 지원용). GitHub: https://github.com/junhosong1/AutoQC-Studio

| 항목 | 값 |
|---|---|
| 폴더 | `G:\AutoQC Studio` (Windows, RTX 3080 12GB, RAM 64GB) |
| 서버 / 화면 | Node·TS(Express) :5178 / React·TS(Vite) |
| ComfyUI | Desktop :8188 (v0.39.2) — 유료 API 노드는 `extra_data.api_key_comfy_org`로 키 전달 |
| LLM | 기본 LM Studio :1234 `google/gemma-4-26b-a4b-qat` (프롬프트 확장 + Vision 검수). OpenAI 호환 서버·Claude API로 교체 가능 |
| 실행 | `start.bat` (독립 창). 꺼져 있으면 MCP `autoqc_start` |

## 2. 코드 지도

| 파일 | 역할 |
|---|---|
| `server/jobs.ts` | 작업 큐, 시도 루프(프롬프트→생성→규칙 검수→LLM 검수→재시도), 원인 진단 재시도, 통계(`stats()` — 이미지/영상 분리), 사람 판정(시도 단위) |
| `server/llm.ts` | 프롬프트 확장(일반/레퍼런스/영상/모션/캐릭터 시트), 검수(`review()` 체크리스트 · `reviewSplit()` 예/아니오), 백엔드 3종, LLM 직렬화 |
| `server/skills.ts` | 제작 스킬 → 압축 규칙, JSON 슬롯 스키마·조립, 금지어 점검(`lintPrompt`), `skills/*.md` 원문 로드 |
| `server/qc.ts` | 규칙 검수(단색), 프로필 픽셀 검사(`profileCheck`: 시트 배경 #3a3a3c, 로케이션 노출) |
| `server/modules.ts` | 모듈 로더·자동 인식, 워크플로우 값 주입(`applyToWorkflow`), LoRA, 키프레임 2단계, 꺼진 LoRA 가지 제거 |
| `server/batch.ts` | 상품 배치 (상품 × 컷 구성), 순차 실행 체인, 앞 컷 실패 시 이어가기 |
| `server/comfy.ts` | ComfyUI 클라이언트. 큐 등록 시 `node_errors` 있으면 즉시 실패(누락 모델 파일 안내) |
| `server/credits.ts` | Comfy 크레딧 잔액·비용 추정 (GPT Image 2, Seedance 2.0/2.5 가격식) |
| `server/index.ts` | REST API (`/api/qc/check` 단독 검수, `/api/skills` 등) |
| `tools/mcp-server.ts` | MCP 도구 10개 (`autoqc_start/status/generate/job/batch_recipe/batch/batch_status/cancel/stats/check_image`) |
| `tools/mock-comfy.ts` | GPU 없이 테스트용 가짜 ComfyUI + LM Studio (JSON 스키마대로 응답) |
| `web/src/pages/*` | 이미지·영상 생성, 상품 배치, 단독 검수(QcCheck), 결과 갤러리(핀터레스트형), 기록·통계, 모듈·설정 |
| `modules/<id>/` | workflow.json(API 형식) + manifest.json. 16종 (로컬 Qwen·Krea·Ideogram·LTX·MiniMax H3·Elements / 유료 GPT Image 2·Seedance 2.0·2.5) |
| `skills/*.md` | 원문 스킬 (seedance, leera, shot-prep, character-sheet). 개인 파일 — git 제외 |

## 3. 지켜야 할 규칙

- **비밀 정보**: `data/settings.json`에 Comfy API 키·HF 토큰·Claude 키가 있다. **읽거나 출력하거나 커밋하지 않는다.** 키를 대신 입력하지 않는다 (사용자가 직접 입력).
- `data/`(history·batches·thumbcache = 실제 브랜드 상품 사진·프롬프트), `outputs/`, `skills/*.md`는 공개 저장소에 올리지 않는다 (`.gitignore` 처리됨).
- 서버를 셸/백그라운드 명령으로 띄우지 않는다 (CLAUDE.md 참고). 배치 도중 start.bat 재실행 금지.
- 사용자 파일 삭제는 명시적 허락 후에만. outputs는 지우지 말고 제외로 처리.
- 크레딧 사용(유료 모듈 생성)은 사용자 확인 후. 수정은 필요한 만큼만 (사용자가 가성비를 중요하게 봄).

## 4. 설계 결정과 이유

- **배치는 한 번에 하나씩 순차 실행** (`batch.ts` runChain, 뒤 배치는 "순서 대기"). 여러 배치가 동시에 돌면 칸 단위로 섞이고 모델 교체가 잦아짐.
- **앞 컷이 검수 탈락해도 이어가기**(`onPrevFail: 'auto'`): 최고점 실패 컷(통과점수−2 이상) → 없으면 상품 사진으로. `'skip'`이면 예전처럼 건너뜀.
- **영상 원인 진단**(shot-prep 8장): 검수가 `cause: source|motion`을 판정. source + 사용자 입력 이미지 → 재시도 중단(`stop-source`, 크레딧 절약), source + 키프레임 모듈 → 키프레임부터 재생성, motion → 움직임 문장만 수정(`motion+seed`).
- **작은 글자는 결함 아님**: 상품 레퍼런스 검수에서 성분·주소·유통기한 등 작은 글자는 보지 않고 브랜드명·큰 글자만 본다 (예전에 과도한 탈락의 주원인).
- **스킬 모드**: `auto` = Claude면 원문(full), 그 외는 압축(compact: JSON 슬롯 채우기 + 코드가 문장 조립·금지어 제거·레퍼런스 누락 보완). `qcMode: split`은 작은 비전 모델용 예/아니오 질문.
- **통계는 이미지/영상 분리** + 중앙값 표시 (긴 영상 하나가 평균을 왜곡).
- **사람 판정은 시도 단위** ("쓸 만함/못 씀", AI 판정과 일치/불일치 자동 표시). 예전 항목 단위 판정은 최종 시도 판정으로 취급.
- **프롬프트 칸은 sessionStorage** → 앱을 새로 켜면 빈 칸. 모듈·비율·톤 등 설정은 localStorage로 유지.
- Seedance 2.0 i2v 모듈 오디오 기본 켜짐. 2.0/2.5 레퍼런스→영상 모듈(`seedance2_ref`, `seedance25_ref`)은 공식 노드 `ByteDance2ReferenceNode` 기준으로 작성 — **실제 실행 검증 전**.

## 5. 남은 문제 · 다음 할 일 (우선순위)

1. **품질이 실사용 수준에 못 미침** (사용자 지적, 10-14). 기록 분석 결과:
   - 로컬 영상(MiniMax H3·LTX)을 0.4MP로 생성 → 디테일 부족. 평균 점수 MiniMax 4.6 · LTX 5.0 vs Seedance 10 · GPT Image 2 8.7~10.
   - Qwen Image 2.1은 int8 + 모든 작업에 `qwen-image-2.1-fix-1.0` LoRA 0.8 (25스텝, CFG 1). 이 LoRA의 용도 미확인 → **같은 시드로 LoRA 켬/끔 비교 필요**.
   - 제안했던 원인 분리 비교(1회씩): 현재 설정 / LoRA 끔 / Claude가 쓴 프롬프트 / GPT Image 2.
2. **LM Studio 프롬프트 누수**: gemma가 프롬프트 대신 "Natural English? Yes…" 같은 자기 점검 메모를 넘기던 문제 (LLM 프롬프트의 ~7%). 10-15에 `reasoning_effort: 'none'`(noThink) 적용됨 — **효과 확인 필요**. 남으면 점검 메모·빈 문장을 거부하고 재요청하는 가드 추가.
3. Krea 2 Turbo 오류: 꺼진 내장 LoRA(`krea2_darkbrush`) 가지 때문에 검증 실패 → 10-15 `applyToWorkflow`에서 꺼진 LoRA 가지 제거로 수정됨 — 재확인.
4. Seedance 레퍼런스 모듈 첫 실행 확인 (레퍼런스 1장·480p·짧게). 2.5 옵션이 없으면 ComfyUI 업데이트 필요. 목소리 고정용 오디오 레퍼런스 입력은 미구현 (툴에 오디오 업로드 없음).
5. 무료 비교 배치("비교_무료") 미실행. 유료 기준치: "비교_유료" 상품 3 × (GPT edit 대표컷 + Seedance 숏폼) = 6/6 통과, 24분 6초, 394크레딧.
6. 포트폴리오 p.15 갱신 (무료 비교 결과, 수동 작업 시간 기준치), 마지막 페이지에 GitHub 링크.

## 6. 참고 수치

- 크레딧 = USD × 211. 잔액: `cloud.comfy.org/api/billing/balance` (`*_cents`/`*_micros` 필드 값은 실제로 cents).
- GPT Image 2 시도당 ≈ 18~19크레딧(1024² medium + 참조), Seedance 2.0 5초 480p ≈ 107크레딧, 2.5 5초 720p ≈ 350크레딧(추정).
- 예전 통계(10-11): 첫 시도 통과 67% → 최종 87%, 단계 시간 프롬프트 33.8s · 생성 56.4s · 검수 62.7s (LLM 비중 62%).

## 7. 작업 방식 메모

- 수정 후 `npx tsc --noEmit`, 화면 변경이면 `npx vite build`로 확인. GPU 없이 확인할 땐 `npm run mock` + `tools/test-module*`.
- 사용자는 존댓말·직설적 평가를 선호하고, 크레딧·사용량을 아끼는 걸 중요하게 본다.
