-- CreateEnum
CREATE TYPE "AvailabilityEventType" AS ENUM ('opened', 'closed');

-- CreateTable
CREATE TABLE "AvailabilityEvent" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "unitId" INTEGER NOT NULL,
    "unitName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "AvailabilityEventType" NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "AvailabilityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantity" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AvailabilityEvent_facilityId_detectedAt_idx" ON "AvailabilityEvent"("facilityId", "detectedAt");

-- CreateIndex
CREATE INDEX "AvailabilityEvent_type_notifiedAt_idx" ON "AvailabilityEvent"("type", "notifiedAt");

-- CreateIndex
CREATE INDEX "EmailLog_sentAt_idx" ON "EmailLog"("sentAt");

-- AddForeignKey
ALTER TABLE "AvailabilityEvent" ADD CONSTRAINT "AvailabilityEvent_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;
