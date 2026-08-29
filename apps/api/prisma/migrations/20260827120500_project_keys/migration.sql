-- Project key: the prefix behind short task ids like TAV-12.
-- Existing projects get a key derived from their title and made unique.
ALTER TABLE "Project" ADD COLUMN "key" TEXT;

UPDATE "Project" SET "key" = COALESCE(
  NULLIF(UPPER(SUBSTRING(REGEXP_REPLACE(TRANSLATE(title, 'çğıöşüÇĞİÖŞÜ', 'cgiosuCGIOSU'), '[^A-Za-z]', '', 'g') FROM 1 FOR 3)), ''),
  'PRJ'
);

-- Collisions are separated by a running number (TAV, TAV2, TAV3 …)
WITH numbered AS (
  SELECT id, "key", ROW_NUMBER() OVER (PARTITION BY "key" ORDER BY "createdAt", id) AS rn
  FROM "Project"
)
UPDATE "Project" p
SET "key" = n."key" || n.rn::text
FROM numbered n
WHERE p.id = n.id AND n.rn > 1;

ALTER TABLE "Project" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "Project_key_key" ON "Project"("key");
