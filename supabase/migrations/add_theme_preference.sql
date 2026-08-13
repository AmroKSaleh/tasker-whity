-- Theme preference: 'light' | 'dark' | 'system'
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS theme_preference text DEFAULT 'system';