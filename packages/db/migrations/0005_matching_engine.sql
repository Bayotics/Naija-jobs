CREATE TABLE "job_match_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"overall_score" real NOT NULL,
	"confidence" real NOT NULL,
	"recommendation" "recommendation_category" NOT NULL,
	"eligible" boolean NOT NULL,
	"matching_version" text NOT NULL,
	"profile_version" integer DEFAULT 0 NOT NULL,
	"preference_version" integer DEFAULT 0 NOT NULL,
	"enrichment_version" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"preference_version_id" uuid,
	"overall_score" real NOT NULL,
	"confidence" real NOT NULL,
	"recommendation" "recommendation_category" NOT NULL,
	"eligible" boolean NOT NULL,
	"structured_score" real NOT NULL,
	"semantic_score" real,
	"behavioral_adjustment" real DEFAULT 0 NOT NULL,
	"llm_adjustment" real DEFAULT 0 NOT NULL,
	"hard_constraint_result" jsonb NOT NULL,
	"component_scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill_matches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_requirements" text[] DEFAULT '{}' NOT NULL,
	"missing_requirements" text[] DEFAULT '{}' NOT NULL,
	"concerns" text[] DEFAULT '{}' NOT NULL,
	"positive_signals" text[] DEFAULT '{}' NOT NULL,
	"negative_signals" text[] DEFAULT '{}' NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"trace" jsonb NOT NULL,
	"matching_version" text NOT NULL,
	"enrichment_version" integer DEFAULT 0 NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_match_history" ADD CONSTRAINT "job_match_history_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_match_history" ADD CONSTRAINT "job_match_history_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_profile_version_id_profile_versions_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."profile_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_preference_version_id_candidate_preference_versions_id_fk" FOREIGN KEY ("preference_version_id") REFERENCES "public"."candidate_preference_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_match_history_job_profile_idx" ON "job_match_history" USING btree ("job_id","profile_id","computed_at");--> statement-breakpoint
CREATE INDEX "job_match_history_profile_idx" ON "job_match_history" USING btree ("profile_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_matches_job_profile_unique" ON "job_matches" USING btree ("job_id","profile_id");--> statement-breakpoint
CREATE INDEX "job_matches_score_idx" ON "job_matches" USING btree ("profile_id","overall_score");--> statement-breakpoint
CREATE INDEX "job_matches_recommendation_idx" ON "job_matches" USING btree ("profile_id","recommendation");--> statement-breakpoint
CREATE INDEX "job_matches_eligible_idx" ON "job_matches" USING btree ("profile_id","eligible");--> statement-breakpoint
CREATE INDEX "job_matches_version_idx" ON "job_matches" USING btree ("matching_version");--> statement-breakpoint
CREATE INDEX "job_matches_computed_idx" ON "job_matches" USING btree ("profile_id","computed_at");