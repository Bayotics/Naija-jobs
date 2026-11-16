CREATE TYPE "public"."alert_priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."delivery_event" AS ENUM('created', 'queued', 'sending', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'bounced', 'complained');--> statement-breakpoint
CREATE TYPE "public"."notification_decision" AS ENUM('SENT_IMMEDIATE_ALERT', 'INCLUDED_IN_DIGEST', 'QUEUED_FOR_DIGEST', 'SUPPRESSED_ALREADY_NOTIFIED', 'SUPPRESSED_BELOW_THRESHOLD', 'SUPPRESSED_QUIET_HOURS', 'SUPPRESSED_USER_REJECTED', 'SUPPRESSED_DAILY_LIMIT', 'SUPPRESSED_DIGEST_CAP', 'SUPPRESSED_COMPANY_CAP', 'SUPPRESSED_SOURCE_EXCLUDED', 'SUPPRESSED_NOT_ELIGIBLE', 'SUPPRESSED_DUPLICATE', 'SUPPRESSED_STALE', 'SUPPRESSED_WEEKEND_POLICY', 'SUPPRESSED_ALERTS_DISABLED', 'SUPPRESSED_NO_APPLICATION_URL', 'DEFERRED_QUIET_HOURS');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('JOB_ALERT', 'JOB_DIGEST', 'SYSTEM_ALERT', 'SOURCE_FAILURE', 'CRAWLER_HEALTH_ALERT', 'WEEKLY_SUMMARY');--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'RECOMMENDATIONS_RANKED' BEFORE 'PROFILE_VERSION_CREATED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'JOB_DEDUPLICATED' BEFORE 'PROFILE_VERSION_CREATED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'JOB_LIFECYCLE_CHANGED' BEFORE 'PROFILE_VERSION_CREATED';--> statement-breakpoint
CREATE TABLE "notification_channel_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"channel" "notification_channel" DEFAULT 'email' NOT NULL,
	"recipient" text NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"provider_id" text,
	"provider_message_id" text,
	"idempotency_key" text NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"job_id" uuid,
	"canonical_job_id" uuid,
	"outcome" "notification_decision" NOT NULL,
	"priority" "alert_priority",
	"reason" text NOT NULL,
	"recommendation_score" real,
	"match_score" real,
	"confidence" real,
	"deferred_until" timestamp with time zone,
	"notification_id" uuid,
	"engine_version" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"event" "delivery_event" NOT NULL,
	"detail" text,
	"provider_message_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"priority" "alert_priority" DEFAULT 'NORMAL' NOT NULL,
	"subject" text NOT NULL,
	"job_ids" uuid[] DEFAULT '{}' NOT NULL,
	"canonical_job_ids" uuid[] DEFAULT '{}' NOT NULL,
	"html" text NOT NULL,
	"text_body" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"digest_frequency" text DEFAULT 'daily' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"last_digest_at" timestamp with time zone,
	"last_weekly_summary_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notified_jobs" (
	"profile_id" uuid NOT NULL,
	"canonical_job_id" uuid NOT NULL,
	"first_notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notification_count" integer DEFAULT 1 NOT NULL,
	"last_priority" "alert_priority" DEFAULT 'NORMAL' NOT NULL,
	"last_score" real,
	"content_fingerprint" text,
	"last_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "source_alert_state" (
	"source_id" text PRIMARY KEY NOT NULL,
	"alerted_at_failures" integer,
	"last_alerted_at" timestamp with time zone,
	"last_severity" text,
	"recovered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_channel_deliveries" ADD CONSTRAINT "notification_channel_deliveries_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_decisions" ADD CONSTRAINT "notification_decisions_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_decisions" ADD CONSTRAINT "notification_decisions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_decisions" ADD CONSTRAINT "notification_decisions_canonical_job_id_jobs_id_fk" FOREIGN KEY ("canonical_job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_events" ADD CONSTRAINT "notification_delivery_events_delivery_id_notification_channel_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_channel_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notified_jobs" ADD CONSTRAINT "notified_jobs_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notified_jobs" ADD CONSTRAINT "notified_jobs_canonical_job_id_jobs_id_fk" FOREIGN KEY ("canonical_job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_alert_state" ADD CONSTRAINT "source_alert_state_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channel_deliveries_idem_unique" ON "notification_channel_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_channel_deliveries_event_idx" ON "notification_channel_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "notification_channel_deliveries_pending_idx" ON "notification_channel_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_channel_deliveries_provider_idx" ON "notification_channel_deliveries" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "notification_decisions_profile_idx" ON "notification_decisions" USING btree ("profile_id","decided_at");--> statement-breakpoint
CREATE INDEX "notification_decisions_job_idx" ON "notification_decisions" USING btree ("job_id","decided_at");--> statement-breakpoint
CREATE INDEX "notification_decisions_outcome_idx" ON "notification_decisions" USING btree ("profile_id","outcome","decided_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_events_delivery_idx" ON "notification_delivery_events" USING btree ("delivery_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_idempotency_unique" ON "notification_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_events_profile_idx" ON "notification_events" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_events_type_idx" ON "notification_events" USING btree ("profile_id","type","created_at");--> statement-breakpoint
CREATE INDEX "notification_preferences_due_idx" ON "notification_preferences" USING btree ("digest_enabled","last_digest_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notified_jobs_unique" ON "notified_jobs" USING btree ("profile_id","canonical_job_id");--> statement-breakpoint
CREATE INDEX "notified_jobs_recent_idx" ON "notified_jobs" USING btree ("profile_id","last_notified_at");--> statement-breakpoint
CREATE INDEX "source_alert_state_alerted_idx" ON "source_alert_state" USING btree ("last_alerted_at");