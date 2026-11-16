ALTER TABLE "jobs" ADD COLUMN "discovery_query_id" text;--> statement-breakpoint
CREATE INDEX "jobs_discovery_query_idx" ON "jobs" USING btree ("discovery_query_id");