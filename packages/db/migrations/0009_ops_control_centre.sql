CREATE TYPE "public"."ai_operation" AS ENUM('enrichment_extraction', 'match_reasoning', 'scam_reasoning', 'embedding', 'preference_parsing', 'other');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('source.enabled', 'source.disabled', 'source.configured', 'source.tested', 'source.run_manually', 'preferences.updated', 'preferences.nl_applied', 'config.updated', 'notification.preferences_updated', 'notification.test_sent', 'pipeline.run_triggered', 'pipeline.dry_run', 'job.re_enriched', 'job.rematched', 'job.reranked', 'job.reverified', 'queue.paused', 'queue.resumed', 'queue.job_retried', 'digest.generated');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_status" AS ENUM('running', 'success', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_trigger" AS ENUM('SCHEDULED', 'MANUAL', 'RETRY', 'SYSTEM');--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'NOTIFICATIONS_PROCESSED' BEFORE 'NOTIFICATION_QUEUED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'NOTIFICATION_SUPPRESSED' BEFORE 'NOTIFICATION_QUEUED';--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" "ai_operation" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer DEFAULT 1 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"priced" boolean DEFAULT true NOT NULL,
	"latency_ms" integer,
	"succeeded" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"job_id" uuid,
	"run_id" uuid,
	"source_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"request_id" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" text NOT NULL,
	"value_ms" real NOT NULL,
	"succeeded" boolean DEFAULT true NOT NULL,
	"source_id" text,
	"run_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" "pipeline_run_trigger" DEFAULT 'SCHEDULED' NOT NULL,
	"status" "pipeline_run_status" DEFAULT 'running' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"jobs_discovered" integer DEFAULT 0 NOT NULL,
	"jobs_processed" integer DEFAULT 0 NOT NULL,
	"jobs_matched" integer DEFAULT 0 NOT NULL,
	"jobs_recommended" integer DEFAULT 0 NOT NULL,
	"notifications_generated" integer DEFAULT 0 NOT NULL,
	"duplicates_detected" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" text,
	"note" text,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"domain" text,
	"window_start" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"remaining_quota" integer
);
--> statement-breakpoint
ALTER TABLE "rate_limit_events" ADD CONSTRAINT "rate_limit_events_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_occurred_idx" ON "ai_usage" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ai_usage_operation_idx" ON "ai_usage" USING btree ("operation","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_usage_model_idx" ON "ai_usage" USING btree ("model","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_usage_run_idx" ON "ai_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target");--> statement-breakpoint
CREATE INDEX "metric_samples_operation_idx" ON "metric_samples" USING btree ("operation","occurred_at");--> statement-breakpoint
CREATE INDEX "metric_samples_occurred_idx" ON "metric_samples" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_started_idx" ON "pipeline_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_status_idx" ON "pipeline_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_trigger_idx" ON "pipeline_runs" USING btree ("trigger","started_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_trace_idx" ON "pipeline_runs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "rate_limit_events_source_window_idx" ON "rate_limit_events" USING btree ("source_id","window_start");--> statement-breakpoint
CREATE INDEX "rate_limit_events_window_idx" ON "rate_limit_events" USING btree ("window_start");