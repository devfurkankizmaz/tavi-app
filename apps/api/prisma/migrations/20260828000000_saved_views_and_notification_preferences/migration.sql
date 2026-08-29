-- Saved views, and per-type notification preferences with a daily digest.
--
-- Written by hand rather than by `prisma migrate dev`. The full-text search
-- columns are `Unsupported("tsvector")` with GENERATED expressions and GIN
-- indexes created in raw SQL, none of which Prisma can model — so it reads
-- them as drift and generates DROP INDEX and DROP DEFAULT statements that
-- would quietly dismantle search. Anything generated here has to be read
-- before it is applied, and those statements removed.

ALTER TABLE "User" ADD COLUMN "digestHour" INTEGER,
                   ADD COLUMN "lastDigestAt" TIMESTAMP(3);

CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "projectId" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedView_ownerId_idx" ON "SavedView"("ownerId");
CREATE INDEX "SavedView_projectId_idx" ON "SavedView"("projectId");
CREATE UNIQUE INDEX "NotificationPreference_userId_type_key" ON "NotificationPreference"("userId", "type");

ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
