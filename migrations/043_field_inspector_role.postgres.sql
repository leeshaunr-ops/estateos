-- Field inspector logins (Oct 2026): allow role 'inspector'. Drops whichever CHECK constraint limits users.role (named
-- users_role_check by default) and adds the widened one.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%role%' LOOP
  EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
 END LOOP;
END $$;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','employee','client','vendor','inspector'));
