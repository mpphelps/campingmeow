-- AlterTable
ALTER TABLE "Facility" ADD COLUMN     "maxVehicleLength" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "siteCategories" INTEGER[];
