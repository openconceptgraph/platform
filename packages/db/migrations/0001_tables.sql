CREATE TYPE "public"."object_kind" AS ENUM('framework', 'education_level', 'document', 'node', 'statement', 'teaching_plan', 'placement', 'family', 'concept', 'level', 'misconception', 'link', 'source');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('proposed', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."statement_type" AS ENUM('content', 'clarification', 'progression', 'exemplar', 'prerequisite');--> statement-breakpoint
CREATE TYPE "public"."concept_kind" AS ENUM('fact', 'category', 'procedure', 'principle');--> statement-breakpoint
CREATE TYPE "public"."link_type" AS ENUM('needs', 'hinders', 'defines', 'part-of', 'replaced-by');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('statement', 'publication', 'reviewer', 'ai');--> statement-breakpoint
CREATE TYPE "public"."decision" AS ENUM('confirm', 'reject', 'needs-change');--> statement-breakpoint
CREATE TABLE "base_object" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "object_kind" NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_object_id_kind_key" UNIQUE("id","kind")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"framework_id" uuid NOT NULL,
	"title" text NOT NULL,
	"language" text NOT NULL,
	"publisher" text,
	"issued" date,
	"version_label" text,
	"url" text,
	"rights" text,
	CONSTRAINT "document_title_present" CHECK ("document"."title" <> '')
);
--> statement-breakpoint
CREATE TABLE "education_level" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"framework_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" jsonb NOT NULL,
	"isced_level" smallint NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "education_level_framework_code_key" UNIQUE("framework_id","code"),
	CONSTRAINT "education_level_title_lang" CHECK (ocg_is_lang_string("education_level"."title")),
	CONSTRAINT "education_level_isced_range" CHECK ("education_level"."isced_level" between 0 and 8)
);
--> statement-breakpoint
CREATE TABLE "framework" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"title" jsonb NOT NULL,
	"jurisdiction" text NOT NULL,
	"subject" text NOT NULL,
	"publisher" text,
	"node_types" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "framework_slug_unique" UNIQUE("slug"),
	CONSTRAINT "framework_title_lang" CHECK (ocg_is_lang_string("framework"."title")),
	CONSTRAINT "framework_slug_format" CHECK ("framework"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$')
);
--> statement-breakpoint
CREATE TABLE "node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" uuid NOT NULL,
	"parent_id" uuid,
	"node_type" text NOT NULL,
	"human_code" text,
	"title" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "node_id_document_key" UNIQUE("id","document_id"),
	CONSTRAINT "node_document_code_key" UNIQUE("document_id","human_code"),
	CONSTRAINT "node_title_present" CHECK ("node"."title" <> '')
);
--> statement-breakpoint
CREATE TABLE "placement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"teaching_plan_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_kind" "object_kind" NOT NULL,
	"education_level_id" uuid NOT NULL,
	"term" smallint,
	"week_start" smallint,
	"week_end" smallint,
	"hours" numeric(5, 1),
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "placement_target_kind" CHECK ("placement"."target_kind" in ('node', 'family', 'concept')),
	CONSTRAINT "placement_weeks_ordered" CHECK ("placement"."week_end" >= "placement"."week_start"),
	CONSTRAINT "placement_hours_positive" CHECK ("placement"."hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "statement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" uuid NOT NULL,
	"node_id" uuid,
	"parent_id" uuid,
	"education_level_id" uuid,
	"statement_type" "statement_type" NOT NULL,
	"is_revision" boolean DEFAULT false NOT NULL,
	"human_code" text,
	"text" text NOT NULL,
	"page" integer,
	"locator" text,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "statement_text_present" CHECK ("statement"."text" <> ''),
	CONSTRAINT "statement_page_positive" CHECK ("statement"."page" > 0)
);
--> statement-breakpoint
CREATE TABLE "teaching_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"framework_id" uuid NOT NULL,
	"document_id" uuid,
	"slug" text NOT NULL,
	"title" jsonb NOT NULL,
	CONSTRAINT "teaching_plan_framework_slug_key" UNIQUE("framework_id","slug"),
	CONSTRAINT "teaching_plan_title_lang" CHECK (ocg_is_lang_string("teaching_plan"."title"))
);
--> statement-breakpoint
CREATE TABLE "concept" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"framework_id" uuid NOT NULL,
	"human_code" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"kind" "concept_kind",
	"is_gateway" boolean DEFAULT false NOT NULL,
	"status" "review_status" DEFAULT 'proposed' NOT NULL,
	CONSTRAINT "concept_framework_code_key" UNIQUE("framework_id","human_code"),
	CONSTRAINT "concept_title_lang" CHECK (ocg_is_lang_string("concept"."title")),
	CONSTRAINT "concept_description_lang" CHECK (ocg_is_lang_string("concept"."description"))
);
--> statement-breakpoint
CREATE TABLE "family" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"framework_id" uuid NOT NULL,
	"human_code" text NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"status" "review_status" DEFAULT 'proposed' NOT NULL,
	CONSTRAINT "family_framework_code_key" UNIQUE("framework_id","human_code"),
	CONSTRAINT "family_title_lang" CHECK (ocg_is_lang_string("family"."title")),
	CONSTRAINT "family_description_lang" CHECK (ocg_is_lang_string("family"."description"))
);
--> statement-breakpoint
CREATE TABLE "level" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"concept_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"status" "review_status" DEFAULT 'proposed' NOT NULL,
	CONSTRAINT "level_concept_ordinal_key" UNIQUE("concept_id","ordinal"),
	CONSTRAINT "level_title_lang" CHECK (ocg_is_lang_string("level"."title")),
	CONSTRAINT "level_description_lang" CHECK (ocg_is_lang_string("level"."description"))
);
--> statement-breakpoint
CREATE TABLE "link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"link_type" "link_type" NOT NULL,
	"from_id" uuid NOT NULL,
	"from_kind" "object_kind" NOT NULL,
	"to_id" uuid NOT NULL,
	"to_kind" "object_kind" NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "review_status" DEFAULT 'proposed' NOT NULL,
	"confidence" real,
	"rationale" text,
	CONSTRAINT "link_type_from_to_key" UNIQUE("link_type","from_id","to_id"),
	CONSTRAINT "link_not_to_self" CHECK ("link"."from_id" <> "link"."to_id"),
	CONSTRAINT "link_endpoint_kinds" CHECK (("link"."link_type" = 'needs' and "link"."from_kind" = 'concept' and "link"."to_kind" = 'concept')
       or ("link"."link_type" = 'hinders' and "link"."from_kind" = 'misconception' and "link"."to_kind" = 'concept')
       or ("link"."link_type" = 'defines' and "link"."from_kind" = 'statement' and "link"."to_kind" = 'concept')
       or ("link"."link_type" = 'part-of' and "link"."from_kind" = 'concept' and "link"."to_kind" = 'family')
       or ("link"."link_type" = 'replaced-by' and "link"."from_kind" = "link"."to_kind")),
	CONSTRAINT "link_confidence_range" CHECK ("link"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "misconception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"framework_id" uuid NOT NULL,
	"human_code" text NOT NULL,
	"statement" jsonb NOT NULL,
	"example" jsonb,
	"source_id" uuid,
	"status" "review_status" DEFAULT 'proposed' NOT NULL,
	CONSTRAINT "misconception_framework_code_key" UNIQUE("framework_id","human_code"),
	CONSTRAINT "misconception_statement_lang" CHECK (ocg_is_lang_string("misconception"."statement")),
	CONSTRAINT "misconception_example_lang" CHECK (ocg_is_lang_string("misconception"."example"))
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"framework_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"statement_id" uuid,
	"citation" text,
	"url" text,
	"reviewer_id" text,
	"model" text,
	"prompt_version" text,
	CONSTRAINT "source_kind_fields" CHECK (("source"."kind" = 'statement' and "source"."statement_id" is not null)
       or ("source"."kind" = 'publication' and coalesce("source"."citation", '') <> '')
       or ("source"."kind" = 'reviewer' and "source"."reviewer_id" is not null)
       or ("source"."kind" = 'ai' and "source"."model" is not null and "source"."prompt_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batch_item" (
	"batch_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"object_kind" "object_kind" NOT NULL,
	"control_expected" "decision",
	"control_note" text,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "batch_item_pkey" PRIMARY KEY("batch_id","object_id")
);
--> statement-breakpoint
CREATE TABLE "judgement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"object_kind" "object_kind" NOT NULL,
	"object_revision" integer NOT NULL,
	"reviewer_id" text NOT NULL,
	"decision" "decision" NOT NULL,
	"reason_code" text,
	"reason" text,
	"evidence" jsonb NOT NULL,
	"batch_id" uuid,
	"is_control" boolean DEFAULT false NOT NULL,
	"time_spent_ms" integer,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judgement_id_object_reviewer_key" UNIQUE("id","object_id","reviewer_id"),
	CONSTRAINT "judgement_supersedes_once_key" UNIQUE("supersedes_id"),
	CONSTRAINT "judgement_reason_given" CHECK (("judgement"."decision" = 'confirm' and coalesce("judgement"."reason_code", '') <> '')
       or ("judgement"."decision" <> 'confirm' and coalesce(trim("judgement"."reason"), '') <> '')),
	CONSTRAINT "judgement_time_spent_nonnegative" CHECK ("judgement"."time_spent_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_level" ADD CONSTRAINT "education_level_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_level" ADD CONSTRAINT "education_level_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework" ADD CONSTRAINT "framework_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_parent_id_node_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_teaching_plan_id_teaching_plan_id_fk" FOREIGN KEY ("teaching_plan_id") REFERENCES "public"."teaching_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_education_level_id_education_level_id_fk" FOREIGN KEY ("education_level_id") REFERENCES "public"."education_level"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_target_fk" FOREIGN KEY ("target_id","target_kind") REFERENCES "public"."base_object"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_parent_id_statement_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."statement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_education_level_id_education_level_id_fk" FOREIGN KEY ("education_level_id") REFERENCES "public"."education_level"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_node_same_document_fk" FOREIGN KEY ("node_id","document_id") REFERENCES "public"."node"("id","document_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_plan" ADD CONSTRAINT "teaching_plan_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_plan" ADD CONSTRAINT "teaching_plan_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_plan" ADD CONSTRAINT "teaching_plan_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept" ADD CONSTRAINT "concept_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept" ADD CONSTRAINT "concept_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family" ADD CONSTRAINT "family_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family" ADD CONSTRAINT "family_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level" ADD CONSTRAINT "level_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level" ADD CONSTRAINT "level_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_from_fk" FOREIGN KEY ("from_id","from_kind") REFERENCES "public"."base_object"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_to_fk" FOREIGN KEY ("to_id","to_kind") REFERENCES "public"."base_object"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception" ADD CONSTRAINT "misconception_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception" ADD CONSTRAINT "misconception_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misconception" ADD CONSTRAINT "misconception_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_id_base_object_id_fk" FOREIGN KEY ("id") REFERENCES "public"."base_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_statement_id_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_item" ADD CONSTRAINT "batch_item_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_item" ADD CONSTRAINT "batch_item_object_fk" FOREIGN KEY ("object_id","object_kind") REFERENCES "public"."base_object"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgement" ADD CONSTRAINT "judgement_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgement" ADD CONSTRAINT "judgement_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgement" ADD CONSTRAINT "judgement_object_fk" FOREIGN KEY ("object_id","object_kind") REFERENCES "public"."base_object"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgement" ADD CONSTRAINT "judgement_supersedes_fk" FOREIGN KEY ("supersedes_id","object_id","reviewer_id") REFERENCES "public"."judgement"("id","object_id","reviewer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_framework_idx" ON "document" USING btree ("framework_id");--> statement-breakpoint
CREATE INDEX "node_parent_idx" ON "node" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "placement_plan_idx" ON "placement" USING btree ("teaching_plan_id");--> statement-breakpoint
CREATE INDEX "placement_target_idx" ON "placement" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "statement_document_idx" ON "statement" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "statement_node_idx" ON "statement" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "link_from_idx" ON "link" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "link_to_idx" ON "link" USING btree ("to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "link_one_family_per_concept" ON "link" USING btree ("from_id") WHERE "link"."link_type" = 'part-of' and "link"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "source_framework_idx" ON "source" USING btree ("framework_id");--> statement-breakpoint
CREATE INDEX "judgement_object_idx" ON "judgement" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "judgement_reviewer_idx" ON "judgement" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "judgement_batch_idx" ON "judgement" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");