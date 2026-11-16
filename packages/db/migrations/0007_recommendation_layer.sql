CREATE TYPE "public"."duplicate_tier" AS ENUM('exact', 'strong', 'probable', 'weak', 'distinct');--> statement-breakpoint
CREATE TYPE "public"."exposure_state" AS ENUM('never_shown', 'shown', 'clicked', 'saved', 'applied', 'dismissed', 'rejected', 'notified');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_status" AS ENUM('ACTIVE', 'STALE', 'EXPIRED', 'CLOSED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."recommendation_tier" AS ENUM('EXCEPTIONAL', 'HIGHLY_RECOMMENDED', 'STRONG', 'WORTH_CONSIDERING', 'LOW_PRIORITY', 'EXCLUDED', 'STALE');--> statement-breakpoint
CREATE TYPE "public"."source_authority" AS ENUM('authoritative', 'high', 'medium', 'low', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."verification_outcome" AS ENUM('reachable', 'not_found', 'gone', 'error', 'blocked', 'skipped');--> statement-breakpoint
CREATE TABLE "candidate_job_exposure" (
	"profile_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"state" "exposure_state" DEFAULT 'never_shown' NOT NULL,
	"times_shown" integer DEFAULT 0 NOT NULL,
	"first_shown_at" timestamp with time zone,
	"last_shown_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notified_content_hash" text,
	"notified_score" real,
	"notified_snapshot" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_duplicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"duplicate_of_job_id" uuid NOT NULL,
	"tier" "duplicate_tier" NOT NULL,
	"duplicate_confidence" real NOT NULL,
	"duplicate_reason" text NOT NULL,
	"merged" boolean DEFAULT false NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_group_merges" (
	"group_id" uuid PRIMARY KEY NOT NULL,
	"canonical_job_id" uuid NOT NULL,
	"best_apply_url" text,
	"best_apply_url_source_id" text,
	"member_count" integer DEFAULT 1 NOT NULL,
	"provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"final_score" real NOT NULL,
	"raw_score" real NOT NULL,
	"calibrated_score" real NOT NULL,
	"diversity_penalty" real DEFAULT 0 NOT NULL,
	"tier" "recommendation_tier" NOT NULL,
	"match_score" real NOT NULL,
	"match_confidence" real NOT NULL,
	"score" jsonb NOT NULL,
	"exposure" jsonb NOT NULL,
	"rank_explanation" text DEFAULT '' NOT NULL,
	"rank_reasons" text[] DEFAULT '{}' NOT NULL,
	"notification_eligible" boolean DEFAULT false NOT NULL,
	"notification_blockers" text[] DEFAULT '{}' NOT NULL,
	"recommendation_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_signals" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"quality_score" real NOT NULL,
	"quality_confidence" real NOT NULL,
	"quality" jsonb NOT NULL,
	"freshness_score" real NOT NULL,
	"freshness_age_hours" real NOT NULL,
	"freshness" jsonb NOT NULL,
	"lifecycle_status" "lifecycle_status" DEFAULT 'ACTIVE' NOT NULL,
	"lifecycle" jsonb NOT NULL,
	"scam_risk" real DEFAULT 0 NOT NULL,
	"scam" jsonb NOT NULL,
	"repost_kind" text DEFAULT 'new' NOT NULL,
	"repost" jsonb NOT NULL,
	"source_authority" "source_authority" DEFAULT 'medium' NOT NULL,
	"absence_runs" integer DEFAULT 0 NOT NULL,
	"recommendation_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"url" text NOT NULL,
	"outcome" "verification_outcome" NOT NULL,
	"http_status" integer,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"considered" integer DEFAULT 0 NOT NULL,
	"ranked" integer DEFAULT 0 NOT NULL,
	"suppressed" integer DEFAULT 0 NOT NULL,
	"notifiable" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"distribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommendation_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_job_exposure" ADD CONSTRAINT "candidate_job_exposure_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_job_exposure" ADD CONSTRAINT "candidate_job_exposure_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_duplicates" ADD CONSTRAINT "job_duplicates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_duplicates" ADD CONSTRAINT "job_duplicates_duplicate_of_job_id_jobs_id_fk" FOREIGN KEY ("duplicate_of_job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_group_merges" ADD CONSTRAINT "job_group_merges_canonical_job_id_jobs_id_fk" FOREIGN KEY ("canonical_job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_recommendations" ADD CONSTRAINT "job_recommendations_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_recommendations" ADD CONSTRAINT "job_recommendations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_signals" ADD CONSTRAINT "job_signals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_verifications" ADD CONSTRAINT "job_verifications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_job_exposure_unique" ON "candidate_job_exposure" USING btree ("profile_id","job_id");--> statement-breakpoint
CREATE INDEX "candidate_job_exposure_state_idx" ON "candidate_job_exposure" USING btree ("profile_id","state");--> statement-breakpoint
CREATE INDEX "candidate_job_exposure_notified_idx" ON "candidate_job_exposure" USING btree ("profile_id","notified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_duplicates_pair_unique" ON "job_duplicates" USING btree ("job_id","duplicate_of_job_id");--> statement-breakpoint
CREATE INDEX "job_duplicates_job_idx" ON "job_duplicates" USING btree ("job_id","duplicate_confidence");--> statement-breakpoint
CREATE INDEX "job_duplicates_target_idx" ON "job_duplicates" USING btree ("duplicate_of_job_id");--> statement-breakpoint
CREATE INDEX "job_duplicates_merged_idx" ON "job_duplicates" USING btree ("merged","tier");--> statement-breakpoint
CREATE INDEX "job_group_merges_canonical_idx" ON "job_group_merges" USING btree ("canonical_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_recommendations_profile_job_unique" ON "job_recommendations" USING btree ("profile_id","job_id");--> statement-breakpoint
CREATE INDEX "job_recommendations_rank_idx" ON "job_recommendations" USING btree ("profile_id","rank");--> statement-breakpoint
CREATE INDEX "job_recommendations_score_idx" ON "job_recommendations" USING btree ("profile_id","final_score");--> statement-breakpoint
CREATE INDEX "job_recommendations_tier_idx" ON "job_recommendations" USING btree ("profile_id","tier","final_score");--> statement-breakpoint
CREATE INDEX "job_recommendations_notifiable_idx" ON "job_recommendations" USING btree ("profile_id","notification_eligible","final_score");--> statement-breakpoint
CREATE INDEX "job_recommendations_computed_idx" ON "job_recommendations" USING btree ("profile_id","computed_at");--> statement-breakpoint
CREATE INDEX "job_signals_lifecycle_idx" ON "job_signals" USING btree ("lifecycle_status","freshness_score");--> statement-breakpoint
CREATE INDEX "job_signals_quality_idx" ON "job_signals" USING btree ("quality_score");--> statement-breakpoint
CREATE INDEX "job_signals_scam_idx" ON "job_signals" USING btree ("scam_risk");--> statement-breakpoint
CREATE INDEX "job_signals_freshness_idx" ON "job_signals" USING btree ("freshness_age_hours");--> statement-breakpoint
CREATE INDEX "job_signals_version_idx" ON "job_signals" USING btree ("recommendation_version");--> statement-breakpoint
CREATE INDEX "job_verifications_job_idx" ON "job_verifications" USING btree ("job_id","checked_at");--> statement-breakpoint
CREATE INDEX "job_verifications_outcome_idx" ON "job_verifications" USING btree ("outcome","checked_at");--> statement-breakpoint
CREATE INDEX "recommendation_runs_profile_idx" ON "recommendation_runs" USING btree ("profile_id","started_at");