ALTER TYPE "public"."notification_type" ADD VALUE 'DAILY_DIGEST';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'WEEKLY_DIGEST';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'PREFERENCE_SUGGESTION';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'APPLICATION_REMINDER';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'APPLICATION_DEADLINE';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'JOB_EXPIRING';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'LEARNING_INSIGHT';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'SEARCH_COVERAGE_ALERT';--> statement-breakpoint
CREATE TABLE "digest_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"type" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_jobs" smallint DEFAULT 0 NOT NULL,
	"excluded" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notification_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_plans_window_unique" UNIQUE("candidate_id","type","window_start")
);
--> statement-breakpoint
CREATE TABLE "discovery_profile_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"total_jobs" integer DEFAULT 0 NOT NULL,
	"matching_all_dimensions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_profile_counts_day_unique" UNIQUE("candidate_id","day")
);
--> statement-breakpoint
CREATE TABLE "notification_address_health" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"suppressed_reason" text,
	"hard_bounces" integer DEFAULT 0 NOT NULL,
	"soft_bounces" integer DEFAULT 0 NOT NULL,
	"complaints" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_intelligence_configs" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"value" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_overrides_unique" UNIQUE("candidate_id","subject","value")
);
--> statement-breakpoint
CREATE TABLE "notification_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid,
	"type" text NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"urgency" text DEFAULT 'LOW' NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"notification_score" real,
	"score_detail" jsonb,
	"group_id" uuid,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_records_dedupe_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "notification_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"score" real NOT NULL,
	"urgency" text DEFAULT 'LOW' NOT NULL,
	"opportunity_value" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"deadline" jsonb NOT NULL,
	"rarity" jsonb NOT NULL,
	"factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"algorithm_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_scores_pair_unique" UNIQUE("candidate_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "notification_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"setting" text,
	"remedy" text,
	"notification_score" real,
	"threshold_applied" real,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_suppressions_pair_unique" UNIQUE("candidate_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "digest_plans" ADD CONSTRAINT "digest_plans_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_plans" ADD CONSTRAINT "digest_plans_notification_id_notification_records_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_profile_counts" ADD CONSTRAINT "discovery_profile_counts_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_address_health" ADD CONSTRAINT "notification_address_health_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intelligence_configs" ADD CONSTRAINT "notification_intelligence_configs_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_overrides" ADD CONSTRAINT "notification_overrides_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_records" ADD CONSTRAINT "notification_records_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_records" ADD CONSTRAINT "notification_records_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_scores" ADD CONSTRAINT "notification_scores_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_scores" ADD CONSTRAINT "notification_scores_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_suppressions" ADD CONSTRAINT "notification_suppressions_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_suppressions" ADD CONSTRAINT "notification_suppressions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_plans_candidate_idx" ON "digest_plans" USING btree ("candidate_id","generated_at");--> statement-breakpoint
CREATE INDEX "discovery_profile_counts_window_idx" ON "discovery_profile_counts" USING btree ("candidate_id","day");--> statement-breakpoint
CREATE INDEX "notification_overrides_lookup_idx" ON "notification_overrides" USING btree ("candidate_id","subject");--> statement-breakpoint
CREATE INDEX "notification_records_candidate_idx" ON "notification_records" USING btree ("candidate_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_records_state_idx" ON "notification_records" USING btree ("state","scheduled_at");--> statement-breakpoint
CREATE INDEX "notification_records_job_idx" ON "notification_records" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "notification_records_group_idx" ON "notification_records" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "notification_records_sent_idx" ON "notification_records" USING btree ("candidate_id","sent_at");--> statement-breakpoint
CREATE INDEX "notification_scores_rank_idx" ON "notification_scores" USING btree ("candidate_id","score");--> statement-breakpoint
CREATE INDEX "notification_suppressions_reason_idx" ON "notification_suppressions" USING btree ("candidate_id","reason");--> statement-breakpoint
CREATE INDEX "notification_suppressions_occurred_idx" ON "notification_suppressions" USING btree ("occurred_at");