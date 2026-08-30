# CLAUDE.md

이 저장소는 (주)옥토웍스 자체 ERP(`octo-erp`)다. 작업 전 `AGENTS.md`와 `docs/engineering-rules.md`를 읽고 그대로 따른다. 여기에는 도구별 진입 정보만 둔다.

- 요구사항 원본: `docs/source/ERP_RFP_v0.3.md` / 구현 순서: `docs/source/ERP_prompt_pack_v1.0.md`
- 추적표 갱신: `node tools/traceability.mjs` (CI는 `--check`)
- 품질 게이트: `npm run check && npm run test:integration && npm run build`
- 통합시험 DB: `DATABASE_URL_TEST` (실제 PostgreSQL, 모킹 금지)
- 커밋 메시지: ASCII, 괄호 없음, `STEP n:` 접두사
- 단계 완료 보고 형식: 대상 ID, 변경 파일, DB 변경, 시험 명령과 결과, 수동 확인, 잔여 위험
