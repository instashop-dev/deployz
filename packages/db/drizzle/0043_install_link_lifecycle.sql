ALTER TABLE deployments ADD COLUMN install_link_expires_at timestamp with time zone, ADD COLUMN install_link_revoked_at timestamp with time zone;
