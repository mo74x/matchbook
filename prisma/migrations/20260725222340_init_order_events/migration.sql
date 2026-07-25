-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('ORDER_PLACED', 'ORDER_MATCHED', 'ORDER_CANCELLED', 'ORDER_PARTIALLY_FILLED');

-- CreateTable
CREATE TABLE "OrderEvent" (
    "sequenceId" BIGSERIAL NOT NULL,
    "instrument" VARCHAR(20) NOT NULL,
    "eventType" "EventType" NOT NULL,
    "orderId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("sequenceId")
);

-- CreateIndex
CREATE INDEX "OrderEvent_instrument_sequenceId_idx" ON "OrderEvent"("instrument", "sequenceId" ASC);
