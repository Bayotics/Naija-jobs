DROP TABLE "notification_deliveries" CASCADE;--> statement-breakpoint
DROP TABLE "notification_ledger" CASCADE;--> statement-breakpoint
DROP TABLE "notifications" CASCADE;--> statement-breakpoint
DROP TABLE "notification_channel_deliveries" CASCADE;--> statement-breakpoint
DROP TABLE "notification_decisions" CASCADE;--> statement-breakpoint
DROP TABLE "notification_delivery_events" CASCADE;--> statement-breakpoint
DROP TABLE "notification_events" CASCADE;--> statement-breakpoint
DROP TABLE "notification_preferences" CASCADE;--> statement-breakpoint
DROP TABLE "notified_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "source_alert_state" CASCADE;--> statement-breakpoint
DROP TABLE "digest_plans" CASCADE;--> statement-breakpoint
DROP TABLE "discovery_profile_counts" CASCADE;--> statement-breakpoint
DROP TABLE "notification_address_health" CASCADE;--> statement-breakpoint
DROP TABLE "notification_intelligence_configs" CASCADE;--> statement-breakpoint
DROP TABLE "notification_overrides" CASCADE;--> statement-breakpoint
DROP TABLE "notification_records" CASCADE;--> statement-breakpoint
DROP TABLE "notification_scores" CASCADE;--> statement-breakpoint
DROP TABLE "notification_suppressions" CASCADE;--> statement-breakpoint
ALTER TABLE "pipeline_runs" DROP COLUMN "notifications_generated";--> statement-breakpoint
DROP TYPE "public"."alert_priority";--> statement-breakpoint
DROP TYPE "public"."delivery_event";--> statement-breakpoint
DROP TYPE "public"."notification_channel";--> statement-breakpoint
DROP TYPE "public"."notification_decision";--> statement-breakpoint
DROP TYPE "public"."notification_kind";--> statement-breakpoint
DROP TYPE "public"."notification_status";--> statement-breakpoint
DROP TYPE "public"."notification_type";