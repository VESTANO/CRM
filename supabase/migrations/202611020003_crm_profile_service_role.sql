-- The CRM Edge Function creates and reads CRM profiles during legacy imports
-- and password-based authentication. Keep these grants limited to service_role.
grant select, insert, update on public.profiles to service_role;
