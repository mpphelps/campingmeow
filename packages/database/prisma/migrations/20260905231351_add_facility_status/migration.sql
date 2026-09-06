-- CreateEnum
CREATE TYPE "FacilityStatus" AS ENUM ('bookable', 'no_inventory', 'first_come_first_served');

-- AlterTable
ALTER TABLE "Facility" ADD COLUMN     "bookableSites" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "FacilityStatus" NOT NULL DEFAULT 'bookable';
