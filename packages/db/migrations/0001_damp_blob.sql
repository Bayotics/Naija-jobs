DROP INDEX "jobs_source_content_hash_unique";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "source_identity" text NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_identity_unique" ON "jobs" USING btree ("source_id","source_identity");--> statement-breakpoint
CREATE INDEX "jobs_content_hash_idx" ON "jobs" USING btree ("source_id","content_hash");