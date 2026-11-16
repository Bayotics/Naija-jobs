CREATE TABLE "coordination_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"fencing_token" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" integer NOT NULL,
	"capacity" integer NOT NULL,
	"refill_milli_per_second" integer NOT NULL,
	"last_refill_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_type" text NOT NULL,
	"profile_id" uuid,
	"source_id" text,
	"interval_minutes" integer NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"misfire_policy" text DEFAULT 'RUN_ONCE' NOT NULL,
	"max_catch_up_runs" integer DEFAULT 3 NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_successful_run_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"priority" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_id" uuid,
	"source_id" text,
	"job_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"last_failure_class" text,
	"last_worker_id" text,
	"first_failed_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retried_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'READY' NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"priority_rank" integer DEFAULT 2 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_id" uuid,
	"source_id" text,
	"job_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"scheduled_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"last_failure_class" text,
	"timeout_ms" integer,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"task_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" text DEFAULT '0.0.0' NOT NULL,
	"hostname" text DEFAULT 'unknown' NOT NULL,
	"pid" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'STARTING' NOT NULL,
	"current_task_id" uuid,
	"concurrency" integer DEFAULT 4 NOT NULL,
	"tasks_processed" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "rate_limit_blocked_idx" ON "rate_limit_buckets" USING btree ("blocked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_target_unique" ON "schedules" USING btree ("task_type",coalesce("profile_id"::text, ''),coalesce("source_id", ''));--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dead_letters_task_unique" ON "task_dead_letters" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_dead_letters_type_idx" ON "task_dead_letters" USING btree ("type","dead_lettered_at");--> statement-breakpoint
CREATE INDEX "task_dead_letters_source_idx" ON "task_dead_letters" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_live_unique" ON "tasks" USING btree ("idempotency_key") WHERE "tasks"."status" IN ('PENDING','SCHEDULED','READY','PROCESSING','RETRYING','FAILED');--> statement-breakpoint
CREATE INDEX "tasks_claim_idx" ON "tasks" USING btree ("status","priority_rank","available_at");--> statement-breakpoint
CREATE INDEX "tasks_lease_idx" ON "tasks" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "tasks_profile_idx" ON "tasks" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "tasks_source_idx" ON "tasks" USING btree ("source_id","status");--> statement-breakpoint
CREATE INDEX "tasks_type_idx" ON "tasks" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "workers_heartbeat_idx" ON "workers" USING btree ("state","last_heartbeat_at");