-- The interface is English only; a per-user locale is no longer stored.
ALTER TABLE "User" DROP COLUMN IF EXISTS "language";
