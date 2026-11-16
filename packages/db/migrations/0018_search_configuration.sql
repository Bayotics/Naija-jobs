ALTER TYPE "public"."system_event_name" ADD VALUE 'NOTIFICATION_SCORING_COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'NOTIFICATION_DIGEST_PLANNED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'NOTIFICATION_ADDRESS_SUPPRESSED';--> statement-breakpoint
CREATE TABLE "profile_job_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"eligible" boolean DEFAULT true NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"matched_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovered_by_profile" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_job_matches_unique" UNIQUE("profile_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "search_config_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"profile_id" uuid,
	"operation" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot_before" jsonb,
	"source" text NOT NULL,
	"actor" text DEFAULT 'user' NOT NULL,
	"reason" text,
	"instruction" text,
	"undone_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"profile_id" uuid,
	"field" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"profile_name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'active' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_strictness" text DEFAULT 'preferred' NOT NULL,
	"remote_preference" text DEFAULT 'ANY' NOT NULL,
	"remote_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"employment_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seniority_levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minimum_experience_years" real,
	"maximum_experience_years" real,
	"salary" jsonb NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill_strictness" text DEFAULT 'near_hard' NOT NULL,
	"keywords" jsonb NOT NULL,
	"companies" jsonb NOT NULL,
	"industries" jsonb NOT NULL,
	"visa" jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_frequency" text DEFAULT 'hourly' NOT NULL,
	"notification_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_profiles_name_unique" UNIQUE("candidate_id","profile_name")
);
--> statement-breakpoint
CREATE TABLE "search_states" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"config_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_job_matches" ADD CONSTRAINT "profile_job_matches_profile_id_search_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."search_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_job_matches" ADD CONSTRAINT "profile_job_matches_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_job_matches" ADD CONSTRAINT "profile_job_matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_config_history" ADD CONSTRAINT "search_config_history_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_config_history" ADD CONSTRAINT "search_config_history_profile_id_search_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."search_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_overrides" ADD CONSTRAINT "search_overrides_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_overrides" ADD CONSTRAINT "search_overrides_profile_id_search_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."search_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_states" ADD CONSTRAINT "search_states_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_job_matches_job_idx" ON "profile_job_matches" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "profile_job_matches_rank_idx" ON "profile_job_matches" USING btree ("profile_id","score");--> statement-breakpoint
CREATE INDEX "search_config_history_candidate_idx" ON "search_config_history" USING btree ("candidate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "search_config_history_profile_idx" ON "search_config_history" USING btree ("profile_id","occurred_at");--> statement-breakpoint
CREATE INDEX "search_overrides_active_idx" ON "search_overrides" USING btree ("candidate_id","active","end_time");--> statement-breakpoint
CREATE INDEX "search_overrides_profile_idx" ON "search_overrides" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "search_overrides_expiry_idx" ON "search_overrides" USING btree ("active","end_time");--> statement-breakpoint
CREATE INDEX "search_profiles_candidate_idx" ON "search_profiles" USING btree ("candidate_id","state");--> statement-breakpoint
CREATE INDEX "search_profiles_schedule_idx" ON "search_profiles" USING btree ("enabled","last_run_at");