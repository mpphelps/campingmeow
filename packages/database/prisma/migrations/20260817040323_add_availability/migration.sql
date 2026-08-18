-- AlterTable
ALTER TABLE "Facility" ADD COLUMN     "lastScannedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AvailabilitySlot" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "unitId" INTEGER NOT NULL,
    "unitName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isFree" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvailabilitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AvailabilitySlot_facilityId_date_isFree_idx" ON "AvailabilitySlot"("facilityId", "date", "isFree");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilitySlot_facilityId_unitId_date_key" ON "AvailabilitySlot"("facilityId", "unitId", "date");

-- AddForeignKey
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;
