CREATE TABLE "behavior_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid,
	"event_type" text NOT NULL,
	"context" text DEFAULT 'UNKNOWN' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" text,
	"notification_id" uuid,
	"recommendation_id" text,
	"shown_at_rank" integer,
	"rejection_reason" text,
	"reason_text" text,
	"experiment_id" text,
	"variant" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "behavior_events_dedupe_key" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "behavioral_profiles" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"total_events" integer DEFAULT 0 NOT NULL,
	"distinct_jobs" integer DEFAULT 0 NOT NULL,
	"first_event_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"has_sufficient_data" boolean DEFAULT false NOT NULL,
	"cold_start_reason" text,
	"algorithm_version" text NOT NULL,
	"feature_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"window_days" smallint NOT NULL,
	"recommendations_shown" integer DEFAULT 0 NOT NULL,
	"jobs_viewed" integer DEFAULT 0 NOT NULL,
	"jobs_clicked" integer DEFAULT 0 NOT NULL,
	"jobs_saved" integer DEFAULT 0 NOT NULL,
	"jobs_rejected" integer DEFAULT 0 NOT NULL,
	"jobs_applied" integer DEFAULT 0 NOT NULL,
	"view_rate" real DEFAULT 0 NOT NULL,
	"click_rate" real DEFAULT 0 NOT NULL,
	"save_rate" real DEFAULT 0 NOT NULL,
	"application_rate" real DEFAULT 0 NOT NULL,
	"acceptance_rate" real DEFAULT 0 NOT NULL,
	"rejection_rate" real DEFAULT 0 NOT NULL,
	"ranking_quality" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrolled_candidate_ids" uuid[] DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_affinities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"affinity" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"positive_events" integer DEFAULT 0 NOT NULL,
	"negative_events" integer DEFAULT 0 NOT NULL,
	"evidence" real DEFAULT 0 NOT NULL,
	"first_observed_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"conflicts_with_explicit" boolean DEFAULT false NOT NULL,
	"explicit_value" text,
	"algorithm_version" text NOT NULL,
	"feature_version" text NOT NULL,
	CONSTRAINT "feature_affinities_key" UNIQUE("candidate_id","dimension","value")
);
--> statement-breakpoint
CREATE TABLE "learning_settings" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"configuration_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"path" text NOT NULL,
	"operation" text NOT NULL,
	"current_value" jsonb,
	"suggested_value" jsonb,
	"message" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"applied_version" integer,
	"algorithm_version" text NOT NULL,
	CONSTRAINT "preference_suggestions_open_key" UNIQUE("candidate_id","path","status")
);
--> statement-breakpoint
CREATE TABLE "query_performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"jobs_discovered" integer DEFAULT 0 NOT NULL,
	"jobs_matched" integer DEFAULT 0 NOT NULL,
	"jobs_shown" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"applications" integer DEFAULT 0 NOT NULL,
	"rejections" integer DEFAULT 0 NOT NULL,
	"engagement_rate" real DEFAULT 0 NOT NULL,
	"value_score" real DEFAULT 0 NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"window_days" smallint DEFAULT 30 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "query_performance_key" UNIQUE("query_id","candidate_id")
);
--> statement-breakpoint
CREATE TABLE "source_user_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"jobs_discovered" integer DEFAULT 0 NOT NULL,
	"jobs_shown" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"applications" integer DEFAULT 0 NOT NULL,
	"rejections" integer DEFAULT 0 NOT NULL,
	"engagement_rate" real DEFAULT 0 NOT NULL,
	"user_value_score" real DEFAULT 0 NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"window_days" smallint DEFAULT 30 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_user_value_key" UNIQUE("source_id","candidate_id")
);
--> statement-breakpoint
ALTER TABLE "behavior_events" ADD CONSTRAINT "behavior_events_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavior_events" ADD CONSTRAINT "behavior_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavioral_profiles" ADD CONSTRAINT "behavioral_profiles_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_snapshots" ADD CONSTRAINT "engagement_snapshots_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_affinities" ADD CONSTRAINT "feature_affinities_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_settings" ADD CONSTRAINT "learning_settings_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_suggestions" ADD CONSTRAINT "preference_suggestions_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_performance" ADD CONSTRAINT "query_performance_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_user_value" ADD CONSTRAINT "source_user_value_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_user_value" ADD CONSTRAINT "source_user_value_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "behavior_events_candidate_idx" ON "behavior_events" USING btree ("candidate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "behavior_events_job_idx" ON "behavior_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "behavior_events_type_idx" ON "behavior_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "behavior_events_unprocessed_idx" ON "behavior_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "behavior_events_recommendation_idx" ON "behavior_events" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "engagement_snapshots_candidate_idx" ON "engagement_snapshots" USING btree ("candidate_id","computed_at");--> statement-breakpoint
CREATE INDEX "feature_affinities_candidate_idx" ON "feature_affinities" USING btree ("candidate_id","confidence");--> statement-breakpoint
CREATE INDEX "feature_affinities_conflict_idx" ON "feature_affinities" USING btree ("candidate_id","conflicts_with_explicit");--> statement-breakpoint
CREATE INDEX "preference_suggestions_candidate_idx" ON "preference_suggestions" USING btree ("candidate_id","status");--> statement-breakpoint
CREATE INDEX "query_performance_value_idx" ON "query_performance" USING btree ("candidate_id","value_score");--> statement-breakpoint
CREATE INDEX "source_user_value_score_idx" ON "source_user_value" USING btree ("candidate_id","user_value_score");