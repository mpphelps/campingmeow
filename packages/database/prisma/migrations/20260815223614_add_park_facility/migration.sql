-- CreateTable
CREATE TABLE "Park" (
    "id" TEXT NOT NULL,
    "rcPlaceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "allowWebBooking" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Park_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "rcFacilityId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "facilityType" INTEGER,
    "allowWebBooking" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "parkId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Park_rcPlaceId_key" ON "Park"("rcPlaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_rcFacilityId_key" ON "Facility"("rcFacilityId");

-- CreateIndex
CREATE INDEX "Facility_parkId_idx" ON "Facility"("parkId");

-- AddForeignKey
ALTER TABLE "Facility" ADD CONSTRAINT "Facility_parkId_fkey" FOREIGN KEY ("parkId") REFERENCES "Park"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
