CREATE TABLE "EmailSearchOutbox" (
    "emailId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSearchOutbox_pkey" PRIMARY KEY ("emailId")
);

CREATE INDEX "EmailSearchOutbox_nextAttemptAt_createdAt_idx"
    ON "EmailSearchOutbox"("nextAttemptAt", "createdAt");

CREATE FUNCTION "queue_email_search_sync"() RETURNS TRIGGER AS $$
DECLARE
    target_id TEXT;
    action TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_id := OLD."id";
        action := 'delete';
    ELSE
        target_id := NEW."id";
        action := 'upsert';
    END IF;

    INSERT INTO "EmailSearchOutbox" ("emailId", "operation", "attemptCount", "nextAttemptAt", "lastError", "createdAt", "updatedAt")
    VALUES (target_id, action, 0, clock_timestamp(), NULL, clock_timestamp(), clock_timestamp())
    ON CONFLICT ("emailId") DO UPDATE
        SET "operation" = EXCLUDED."operation",
            "attemptCount" = 0,
            "nextAttemptAt" = EXCLUDED."nextAttemptAt",
            "lastError" = NULL,
            "updatedAt" = EXCLUDED."updatedAt";

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Email_search_sync"
AFTER INSERT OR UPDATE OR DELETE ON "Email"
FOR EACH ROW EXECUTE FUNCTION "queue_email_search_sync"();
