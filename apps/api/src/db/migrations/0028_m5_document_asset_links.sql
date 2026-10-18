CREATE TABLE "document_asset_links" (
	"document_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	CONSTRAINT "document_asset_links_pkey" PRIMARY KEY("document_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "document_asset_links" ADD CONSTRAINT "document_asset_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_asset_links" ADD CONSTRAINT "document_asset_links_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_asset_links_asset_idx" ON "document_asset_links" USING btree ("asset_id");