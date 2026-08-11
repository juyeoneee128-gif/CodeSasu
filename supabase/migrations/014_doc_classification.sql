-- spec_documents에 LLM 사전 분류 결과를 저장하는 classification 컬럼 추가
--
-- docs/ 폴더에 PRD뿐 아니라 컴포넌트 목록·회의록·핸드오프 같은 비-기획서 문서가
-- 섞여 있을 때, 모든 문서에서 기능을 추출하면 "Button", "Card" 같은 컴포넌트명이
-- 기능으로 잘못 추출됨. extract 단계의 1단계 분류 결과를 저장해 재분류 비용을 절감하고
-- FE에서 "이 문서는 회의록입니다" 같이 표시할 수 있게 함.
--
-- 기존 type 컬럼(FRD/PRD)은 파일명 기반 추론으로 유지. classification은 LLM 판정 결과.

ALTER TABLE public.spec_documents
  ADD COLUMN classification text
    CHECK (classification IN ('prd', 'spec', 'other'));

-- 기존 row는 NULL — 다음 extract 시 LLM이 분류함

CREATE INDEX idx_spec_documents_classification
  ON public.spec_documents (project_id, classification)
  WHERE deleted_at IS NULL;
