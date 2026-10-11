# AutoQC Studio — Claude Code 작업 규칙

- AutoQC Studio 서버(포트 5178)는 start.bat으로 **독립된 창**에서 실행한다. 꺼져 있으면 MCP 도구 `autoqc_start`로 켠다.
- Claude Code가 `npm start`, `tsx server/index.ts` 등을 백그라운드 명령으로 직접 띄우지 않는다.
  Claude Code의 백그라운드 작업이 끝나거나 중지되면 서버와 진행 중인 배치가 함께 꺼진다.
- 생성·배치·상태 확인은 셸/curl이 아니라 MCP 도구(autoqc_*)로 한다. 배치는 autoqc_batch (folder / files / products + steps), 현재 컷 구성은 autoqc_batch_recipe.
- 배치가 돌고 있을 때는 start.bat을 다시 실행하지 않는다 (기존 서버가 종료되어 배치가 중단됨).
- 오류 기록: data/server.log
