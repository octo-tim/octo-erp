# ADR-0002 배포·인증·파일 저장 (DEC-07)

- 상태: Provisionally Accepted (2026-08-30, 기본안 임시승인)

## 결정
- 배포: Railway(web, worker, PostgreSQL), Docker 이미지, GitHub Actions CI. 환경 dev/staging/production 분리.
- 인증: 자체 DB 세션(scrypt, 쿠키 `erp_session`, 회전·폐기). NextAuth 미사용.
- 파일: S3 호환 비공개 객체 저장소(Cloudflare R2 후보). dev/test는 로컬 파일시스템 어댑터.

## 대안
Vercel+NextAuth(세션 통제 제한, 워커 별도 필요), Supabase Storage(공급자 종속).

## 비용·복구
Railway 소규모 플랜, PostgreSQL 일 백업 + pg_dump 외부 보관. 복구 절차는 docs/ops/backup-restore.md.
