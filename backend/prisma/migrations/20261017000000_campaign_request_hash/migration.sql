-- Idempotency: fingerprint of the normalized scheduling request. Lets the API tell a true retry
-- (same key, same payload -> replay) from key reuse with a different payload (-> 409).
-- Nullable so rows created before this migration remain valid.
ALTER TABLE "Campaign" ADD COLUMN "requestHash" TEXT;
