-- 이슈 자동 해결 추정 — status에 'auto_resolved' 값 추가
--
-- full 모드 분석에서 기존 unconfirmed 이슈가 재감지되지 않으면
-- 'auto_resolved'로 전환됨 (유저가 Claude Code로 고친 것으로 추정).
-- 유저는 "확인" → confirmed 또는 "되돌리기" → unconfirmed로 처리 가능.

ALTER TABLE public.issues
  DROP CONSTRAINT IF EXISTS issues_status_check;

ALTER TABLE public.issues
  ADD CONSTRAINT issues_status_check
  CHECK (status IN ('unconfirmed', 'confirmed', 'resolved', 'auto_resolved'));
