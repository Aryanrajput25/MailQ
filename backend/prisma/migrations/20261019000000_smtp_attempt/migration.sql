-- Records when a worker started the SMTP attempt. A stale 'processing' row with a NULL value
-- never reached SMTP and can be retried; a non-NULL value means delivery outcome is uncertain.
ALTER TABLE "Email" ADD COLUMN "smtpAttemptedAt" TIMESTAMP(3);
CREATE INDEX "Email_status_processingStartedAt_idx" ON "Email"("status", "processingStartedAt");
