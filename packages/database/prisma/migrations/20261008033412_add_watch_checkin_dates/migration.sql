-- A watch is either a pattern (checkinDays) or a set of specific check-in
-- dates (checkinDates). Existing watches are all patterns, so they take the
-- empty-array default and behave exactly as before — no backfill needed.
ALTER TABLE "Watch" ADD COLUMN     "checkinDates" DATE[] DEFAULT ARRAY[]::DATE[];
