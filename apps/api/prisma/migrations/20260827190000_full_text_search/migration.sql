-- Tam metin arama.
--
-- The 'simple' dictionary is deliberate: content is mixed-language and
-- Postgres ships no stemmer for several of those languages. Choosing
-- 'english' would stem the others wrongly. 'simple' does not stem at all but
-- behaves in any language; prefix matching in the query stands in for it.
--
-- Weights: title A, body B, so a title match ranks above a body match.
-- The columns are GENERATED, so the index follows content automatically and
-- nothing has to keep it in sync — no triggers, no application code.

ALTER TABLE "Task" ADD COLUMN "search" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'B')
  ) STORED;
CREATE INDEX "Task_search_idx" ON "Task" USING GIN ("search");

ALTER TABLE "Document" ADD COLUMN "search" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("content", '')), 'B')
  ) STORED;
CREATE INDEX "Document_search_idx" ON "Document" USING GIN ("search");

ALTER TABLE "Comment" ADD COLUMN "search" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text", ''))) STORED;
CREATE INDEX "Comment_search_idx" ON "Comment" USING GIN ("search");
