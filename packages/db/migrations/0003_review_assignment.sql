ALTER TABLE "batch" ADD COLUMN "assigned_to" text NOT NULL;--> statement-breakpoint
ALTER TABLE "judgement" ADD COLUMN "covered_by_id" uuid;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgement" ADD CONSTRAINT "judgement_covered_by_id_judgement_id_fk" FOREIGN KEY ("covered_by_id") REFERENCES "public"."judgement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "judgement_covered_by_idx" ON "judgement" USING btree ("covered_by_id");--> statement-breakpoint
ALTER TABLE "judgement" ADD CONSTRAINT "judgement_change_of_mind_explained" CHECK ("judgement"."supersedes_id" is null or coalesce(trim("judgement"."reason"), '') <> '');--> statement-breakpoint
ALTER TABLE "judgement" ADD CONSTRAINT "judgement_covered_outside_batch" CHECK ("judgement"."covered_by_id" is null or "judgement"."batch_id" is null);