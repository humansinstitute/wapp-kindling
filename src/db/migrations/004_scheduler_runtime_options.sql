ALTER TABLE scheduler_settings ADD COLUMN alerts_enabled integer NOT NULL DEFAULT 0;
ALTER TABLE scheduler_settings ADD COLUMN agents_json text NOT NULL DEFAULT '{}';
ALTER TABLE scheduler_settings ADD COLUMN models_json text NOT NULL DEFAULT '{}';
