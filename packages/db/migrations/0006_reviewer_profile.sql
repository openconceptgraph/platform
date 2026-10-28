CREATE TABLE "reviewer_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"public_name" text NOT NULL,
	"public_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewer_profile_public_name_length" CHECK (char_length(btrim("reviewer_profile"."public_name")) between 2 and 60),
	CONSTRAINT "reviewer_profile_public_note_length" CHECK (char_length("reviewer_profile"."public_note") <= 120)
);
--> statement-breakpoint
ALTER TABLE "reviewer_profile" ADD CONSTRAINT "reviewer_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_profile_public_name_key" ON "reviewer_profile" USING btree (lower("public_name"));