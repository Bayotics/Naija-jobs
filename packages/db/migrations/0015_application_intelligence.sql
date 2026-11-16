CREATE TABLE "acknowledged_blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid,
	"blocker_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acknowledged_blockers_unique" UNIQUE("candidate_id","job_id","blocker_id")
);
--> statement-breakpoint
CREATE TABLE "application_intelligence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"overall_recommendation" text NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"application_value_score" real DEFAULT 0 NOT NULL,
	"match_score" real,
	"profile_version" integer,
	"eligibility" jsonb NOT NULL,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qualification" jsonb NOT NULL,
	"skill_alignment" jsonb NOT NULL,
	"experience_alignment" jsonb NOT NULL,
	"preference_alignment" jsonb NOT NULL,
	"career_alignment" jsonb NOT NULL,
	"job_quality" jsonb NOT NULL,
	"experience" jsonb NOT NULL,
	"seniority" jsonb NOT NULL,
	"compensation" jsonb NOT NULL,
	"authorization" jsonb NOT NULL,
	"language" jsonb NOT NULL,
	"location" jsonb NOT NULL,
	"friction" jsonb NOT NULL,
	"competitiveness" jsonb NOT NULL,
	"timing" jsonb NOT NULL,
	"legitimacy" jsonb NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resume" jsonb NOT NULL,
	"positioning" jsonb NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" jsonb NOT NULL,
	"unknown_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"algorithm_version" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_intelligence_pair_unique" UNIQUE("candidate_id","job_id","profile_version")
);
--> statement-breakpoint
CREATE TABLE "application_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"state" text DEFAULT 'DISCOVERED' NOT NULL,
	"recommendation" text,
	"application_value_score" real,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_opportunities_pair_unique" UNIQUE("candidate_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "application_policies" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"application_url" text,
	"document_id" uuid,
	"cover_letter_used" boolean DEFAULT false NOT NULL,
	"referral" text,
	"contact_name" text,
	"notes" text,
	"recommendation_at_apply" text,
	"value_score_at_apply" real,
	"first_response_at" timestamp with time zone,
	"last_status_change_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_records_pair_unique" UNIQUE("candidate_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "application_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acknowledged_blockers" ADD CONSTRAINT "acknowledged_blockers_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledged_blockers" ADD CONSTRAINT "acknowledged_blockers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_intelligence" ADD CONSTRAINT "application_intelligence_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_intelligence" ADD CONSTRAINT "application_intelligence_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_opportunities" ADD CONSTRAINT "application_opportunities_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_opportunities" ADD CONSTRAINT "application_opportunities_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_policies" ADD CONSTRAINT "application_policies_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_candidate_id_candidate_profiles_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_records" ADD CONSTRAINT "application_records_document_id_candidate_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."candidate_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_status_events" ADD CONSTRAINT "application_status_events_application_id_application_records_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_transitions" ADD CONSTRAINT "opportunity_transitions_opportunity_id_application_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."application_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acknowledged_blockers_lookup_idx" ON "acknowledged_blockers" USING btree ("candidate_id","blocker_id");--> statement-breakpoint
CREATE INDEX "application_intelligence_rank_idx" ON "application_intelligence" USING btree ("candidate_id","application_value_score");--> statement-breakpoint
CREATE INDEX "application_intelligence_recommendation_idx" ON "application_intelligence" USING btree ("candidate_id","overall_recommendation");--> statement-breakpoint
CREATE INDEX "application_opportunities_state_idx" ON "application_opportunities" USING btree ("candidate_id","state");--> statement-breakpoint
CREATE INDEX "application_opportunities_rank_idx" ON "application_opportunities" USING btree ("candidate_id","application_value_score");--> statement-breakpoint
CREATE INDEX "application_records_status_idx" ON "application_records" USING btree ("candidate_id","status");--> statement-breakpoint
CREATE INDEX "application_records_applied_idx" ON "application_records" USING btree ("candidate_id","applied_at");--> statement-breakpoint
CREATE INDEX "application_records_document_idx" ON "application_records" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "application_status_events_application_idx" ON "application_status_events" USING btree ("application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "opportunity_transitions_opportunity_idx" ON "opportunity_transitions" USING btree ("opportunity_id","occurred_at");