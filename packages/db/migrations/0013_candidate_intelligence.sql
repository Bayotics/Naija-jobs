ALTER TYPE "public"."system_event_name" ADD VALUE 'DOCUMENT_UPLOADED' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'DOCUMENT_REJECTED' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'DOCUMENT_EXTRACTED' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'DOCUMENT_DELETED' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'INTELLIGENCE_PROFILE_REBUILT' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'PROFILE_CONFLICT_DETECTED' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'PROFILE_FIELD_OVERRIDDEN' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'EXTERNAL_PROFILE_LINKED' BEFORE 'FEEDBACK_RECORDED';--> statement-breakpoint
CREATE TABLE "candidate_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" text DEFAULT 'resume' NOT NULL,
	"label" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"rejection_reason" text,
	"target_role" text,
	"pipeline_stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text_length" integer DEFAULT 0 NOT NULL,
	"extractor_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "candidate_documents_hash_unique" UNIQUE("candidate_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "candidate_intelligence_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"summary" text,
	"summary_generated" boolean DEFAULT true NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"experience" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"education" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"certifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"projects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"achievements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seniority" jsonb NOT NULL,
	"trajectory" jsonb NOT NULL,
	"quality" jsonb,
	"source_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_conflicts" smallint DEFAULT 0 NOT NULL,
	"extraction_version" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"extraction_model" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_intelligence_version_unique" UNIQUE("candidate_id","profile_version")
);
--> statement-breakpoint
CREATE TABLE "candidate_skill_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"proficiency" text,
	"proficiency_confidence" real DEFAULT 0 NOT NULL,
	"proficiency_rationale" text DEFAULT '' NOT NULL,
	"total_months" integer,
	"months_is_estimate" boolean DEFAULT false NOT NULL,
	"last_evidenced_at" timestamp with time zone,
	"first_evidenced_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strongest_source" text,
	"user_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_skill_facts_unique" UNIQUE("candidate_id","profile_version","slug")
);
--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"experience" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"education" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"certifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"projects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"achievements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"extraction_version" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"extraction_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_extractions_document_id_unique" UNIQUE("document_id")
);
--> statement-breakpoint
CREATE TABLE "document_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"heading" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"text" text NOT NULL,
	"confidence" real NOT NULL,
	"ai_classified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"identifier" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"derived_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_profiles_unique" UNIQUE("candidate_id","provider","identifier")
);
--> statement-breakpoint
CREATE TABLE "profile_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"positions" jsonb NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_value" text,
	"resolved_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_conflicts_subject_unique" UNIQUE("candidate_id","kind","subject")
);
--> statement-breakpoint
CREATE TABLE "profile_field_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"path" text NOT NULL,
	"value" jsonb,
	"previous_value" jsonb,
	"origin" text DEFAULT 'user_verified' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_field_overrides_path_unique" UNIQUE("candidate_id","path")
);
--> statement-breakpoint
CREATE TABLE "requirement_matrices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"direct_matches" smallint DEFAULT 0 NOT NULL,
	"transferable_matches" smallint DEFAULT 0 NOT NULL,
	"unknowns" smallint DEFAULT 0 NOT NULL,
	"missing" smallint DEFAULT 0 NOT NULL,
	"coverage_score" real DEFAULT 0 NOT NULL,
	"profile_version" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_matrices_pair_unique" UNIQUE("candidate_id","job_id","profile_version")
);
--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_intelligence_profiles" ADD CONSTRAINT "candidate_intelligence_profiles_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skill_facts" ADD CONSTRAINT "candidate_skill_facts_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_candidate_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."candidate_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_id_candidate_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."candidate_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD CONSTRAINT "external_profiles_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_conflicts" ADD CONSTRAINT "profile_conflicts_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_field_overrides" ADD CONSTRAINT "profile_field_overrides_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_matrices" ADD CONSTRAINT "requirement_matrices_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_matrices" ADD CONSTRAINT "requirement_matrices_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_documents_candidate_idx" ON "candidate_documents" USING btree ("candidate_id","uploaded_at");--> statement-breakpoint
CREATE INDEX "candidate_documents_status_idx" ON "candidate_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "candidate_intelligence_active_idx" ON "candidate_intelligence_profiles" USING btree ("candidate_id","is_active");--> statement-breakpoint
CREATE INDEX "candidate_skill_facts_lookup_idx" ON "candidate_skill_facts" USING btree ("slug","candidate_id");--> statement-breakpoint
CREATE INDEX "document_extractions_candidate_idx" ON "document_extractions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "document_sections_document_idx" ON "document_sections" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "profile_conflicts_open_idx" ON "profile_conflicts" USING btree ("candidate_id","status");--> statement-breakpoint
CREATE INDEX "requirement_matrices_job_idx" ON "requirement_matrices" USING btree ("job_id");