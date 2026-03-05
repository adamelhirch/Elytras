ALTER TYPE "public"."ai_provider_type" ADD VALUE 'github_copilot' BEFORE 'custom';--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "base_url" text;