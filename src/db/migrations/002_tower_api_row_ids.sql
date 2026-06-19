ALTER TABLE users ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tower_api_id ON users(id);

ALTER TABLE login_challenges ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_login_challenges_tower_api_id ON login_challenges(id);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_tower_api_id ON sessions(id);

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_tower_api_id ON app_settings(id);

ALTER TABLE access_rules ADD COLUMN IF NOT EXISTS id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_rules_tower_api_id ON access_rules(id);
