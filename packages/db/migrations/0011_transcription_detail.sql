CREATE TYPE "public"."check_method" AS ENUM('machine', 'person');--> statement-breakpoint
CREATE TYPE "public"."statement_verification" AS ENUM('text-layer', 'eye');--> statement-breakpoint
CREATE TABLE "transcription_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"method" "check_method" NOT NULL,
	"pages" integer[],
	"checked_on" date NOT NULL,
	"checked_by" text,
	"note" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcription_check_person_named" CHECK ("transcription_check"."method" <> 'person' or coalesce(btrim("transcription_check"."checked_by"), '') <> ''),
	CONSTRAINT "transcription_check_pages_present" CHECK ("transcription_check"."pages" is null or cardinality("transcription_check"."pages") > 0),
	CONSTRAINT "transcription_check_note_lang" CHECK (ocg_is_lang_string("transcription_check"."note"))
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "file_sha256" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "file_pages" integer;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "printed_page_offset" integer;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "as_printed" text;--> statement-breakpoint
ALTER TABLE "statement" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "statement" ADD COLUMN "heading" text;--> statement-breakpoint
ALTER TABLE "statement" ADD COLUMN "note" jsonb;--> statement-breakpoint
ALTER TABLE "statement" ADD COLUMN "verified_by" "statement_verification";--> statement-breakpoint
ALTER TABLE "transcription_check" ADD CONSTRAINT "transcription_check_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcription_check_document_idx" ON "transcription_check" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_file_sha256_format" CHECK ("document"."file_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_file_pages_positive" CHECK ("document"."file_pages" > 0);--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_as_printed_present" CHECK ("placement"."as_printed" <> '');--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_label_present" CHECK ("statement"."label" <> '');--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_heading_present" CHECK ("statement"."heading" <> '');--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_note_lang" CHECK (ocg_is_lang_string("statement"."note"));