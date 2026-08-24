-- §46 health_status gains UNKNOWN. Alone in its own migration on purpose:
-- Postgres refuses to USE a new enum value in the same transaction that adds
-- it, and drizzle runs one migration file per transaction. The default that
-- uses this value lands in 0007.
ALTER TYPE "public"."health_status" ADD VALUE 'UNKNOWN' BEFORE 'HEALTHY';
