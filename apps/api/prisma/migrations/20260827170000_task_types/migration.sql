-- Task type: keeps tasks, bugs, features and chores apart.
CREATE TYPE "TaskType" AS ENUM ('FEATURE', 'BUG', 'TASK', 'CHORE');

ALTER TABLE "Task" ADD COLUMN "type" "TaskType" NOT NULL DEFAULT 'TASK';

CREATE INDEX "Task_type_idx" ON "Task"("type");
