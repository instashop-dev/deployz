-- Regional HTTPS certificates (docs/https-regional-certificates.md) — new
-- job types and the certificate-status enum. Enum value additions MUST live
-- in their own migration file: Postgres refuses to USE a value added via
-- ALTER TYPE ... ADD VALUE within the same transaction that added it, and
-- drizzle applies every pending migration in one transaction (see 0006's
-- note). 0045 (customer_regional_certificates) uses regional_certificate_status
-- as a column default, which is safe because it is CREATEd fresh here, not
-- ADD VALUE'd.
ALTER TYPE "public"."job_type" ADD VALUE 'ENSURE_CERTIFICATE' BEFORE 'PURGE';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'ATTACH_CERTIFICATE' BEFORE 'PURGE';--> statement-breakpoint
CREATE TYPE "public"."regional_certificate_status" AS ENUM('REQUESTING', 'DNS_VALIDATION_PENDING', 'ISSUED', 'ERROR');
