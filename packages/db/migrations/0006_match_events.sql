ALTER TYPE "public"."system_event_name" ADD VALUE 'MATCH_RUN_COMPLETED' BEFORE 'PROFILE_VERSION_CREATED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'MATCH_RUN_FAILED' BEFORE 'PROFILE_VERSION_CREATED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE 'EMBEDDING_GENERATED' BEFORE 'PROFILE_VERSION_CREATED';