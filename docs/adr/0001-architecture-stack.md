# ADR-0001 기술 스택과 단일 배포 아키텍처

- 상태: Accepted (2026-08-30)
- 관련: 프롬프트팩 STEP 1 기술 기준, NFR-OPS-*

## 결정
Next.js App Router + TypeScript strict, PostgreSQL + Prisma, tRPC + zod, Tailwind + shadcn/ui + TanStack Table, Vitest + Playwright. 웹과 워커는 같은 이미지로 배포한다.

## 근거
20명 규모 단일 조직, 단일 팀 개발·운영. 별도 백엔드 분리는 운영 부담만 늘린다. tRPC는 타입 안전 계약과 API 명세 생성을 동시에 준다.

## 결과
- 정밀 숫자는 문자열 계약(superjson 미사용).
- 모듈 경계는 디렉터리와 lint로 강제한다(docs/architecture.md).
