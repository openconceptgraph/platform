CREATE SCHEMA IF NOT EXISTS "overlay";
--> statement-breakpoint
CREATE TYPE "overlay"."alignment_type" AS ENUM('teaches', 'assumes', 'tests', 'reveals', 'backfills', 'covers', 'explains');--> statement-breakpoint
CREATE TYPE "overlay"."source_kind" AS ENUM('ai', 'person', 'import');--> statement-breakpoint
CREATE TYPE "overlay"."status" AS ENUM('proposed', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "overlay"."target_kind" AS ENUM('concept', 'level', 'misconception', 'statement', 'node');--> statement-breakpoint
CREATE TABLE "overlay"."alignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artefact_id" uuid NOT NULL,
	"part" text,
	"alignment_type" "overlay"."alignment_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"target_kind" "overlay"."target_kind" NOT NULL,
	"source_kind" "overlay"."source_kind" NOT NULL,
	"source_model" text,
	"source_prompt_version" text,
	"source_by" text,
	"source_date" date,
	"status" "overlay"."status" DEFAULT 'proposed' NOT NULL,
	"confidence" double precision,
	"rationale" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alignment_target_kind" CHECK (CASE "overlay"."alignment"."alignment_type"
            WHEN 'reveals' THEN "overlay"."alignment"."target_kind" = 'misconception'
            WHEN 'covers' THEN "overlay"."alignment"."target_kind" IN ('statement', 'node')
            ELSE "overlay"."alignment"."target_kind" IN ('concept', 'level')
          END),
	CONSTRAINT "alignment_ai_source" CHECK ("overlay"."alignment"."source_kind" <> 'ai' OR ("overlay"."alignment"."source_model" IS NOT NULL AND "overlay"."alignment"."source_prompt_version" IS NOT NULL)),
	CONSTRAINT "alignment_person_source" CHECK ("overlay"."alignment"."source_kind" <> 'person' OR "overlay"."alignment"."source_by" IS NOT NULL),
	CONSTRAINT "alignment_confidence" CHECK ("overlay"."alignment"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "alignment_rationale_lang" CHECK (overlay.is_lang_string("overlay"."alignment"."rationale"))
);
--> statement-breakpoint
CREATE TABLE "overlay"."artefact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"kind" text NOT NULL,
	"code" text,
	"title" jsonb NOT NULL,
	"language" text NOT NULL,
	"parent_id" uuid,
	"ordinal" integer,
	"url" text,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artefact_title_lang" CHECK (overlay.is_lang_string("overlay"."artefact"."title")),
	CONSTRAINT "artefact_not_its_own_parent" CHECK ("overlay"."artefact"."parent_id" IS DISTINCT FROM "overlay"."artefact"."id")
);
--> statement-breakpoint
CREATE TABLE "overlay"."artefact_kind" (
	"kind" text PRIMARY KEY NOT NULL,
	"label" jsonb NOT NULL,
	"description" jsonb,
	"alignments" "overlay"."alignment_type"[] NOT NULL,
	"learning_resource_type" text,
	"ordinal" integer NOT NULL,
	CONSTRAINT "artefact_kind_format" CHECK ("overlay"."artefact_kind"."kind" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "artefact_kind_alignments" CHECK (cardinality("overlay"."artefact_kind"."alignments") > 0),
	CONSTRAINT "artefact_kind_label_lang" CHECK (overlay.is_lang_string("overlay"."artefact_kind"."label")),
	CONSTRAINT "artefact_kind_description_lang" CHECK (overlay.is_lang_string("overlay"."artefact_kind"."description"))
);
--> statement-breakpoint
CREATE TABLE "overlay"."placement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"artefact_id" uuid NOT NULL,
	"education_level_id" uuid NOT NULL,
	"term" smallint,
	"week_start" smallint,
	"week_end" smallint,
	"hours" numeric(5, 1),
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placement_term" CHECK ("overlay"."placement"."term" >= 1),
	CONSTRAINT "placement_weeks" CHECK ("overlay"."placement"."week_start" >= 1 AND "overlay"."placement"."week_end" >= 1 AND "overlay"."placement"."week_end" >= "overlay"."placement"."week_start"),
	CONSTRAINT "placement_hours" CHECK ("overlay"."placement"."hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "overlay"."plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"slug" text NOT NULL,
	"title" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_slug_key" UNIQUE("slug"),
	CONSTRAINT "plan_slug_format" CHECK ("overlay"."plan"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'),
	CONSTRAINT "plan_title_lang" CHECK (overlay.is_lang_string("overlay"."plan"."title"))
);
--> statement-breakpoint
CREATE TABLE "overlay"."profile" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"version" text,
	"base_slug" text NOT NULL,
	"base_framework" uuid NOT NULL,
	"base_version" text NOT NULL,
	"base_manifest_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_namespace_unique" UNIQUE("namespace"),
	CONSTRAINT "profile_one_client" CHECK ("overlay"."profile"."id" = 1),
	CONSTRAINT "profile_namespace_format" CHECK ("overlay"."profile"."namespace" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "profile_manifest_sha256" CHECK ("overlay"."profile"."base_manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "overlay"."alignment" ADD CONSTRAINT "alignment_artefact_id_artefact_id_fk" FOREIGN KEY ("artefact_id") REFERENCES "overlay"."artefact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay"."artefact" ADD CONSTRAINT "artefact_namespace_profile_namespace_fk" FOREIGN KEY ("namespace") REFERENCES "overlay"."profile"("namespace") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay"."artefact" ADD CONSTRAINT "artefact_kind_artefact_kind_kind_fk" FOREIGN KEY ("kind") REFERENCES "overlay"."artefact_kind"("kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay"."artefact" ADD CONSTRAINT "artefact_parent_id_artefact_id_fk" FOREIGN KEY ("parent_id") REFERENCES "overlay"."artefact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay"."placement" ADD CONSTRAINT "placement_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "overlay"."plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay"."placement" ADD CONSTRAINT "placement_artefact_id_artefact_id_fk" FOREIGN KEY ("artefact_id") REFERENCES "overlay"."artefact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay"."plan" ADD CONSTRAINT "plan_namespace_profile_namespace_fk" FOREIGN KEY ("namespace") REFERENCES "overlay"."profile"("namespace") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alignment_artefact_idx" ON "overlay"."alignment" USING btree ("artefact_id");--> statement-breakpoint
CREATE INDEX "alignment_target_idx" ON "overlay"."alignment" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "artefact_parent_idx" ON "overlay"."artefact" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "placement_plan_idx" ON "overlay"."placement" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "placement_artefact_idx" ON "overlay"."placement" USING btree ("artefact_id");