-- Ad media mapping.
-- Replaces a JSONB unnest over every WebhookEvent row (run per campaign, every
-- five minutes) with an indexed lookup, and keeps the mapping after the raw
-- payloads are pruned.
CREATE TABLE "AdMediaMapping" (
    "id" TEXT NOT NULL,
    "originalMediaId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdMediaMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdMediaMapping_originalMediaId_mediaId_key"
    ON "AdMediaMapping"("originalMediaId", "mediaId");
CREATE INDEX "AdMediaMapping_originalMediaId_idx"
    ON "AdMediaMapping"("originalMediaId");

-- Backfill from whatever payloads are still retained, so boosted posts already
-- seen stay visible to the sweep after this deploy.
INSERT INTO "AdMediaMapping" ("id", "originalMediaId", "mediaId", "firstSeenAt", "lastSeenAt")
SELECT
    gen_random_uuid()::text,
    pairs."originalMediaId",
    pairs."mediaId",
    now(),
    now()
FROM (
    SELECT DISTINCT
        change->'value'->'media'->>'original_media_id' AS "originalMediaId",
        change->'value'->'media'->>'id'                AS "mediaId"
    FROM "WebhookEvent" w,
         jsonb_array_elements(w.payload::jsonb->'entry') entry,
         jsonb_array_elements(entry->'changes') change
    WHERE change->>'field' = 'comments'
      AND change->'value'->'media'->>'original_media_id' IS NOT NULL
) AS pairs
WHERE pairs."mediaId" IS NOT NULL
  AND pairs."mediaId" <> pairs."originalMediaId"
ON CONFLICT ("originalMediaId", "mediaId") DO NOTHING;

-- Hot-path indexes.
-- The cross-campaign private-reply guard looks up DmLog by commentId alone,
-- once per matched comment; the composite unique cannot serve it.
CREATE INDEX "DmLog_commentId_idx" ON "DmLog"("commentId");
-- Read receipts in the webhook path filter on commenterId.
CREATE INDEX "DmLog_commenterId_idx" ON "DmLog"("commenterId");
-- Dashboard listing (newest-first per workspace) and the retention sweep.
CREATE INDEX "DmLog_workspaceId_createdAt_idx" ON "DmLog"("workspaceId", "createdAt");
CREATE INDEX "DmLog_createdAt_idx" ON "DmLog"("createdAt");
-- Diagnostics list and retention sweep on the fastest-growing table.
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");

-- ProcessedComment was never written or read by any code path; the dedup it
-- claimed to provide is done by the DmLog guards.
DROP TABLE IF EXISTS "ProcessedComment";
