CREATE TABLE "planted" (
	"object_id" uuid PRIMARY KEY NOT NULL,
	"object_kind" "object_kind" NOT NULL,
	"expected" "decision" DEFAULT 'reject' NOT NULL,
	"note" text NOT NULL,
	"planted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planted_note_present" CHECK (btrim("planted"."note") <> '')
);
--> statement-breakpoint
ALTER TABLE "planted" ADD CONSTRAINT "planted_planted_by_user_id_fk" FOREIGN KEY ("planted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planted" ADD CONSTRAINT "planted_object_fk" FOREIGN KEY ("object_id","object_kind") REFERENCES "public"."base_object"("id","kind") ON DELETE no action ON UPDATE no action;