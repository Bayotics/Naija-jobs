-- Event names the search-configuration layer emits.
--
-- Missed by the generated migration because the enum in `events.ts` grew after
-- 0018 was produced. The effect at runtime was silent: every configuration
-- change logged an error and lost its audit event while the change itself
-- succeeded, so the history table stayed correct and the event stream did not.
ALTER TYPE "public"."system_event_name" ADD VALUE IF NOT EXISTS 'SEARCH_CONFIG_CHANGED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE IF NOT EXISTS 'SEARCH_PROFILE_CREATED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE IF NOT EXISTS 'SEARCH_OVERRIDE_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE IF NOT EXISTS 'SEARCH_PAUSED';--> statement-breakpoint
ALTER TYPE "public"."system_event_name" ADD VALUE IF NOT EXISTS 'SEARCH_RESUMED';
