CREATE TABLE "QueueOutbox" (
  "id" TEXT NOT NULL,
  "emailId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QueueOutbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QueueOutbox_emailId_key" ON "QueueOutbox"("emailId");
CREATE UNIQUE INDEX "QueueOutbox_jobId_key" ON "QueueOutbox"("jobId");
CREATE INDEX "QueueOutbox_deliveredAt_nextAttemptAt_idx" ON "QueueOutbox"("deliveredAt", "nextAttemptAt");
ALTER TABLE "QueueOutbox" ADD CONSTRAINT "QueueOutbox_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;
