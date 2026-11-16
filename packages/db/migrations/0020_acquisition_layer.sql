CREATE TABLE "job_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"previous_content_hash" text NOT NULL,
	"current_content_hash" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"material" boolean DEFAULT false NOT NULL,
	"notified_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"run_id" uuid,
	"request_id" text NOT NULL,
	"url" text NOT NULL,
	"storage_reference" text NOT NULL,
	"inline_content" text,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer DEFAULT 0 NOT NULL,
	"http_status" integer DEFAULT 200 NOT NULL,
	"acquisition_method" text DEFAULT 'PERMITTED_HTML' NOT NULL,
	"parser_version" text DEFAULT '1.0.0' NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "source_reliability_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"requests_attempted" integer DEFAULT 0 NOT NULL,
	"requests_succeeded" integer DEFAULT 0 NOT NULL,
	"requests_failed" integer DEFAULT 0 NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_parsed" integer DEFAULT 0 NOT NULL,
	"items_rejected" integer DEFAULT 0 NOT NULL,
	"jobs_yielded" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"stale" integer DEFAULT 0 NOT NULL,
	"false_positives" integer DEFAULT 0 NOT NULL,
	"rate_limit_hits" integer DEFAULT 0 NOT NULL,
	"timeouts" integer DEFAULT 0 NOT NULL,
	"average_latency_ms" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_watermarks" (
	"source_id" text PRIMARY KEY NOT NULL,
	"last_successful_scan_at" timestamp with time zone,
	"last_seen_published_at" timestamp with time zone,
	"last_seen_updated_at" timestamp with time zone,
	"last_cursor" text,
	"last_page" integer,
	"last_item_id" text,
	"last_content_hash" text,
	"empty_scans" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_change_events" ADD CONSTRAINT "job_change_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_change_events" ADD CONSTRAINT "job_change_events_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_source_documents" ADD CONSTRAINT "raw_source_documents_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_source_documents" ADD CONSTRAINT "raw_source_documents_run_id_job_source_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_source_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_reliability_windows" ADD CONSTRAINT "source_reliability_windows_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_watermarks" ADD CONSTRAINT "source_watermarks_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_change_events_transition_unique" ON "job_change_events" USING btree ("job_id","previous_content_hash","current_content_hash");--> statement-breakpoint
CREATE INDEX "job_change_events_material_idx" ON "job_change_events" USING btree ("material","detected_at");--> statement-breakpoint
CREATE INDEX "job_change_events_job_idx" ON "job_change_events" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_source_documents_hash_unique" ON "raw_source_documents" USING btree ("source_id","content_hash");--> statement-breakpoint
CREATE INDEX "raw_source_documents_url_idx" ON "raw_source_documents" USING btree ("url");--> statement-breakpoint
CREATE INDEX "raw_source_documents_retrieved_idx" ON "raw_source_documents" USING btree ("retrieved_at");--> statement-breakpoint
CREATE INDEX "raw_source_documents_run_idx" ON "raw_source_documents" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_reliability_window_unique" ON "source_reliability_windows" USING btree ("source_id","window_start");--> statement-breakpoint
CREATE INDEX "source_reliability_window_idx" ON "source_reliability_windows" USING btree ("window_start");
