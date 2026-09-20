-- Did ReserveCalifornia actually return a slice for this night?
--
-- Without this, "RC said nothing" and "RC said booked" are both isFree = false
-- and indistinguishable — which is how a broken RC server's invented
-- availability passes as a cancellation.
ALTER TABLE "AvailabilitySlot" ADD COLUMN     "reported" BOOLEAN NOT NULL DEFAULT false;

-- Backfill. A stored free night could only have come from a slice RC returned,
-- so reported = true is provably correct there. Taken nights are ambiguous —
-- they may be genuinely booked or simply absent — so they start false and flip
-- to true on their first scan.
--
-- This is not optional: defaulting everything to false would make every
-- currently-free night read as absent, and the rule ignores absent -> free, so
-- they would stay invisible until someone booked them.
UPDATE "AvailabilitySlot" SET "reported" = "isFree";
