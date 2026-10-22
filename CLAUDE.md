# AutoQC Studio — Claude Code 작업 규칙

- **작업을 시작하기 전에 `docs/HANDOFF.md`를 먼저 읽을 것.** (구조·설계 결정·남은 문제·비밀 정보 규칙)
- AutoQC Studio 서버(포트 5178)는 start.bat으로 **독립된 창**에서 실행한다. 꺼져 있으면 MCP 도구 `autoqc_start`로 켠다.
- Claude Code가 `npm start`, `tsx server/index.ts` 등을 백그라운드 명령으로 직접 띄우지 않는다.
  Claude Code의 백그라운드 작업이 끝나거나 중지되면 서버와 진행 중인 배치가 함께 꺼진다.
- 생성·배치·상태 확인은 셸/curl이 아니라 MCP 도구(autoqc_*)로 한다. 배치는 autoqc_batch (folder / files / products + steps), 현재 컷 구성은 autoqc_batch_recipe.
- 배치가 돌고 있을 때는 start.bat을 다시 실행하지 않는다 (기존 서버가 종료되어 배치가 중단됨).
- 오류 기록: data/server.log
- 이미 있는 이미지(힉스필드 캐릭터 시트·로케이션 등)만 검수할 때는 autoqc_check_image (profile: character_sheet / location / default). 크레딧을 쓰지 않음.
- 캐릭터 시트·로케이션을 생성할 때는 autoqc_generate의 qc_profile을 지정하면 그 스킬 규칙으로 작성·검수함.
