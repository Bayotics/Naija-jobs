CREATE TYPE "public"."enrichment_status" AS ENUM('pending', 'processing', 'enriched', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."skill_requirement" AS ENUM('required', 'preferred', 'optional', 'inferred');--> statement-breakpoint
CREATE TABLE "job_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"enrichment_version" integer NOT NULL,
	"status" "enrichment_status" DEFAULT 'enriched' NOT NULL,
	"normalized_title" text NOT NULL,
	"role_slug" text,
	"title_confidence" real,
	"seniority" text,
	"seniority_confidence" real,
	"seniority_conflict" text,
	"min_years_experience" real,
	"max_years_experience" real,
	"work_mode" text,
	"work_mode_confidence" real,
	"remote_worldwide" boolean,
	"remote_regions" text[] DEFAULT '{}' NOT NULL,
	"country_code" text,
	"city" text,
	"visa_sponsorship" text,
	"visa_confidence" real,
	"salary_stated" boolean,
	"salary_annual_usd" numeric(14, 2),
	"job_function" text,
	"quality_score" real,
	"scam_score" real,
	"experience" jsonb NOT NULL,
	"work_arrangement" jsonb NOT NULL,
	"location" jsonb NOT NULL,
	"compensation" jsonb NOT NULL,
	"work_authorization" jsonb NOT NULL,
	"education" jsonb NOT NULL,
	"classification" jsonb NOT NULL,
	"quality" jsonb NOT NULL,
	"application_target" jsonb NOT NULL,
	"responsibilities" text[] DEFAULT '{}' NOT NULL,
	"requirements" text[] DEFAULT '{}' NOT NULL,
	"preferred_qualifications" text[] DEFAULT '{}' NOT NULL,
	"benefits" text[] DEFAULT '{}' NOT NULL,
	"cleaned_description" text,
	"cleaning_removed_chars" integer DEFAULT 0 NOT NULL,
	"stage_reports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_duration_ms" integer DEFAULT 0 NOT NULL,
	"ai_used" boolean DEFAULT false NOT NULL,
	"ai_model" text,
	"ai_input_tokens" integer,
	"ai_output_tokens" integer,
	"ai_cost_usd" numeric(12, 6),
	"ai_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_skill_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"skill_id" uuid,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"category" text NOT NULL,
	"requirement" "skill_requirement" NOT NULL,
	"confidence" real NOT NULL,
	"method" text NOT NULL,
	"matched_text" text,
	"evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_enrichments" ADD CONSTRAINT "job_enrichments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_skill_extractions" ADD CONSTRAINT "job_skill_extractions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_skill_extractions" ADD CONSTRAINT "job_skill_extractions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_enrichments_job_unique" ON "job_enrichments" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_enrichments_version_idx" ON "job_enrichments" USING btree ("enrichment_version");--> statement-breakpoint
CREATE INDEX "job_enrichments_role_idx" ON "job_enrichments" USING btree ("role_slug");--> statement-breakpoint
CREATE INDEX "job_enrichments_seniority_idx" ON "job_enrichments" USING btree ("seniority");--> statement-breakpoint
CREATE INDEX "job_enrichments_workmode_idx" ON "job_enrichments" USING btree ("work_mode","country_code");--> statement-breakpoint
CREATE INDEX "job_enrichments_visa_idx" ON "job_enrichments" USING btree ("visa_sponsorship");--> statement-breakpoint
CREATE INDEX "job_enrichments_salary_idx" ON "job_enrichments" USING btree ("salary_annual_usd");--> statement-breakpoint
CREATE INDEX "job_enrichments_quality_idx" ON "job_enrichments" USING btree ("quality_score");--> statement-breakpoint
CREATE INDEX "job_enrichments_scam_idx" ON "job_enrichments" USING btree ("scam_score");--> statement-breakpoint
CREATE UNIQUE INDEX "job_skill_extractions_job_slug_unique" ON "job_skill_extractions" USING btree ("job_id","slug");--> statement-breakpoint
CREATE INDEX "job_skill_extractions_slug_idx" ON "job_skill_extractions" USING btree ("slug","requirement");--> statement-breakpoint
CREATE INDEX "job_skill_extractions_job_idx" ON "job_skill_extractions" USING btree ("job_id");