ALTER TABLE company_segments ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_segments_tower_api_id ON company_segments(id);

ALTER TABLE pipeline_roles ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_roles_tower_api_id ON pipeline_roles(id);

ALTER TABLE scheduler_locks ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduler_locks_tower_api_id ON scheduler_locks(id);
