ALTER TABLE properties ADD COLUMN inspection_report_email TEXT NOT NULL DEFAULT '';
UPDATE properties SET inspection_report_email=COALESCE((SELECT report_email FROM inspections WHERE property_id=properties.id ORDER BY created_at DESC,id DESC LIMIT 1),'');
