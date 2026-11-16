CREATE TABLE "coverage_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"window_hours" integer NOT NULL,
	"sources_searched" integer DEFAULT 0 NOT NULL,
	"sources_available" integer DEFAULT 0 NOT NULL,
	"queries_executed" integer DEFAULT 0 NOT NULL,
	"unique_jobs_discovered" integer DEFAULT 0 NOT NULL,
	"searched_share" real DEFAULT 0 NOT NULL,
	"productive_share" real DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"priority" text NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"terms" jsonb NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"preference_version" integer,
	"executions" integer DEFAULT 0 NOT NULL,
	"jobs_discovered" integer DEFAULT 0 NOT NULL,
	"jobs_matched" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp with time zone,
	"last_result_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "discovery_telemetry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text,
	"run_id" uuid,
	"method" text NOT NULL,
	"query_id" text,
	"query_text" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"unique_results" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"rate_limit_events" integer DEFAULT 0 NOT NULL,
	"not_modified" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"detail" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitored_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"careers_url" text,
	"ats_provider" text,
	"ats_identifier" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_id" text,
	"last_checked_at" timestamp with time zone,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitored_companies_domain_key" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "source_capabilities" (
	"source_id" text PRIMARY KEY NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"methods" text[] DEFAULT '{}' NOT NULL,
	"active_method" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "source_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"resource" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"content_hash" text,
	"cursor" text,
	"last_item_id" text,
	"last_item_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"unchanged_streak" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_checkpoints_resource_key" UNIQUE("source_id","resource")
);
--> statement-breakpoint
CREATE TABLE "source_performance" (
	"source_id" text PRIMARY KEY NOT NULL,
	"window_days" smallint DEFAULT 30 NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"average_jobs_per_run" real DEFAULT 0 NOT NULL,
	"duplicate_rate" real DEFAULT 0 NOT NULL,
	"valid_job_rate" real DEFAULT 0 NOT NULL,
	"enrichment_success_rate" real DEFAULT 0 NOT NULL,
	"match_rate" real DEFAULT 0 NOT NULL,
	"stale_rate" real DEFAULT 0 NOT NULL,
	"error_rate" real DEFAULT 0 NOT NULL,
	"average_latency_ms" integer DEFAULT 0 NOT NULL,
	"value_score" real DEFAULT 0 NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_provided_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"display_name" text,
	"requested_source_type" text,
	"scan_frequency_minutes" integer DEFAULT 360 NOT NULL,
	"search_terms" text[] DEFAULT '{}' NOT NULL,
	"location" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"status" text DEFAULT 'pending_validation' NOT NULL,
	"detection" jsonb,
	"rejection_reason" text,
	"source_id" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	CONSTRAINT "user_provided_sources_url_key" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "coverage_snapshots" ADD CONSTRAINT "coverage_snapshots_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_queries" ADD CONSTRAINT "discovery_queries_profile_id_candidate_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_telemetry" ADD CONSTRAINT "discovery_telemetry_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_companies" ADD CONSTRAINT "monitored_companies_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_capabilities" ADD CONSTRAINT "source_capabilities_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_checkpoints" ADD CONSTRAINT "source_checkpoints_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_performance" ADD CONSTRAINT "source_performance_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_provided_sources" ADD CONSTRAINT "user_provided_sources_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coverage_snapshots_profile_idx" ON "coverage_snapshots" USING btree ("profile_id","generated_at");--> statement-breakpoint
CREATE INDEX "discovery_queries_profile_idx" ON "discovery_queries" USING btree ("profile_id","priority","score");--> statement-breakpoint
CREATE INDEX "discovery_queries_executed_idx" ON "discovery_queries" USING btree ("last_executed_at");--> statement-breakpoint
CREATE INDEX "discovery_telemetry_source_idx" ON "discovery_telemetry" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "discovery_telemetry_query_idx" ON "discovery_telemetry" USING btree ("query_id");--> statement-breakpoint
CREATE INDEX "discovery_telemetry_started_idx" ON "discovery_telemetry" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "monitored_companies_status_idx" ON "monitored_companies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_checkpoints_source_idx" ON "source_checkpoints" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_performance_value_idx" ON "source_performance" USING btree ("value_score");--> statement-breakpoint
CREATE INDEX "user_provided_sources_status_idx" ON "user_provided_sources" USING btree ("status");