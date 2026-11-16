CREATE TYPE "public"."behavioral_event" AS ENUM('job_viewed', 'job_saved', 'job_ignored', 'job_marked_irrelevant', 'job_marked_interesting', 'job_applied', 'job_rejected', 'job_hidden', 'job_source_clicked', 'job_dismissed');--> statement-breakpoint
CREATE TYPE "public"."cv_import_status" AS ENUM('uploaded', 'extracting', 'extracted', 'needs_review', 'applied', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."preference_source" AS ENUM('explicit', 'imported', 'suggested');--> statement-breakpoint
CREATE TYPE "public"."preference_strength" AS ENUM('required', 'strongly_preferred', 'preferred', 'neutral', 'undesirable', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."skill_importance" AS ENUM('primary', 'secondary', 'peripheral');--> statement-breakpoint
CREATE TYPE "public"."skill_proficiency" AS ENUM('beginner', 'intermediate', 'advanced', 'expert');--> statement-breakpoint
CREATE TYPE "public"."skill_relation_type" AS ENUM('implies', 'related', 'alias', 'part_of');--> statement-breakpoint
CREATE TABLE "behavioral_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"event" "behavioral_event" NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"embedding" vector(1536),
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"canonical_hash" text NOT NULL,
	"canonical_text" text NOT NULL,
	"is_stale" boolean DEFAULT true NOT NULL,
	"stale_reason" text,
	"generated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_preference_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "candidate_skill_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"skill_id" uuid,
	"name" text NOT NULL,
	"slug" text,
	"category" text,
	"proficiency" "skill_proficiency",
	"years_of_experience" real,
	"last_used_year" integer,
	"importance" "skill_importance" DEFAULT 'secondary' NOT NULL,
	"evidence" text,
	"source" "preference_source" DEFAULT 'explicit' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cv_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"raw_text" text,
	"status" "cv_import_status" DEFAULT 'uploaded' NOT NULL,
	"extraction" jsonb,
	"extraction_error" text,
	"accepted_sections" text[] DEFAULT '{}' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"version_id" uuid,
	"path" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"summary" text NOT NULL,
	"invalidated_embedding" boolean DEFAULT false NOT NULL,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_slug" text NOT NULL,
	"to_slug" text NOT NULL,
	"type" "skill_relation_type" NOT NULL,
	"weight" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "behavioral_signals" ADD CONSTRAINT "behavioral_signals_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavioral_signals" ADD CONSTRAINT "behavioral_signals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_embeddings" ADD CONSTRAINT "candidate_embeddings_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_preference_versions" ADD CONSTRAINT "candidate_preference_versions_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skill_profiles" ADD CONSTRAINT "candidate_skill_profiles_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skill_profiles" ADD CONSTRAINT "candidate_skill_profiles_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_imports" ADD CONSTRAINT "cv_imports_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_changes" ADD CONSTRAINT "preference_changes_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_changes" ADD CONSTRAINT "preference_changes_version_id_candidate_preference_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."candidate_preference_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "behavioral_signals_profile_idx" ON "behavioral_signals" USING btree ("profile_id","occurred_at");--> statement-breakpoint
CREATE INDEX "behavioral_signals_job_idx" ON "behavioral_signals" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "behavioral_signals_event_idx" ON "behavioral_signals" USING btree ("event");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_embeddings_profile_model_unique" ON "candidate_embeddings" USING btree ("profile_id","model");--> statement-breakpoint
CREATE INDEX "candidate_embeddings_stale_idx" ON "candidate_embeddings" USING btree ("is_stale");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_preference_versions_unique" ON "candidate_preference_versions" USING btree ("profile_id","version");--> statement-breakpoint
CREATE INDEX "candidate_preference_versions_active_idx" ON "candidate_preference_versions" USING btree ("profile_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_skill_profiles_unique" ON "candidate_skill_profiles" USING btree ("profile_id","name");--> statement-breakpoint
CREATE INDEX "candidate_skill_profiles_slug_idx" ON "candidate_skill_profiles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "candidate_skill_profiles_importance_idx" ON "candidate_skill_profiles" USING btree ("profile_id","importance");--> statement-breakpoint
CREATE INDEX "cv_imports_profile_idx" ON "cv_imports" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "cv_imports_status_idx" ON "cv_imports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "preference_changes_profile_idx" ON "preference_changes" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "preference_changes_path_idx" ON "preference_changes" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_relations_unique" ON "skill_relations" USING btree ("from_slug","to_slug","type");--> statement-breakpoint
CREATE INDEX "skill_relations_from_idx" ON "skill_relations" USING btree ("from_slug");