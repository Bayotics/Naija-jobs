CREATE TYPE "public"."access_tier" AS ENUM('official_api', 'public_feed', 'permitted_html', 'search_discovery', 'user_provided', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."application_state" AS ENUM('new', 'saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."circuit_state" AS ENUM('closed', 'open', 'half_open');--> statement-breakpoint
CREATE TYPE "public"."education_level" AS ENUM('none', 'high_school', 'diploma', 'bachelors', 'masters', 'doctorate');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('full_time', 'part_time', 'contract', 'internship', 'temporary', 'freelance', 'apprenticeship');--> statement-breakpoint
CREATE TYPE "public"."feedback_action" AS ENUM('interested', 'not_interested', 'applied', 'rejected', 'saved', 'irrelevant', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('active', 'expired', 'closed', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."match_stage" AS ENUM('rule', 'vector', 'triage', 'deep');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'telegram', 'slack', 'webhook', 'web_push');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('instant', 'digest');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('strong_apply', 'apply', 'maybe', 'skip');--> statement-breakpoint
CREATE TYPE "public"."rejection_reason" AS ENUM('duplicate', 'hard_rule', 'expired', 'scam', 'low_quality', 'below_threshold', 'budget_capped', 'extraction_failed', 'validation_failed');--> statement-breakpoint
CREATE TYPE "public"."remote_type" AS ENUM('remote', 'hybrid', 'onsite', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'success', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('schedule', 'manual', 'retry', 'backfill');--> statement-breakpoint
CREATE TYPE "public"."salary_period" AS ENUM('hour', 'day', 'week', 'month', 'year');--> statement-breakpoint
CREATE TYPE "public"."seniority_level" AS ENUM('intern', 'entry', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive');--> statement-breakpoint
CREATE TYPE "public"."source_health_status" AS ENUM('unknown', 'healthy', 'degraded', 'failing', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('ats', 'job_api', 'rss_feed', 'mailbox', 'search_discovery', 'social', 'html_page', 'manual');--> statement-breakpoint
CREATE TYPE "public"."system_event_name" AS ENUM('SYSTEM_STARTED', 'SYSTEM_SHUTDOWN', 'CONFIG_LOADED', 'CONFIG_CHANGED', 'SOURCE_REGISTERED', 'SOURCE_UPDATED', 'SOURCE_DISABLED', 'SOURCE_RUN_STARTED', 'SOURCE_RUN_COMPLETED', 'SOURCE_RUN_FAILED', 'SOURCE_RUN_SKIPPED', 'SOURCE_HEALTH_CHANGED', 'SOURCE_CIRCUIT_OPENED', 'SOURCE_CIRCUIT_CLOSED', 'JOB_DISCOVERED', 'JOB_NORMALIZED', 'JOB_DUPLICATE', 'JOB_UPDATED', 'JOB_REJECTED', 'JOB_EXPIRED', 'JOB_QUARANTINED', 'JOB_MATCHED', 'JOB_BELOW_THRESHOLD', 'MATCH_RECOMPUTE_REQUESTED', 'PROFILE_VERSION_CREATED', 'PROFILE_VERSION_ACTIVATED', 'FEEDBACK_RECORDED', 'APPLICATION_STATE_CHANGED', 'NOTIFICATION_QUEUED', 'NOTIFICATION_SENT', 'NOTIFICATION_FAILED', 'NOTIFICATION_DELIVERED', 'QUEUE_JOB_ENQUEUED', 'QUEUE_JOB_FAILED', 'QUEUE_JOB_DEAD_LETTERED');--> statement-breakpoint
CREATE TYPE "public"."system_event_severity" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."visa_sponsorship" AS ENUM('offered', 'not_offered', 'unknown');--> statement-breakpoint
CREATE TABLE "candidate_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"years_of_experience" real,
	"proficiency" integer,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"change_summary" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"category" text,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_source_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"trigger" "run_trigger" DEFAULT 'schedule' NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"jobs_discovered" integer DEFAULT 0 NOT NULL,
	"jobs_accepted" integer DEFAULT 0 NOT NULL,
	"jobs_rejected" integer DEFAULT 0 NOT NULL,
	"jobs_updated" integer DEFAULT 0 NOT NULL,
	"jobs_duplicated" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"http_requests" integer DEFAULT 0 NOT NULL,
	"bytes_fetched" bigint DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "job_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"display_name" text NOT NULL,
	"source_type" "source_type" NOT NULL,
	"access_tier" "access_tier" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" smallint DEFAULT 2 NOT NULL,
	"schedule_cron" text DEFAULT '0 * * * *' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_refs" text[] DEFAULT '{}' NOT NULL,
	"base_url" text,
	"restriction_reason" text,
	"notes" text,
	"health_status" "source_health_status" DEFAULT 'unknown' NOT NULL,
	"circuit_state" "circuit_state" DEFAULT 'closed' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"circuit_opened_at" timestamp with time zone,
	"last_attempted_run_at" timestamp with time zone,
	"last_successful_run_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_message" text,
	"cursor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"primary_domain" text,
	"website_url" text,
	"logo_url" text,
	"ats_vendor" text,
	"ats_slug" text,
	"industries" text[] DEFAULT '{}' NOT NULL,
	"size_bucket" text,
	"hq_country_code" text,
	"domain_first_seen" date,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector(1536),
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_job_id" uuid,
	"canonical_url" text,
	"canonical_url_confidence" real,
	"canonical_url_kind" text,
	"fingerprint" text NOT NULL,
	"member_count" integer DEFAULT 1 NOT NULL,
	"status" "job_status" DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"confidence" real
);
--> statement-breakpoint
CREATE TABLE "job_urls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_group_id" uuid NOT NULL,
	"job_id" uuid,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"kind" text,
	"http_status" integer,
	"final_url" text,
	"has_jobposting_jsonld" boolean,
	"rank_score" real,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_posting_id" uuid,
	"source_id" text NOT NULL,
	"job_group_id" uuid,
	"company_id" uuid,
	"title" text NOT NULL,
	"title_normalized" text NOT NULL,
	"company_name_raw" text NOT NULL,
	"company_website" text,
	"description" text,
	"description_html" text,
	"responsibilities" text[] DEFAULT '{}' NOT NULL,
	"requirements" text[] DEFAULT '{}' NOT NULL,
	"preferred_qualifications" text[] DEFAULT '{}' NOT NULL,
	"benefits" text[] DEFAULT '{}' NOT NULL,
	"tech_stack" text[] DEFAULT '{}' NOT NULL,
	"employment_types" "employment_type"[] DEFAULT '{}' NOT NULL,
	"remote_type" "remote_type" DEFAULT 'unknown' NOT NULL,
	"seniority" "seniority_level",
	"seniority_confidence" real,
	"location_raw" text,
	"city" text,
	"region" text,
	"country_code" text,
	"latitude" double precision,
	"longitude" double precision,
	"salary_min" numeric(14, 2),
	"salary_max" numeric(14, 2),
	"salary_currency" text,
	"salary_period" "salary_period",
	"salary_is_estimated" boolean DEFAULT false NOT NULL,
	"salary_normalized_annual_usd" numeric(14, 2),
	"salary_fx_rate" numeric(18, 8),
	"visa_sponsorship" "visa_sponsorship" DEFAULT 'unknown' NOT NULL,
	"relocation_support" boolean,
	"education_required" "education_level",
	"min_years_experience" real,
	"max_years_experience" real,
	"source_url" text NOT NULL,
	"canonical_url" text,
	"apply_url" text,
	"external_id" text,
	"content_hash" text NOT NULL,
	"normalized_url" text,
	"url_hash" text,
	"fingerprint" text NOT NULL,
	"simhash" bigint,
	"status" "job_status" DEFAULT 'active' NOT NULL,
	"quality_score" real,
	"scam_score" real,
	"scam_flags" jsonb,
	"posted_at" timestamp with time zone,
	"valid_through" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"source_run_id" uuid,
	"external_id" text,
	"source_url" text,
	"payload" jsonb NOT NULL,
	"payload_format" text NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"state" "application_state" DEFAULT 'new' NOT NULL,
	"applied_at" timestamp with time zone,
	"notes" text,
	"last_transition_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"action" "feedback_action" NOT NULL,
	"reason_codes" text[] DEFAULT '{}' NOT NULL,
	"note" text,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"stage" "match_stage" NOT NULL,
	"match_score" real NOT NULL,
	"confidence" real NOT NULL,
	"recommendation" "recommendation" NOT NULL,
	"rule_score" real,
	"vector_similarity" real,
	"llm_score" real,
	"learned_score" real,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_requirements" text[] DEFAULT '{}' NOT NULL,
	"missing_requirements" text[] DEFAULT '{}' NOT NULL,
	"concerns" text[] DEFAULT '{}' NOT NULL,
	"rejection_reason" "rejection_reason",
	"model_id" text,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"recipient" text NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_ledger" (
	"job_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "notification_kind" DEFAULT 'digest' NOT NULL,
	"subject" text NOT NULL,
	"job_ids" uuid[] DEFAULT '{}' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "system_event_name" NOT NULL,
	"severity" "system_event_severity" DEFAULT 'info' NOT NULL,
	"message" text,
	"trace_id" text,
	"source_id" text,
	"job_id" uuid,
	"run_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skills" ADD CONSTRAINT "candidate_skills_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skills" ADD CONSTRAINT "candidate_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_source_runs" ADD CONSTRAINT "job_source_runs_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_embeddings" ADD CONSTRAINT "job_embeddings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_skills" ADD CONSTRAINT "job_skills_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_skills" ADD CONSTRAINT "job_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_urls" ADD CONSTRAINT "job_urls_job_group_id_job_groups_id_fk" FOREIGN KEY ("job_group_id") REFERENCES "public"."job_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_urls" ADD CONSTRAINT "job_urls_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_versions" ADD CONSTRAINT "job_versions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_raw_posting_id_raw_postings_id_fk" FOREIGN KEY ("raw_posting_id") REFERENCES "public"."raw_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_group_id_job_groups_id_fk" FOREIGN KEY ("job_group_id") REFERENCES "public"."job_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD CONSTRAINT "raw_postings_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD CONSTRAINT "raw_postings_source_run_id_job_source_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."job_source_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_profile_version_id_profile_versions_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."profile_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_ledger" ADD CONSTRAINT "notification_ledger_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_profiles_user_unique" ON "candidate_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_skills_unique" ON "candidate_skills" USING btree ("profile_id","skill_id");--> statement-breakpoint
CREATE INDEX "candidate_skills_skill_idx" ON "candidate_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_versions_profile_version_unique" ON "profile_versions" USING btree ("profile_id","version");--> statement-breakpoint
CREATE INDEX "profile_versions_active_idx" ON "profile_versions" USING btree ("profile_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_slug_unique" ON "skills" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skills_category_idx" ON "skills" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "job_source_runs_source_started_idx" ON "job_source_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "job_source_runs_status_idx" ON "job_source_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_source_runs_trace_idx" ON "job_source_runs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "job_sources_enabled_idx" ON "job_sources" USING btree ("enabled","priority");--> statement-breakpoint
CREATE INDEX "job_sources_connector_idx" ON "job_sources" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "job_sources_health_idx" ON "job_sources" USING btree ("health_status");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_normalized_name_unique" ON "companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "companies_domain_idx" ON "companies" USING btree ("primary_domain");--> statement-breakpoint
CREATE INDEX "companies_ats_idx" ON "companies" USING btree ("ats_vendor","ats_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "job_embeddings_job_model_unique" ON "job_embeddings" USING btree ("job_id","model");--> statement-breakpoint
CREATE INDEX "job_embeddings_hnsw_idx" ON "job_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "job_groups_fingerprint_idx" ON "job_groups" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "job_groups_status_idx" ON "job_groups" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_skills_unique" ON "job_skills" USING btree ("job_id","skill_id");--> statement-breakpoint
CREATE INDEX "job_skills_skill_idx" ON "job_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_urls_group_normalized_unique" ON "job_urls" USING btree ("job_group_id","url_normalized");--> statement-breakpoint
CREATE INDEX "job_urls_rank_idx" ON "job_urls" USING btree ("job_group_id","rank_score");--> statement-breakpoint
CREATE UNIQUE INDEX "job_versions_job_version_unique" ON "job_versions" USING btree ("job_id","version");--> statement-breakpoint
CREATE INDEX "job_versions_detected_idx" ON "job_versions" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_content_hash_unique" ON "jobs" USING btree ("source_id","content_hash");--> statement-breakpoint
CREATE INDEX "jobs_status_posted_idx" ON "jobs" USING btree ("status","posted_at");--> statement-breakpoint
CREATE INDEX "jobs_group_idx" ON "jobs" USING btree ("job_group_id");--> statement-breakpoint
CREATE INDEX "jobs_company_idx" ON "jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "jobs_fingerprint_idx" ON "jobs" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "jobs_url_hash_idx" ON "jobs" USING btree ("url_hash");--> statement-breakpoint
CREATE INDEX "jobs_country_remote_idx" ON "jobs" USING btree ("country_code","remote_type");--> statement-breakpoint
CREATE INDEX "jobs_source_idx" ON "jobs" USING btree ("source_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "jobs_simhash_idx" ON "jobs" USING btree ("simhash");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_postings_source_hash_unique" ON "raw_postings" USING btree ("source_id","content_hash");--> statement-breakpoint
CREATE INDEX "raw_postings_fetched_idx" ON "raw_postings" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "raw_postings_external_idx" ON "raw_postings" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_job_profile_unique" ON "applications" USING btree ("job_id","profile_id");--> statement-breakpoint
CREATE INDEX "applications_state_idx" ON "applications" USING btree ("profile_id","state");--> statement-breakpoint
CREATE INDEX "job_feedback_job_idx" ON "job_feedback" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_feedback_profile_created_idx" ON "job_feedback" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "job_feedback_action_idx" ON "job_feedback" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "job_matches_job_profile_stage_unique" ON "job_matches" USING btree ("job_id","profile_version_id","stage");--> statement-breakpoint
CREATE INDEX "job_matches_score_idx" ON "job_matches" USING btree ("match_score");--> statement-breakpoint
CREATE INDEX "job_matches_profile_idx" ON "job_matches" USING btree ("profile_version_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_idempotency_unique" ON "notification_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_idx" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_ledger_job_channel_unique" ON "notification_ledger" USING btree ("job_id","channel");--> statement-breakpoint
CREATE INDEX "notifications_scheduled_idx" ON "notifications" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "system_events_name_created_idx" ON "system_events" USING btree ("name","created_at");--> statement-breakpoint
CREATE INDEX "system_events_trace_idx" ON "system_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "system_events_job_idx" ON "system_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "system_events_source_idx" ON "system_events" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "system_events_severity_idx" ON "system_events" USING btree ("severity","created_at");