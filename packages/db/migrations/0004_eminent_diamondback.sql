ALTER TYPE "public"."ai_provider_type" ADD VALUE 'groq' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'mistral' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'xai' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'cerebras' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'minimax' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'openrouter' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'zai' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'vercel-ai-gateway' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'github-copilot' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'google-gemini-cli' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'google-antigravity' BEFORE 'azure_openai';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_type" ADD VALUE 'openai-codex' BEFORE 'azure_openai';