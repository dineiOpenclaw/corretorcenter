ALTER TABLE funcionarios
  ADD COLUMN IF NOT EXISTS login_password_hash text,
  ADD COLUMN IF NOT EXISTS login_reset_required boolean NOT NULL DEFAULT true;
