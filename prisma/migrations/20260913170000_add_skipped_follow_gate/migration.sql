-- Adds the status for a person the follow gate stopped: the prompt was sent,
-- the link was not. Adding an enum value is additive and needs no backfill;
-- rows written before this keep whatever status they already had.
ALTER TYPE "DmStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_FOLLOW_GATE';
