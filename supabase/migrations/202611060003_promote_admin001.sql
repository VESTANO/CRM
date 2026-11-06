-- Normalize the bootstrap identity before promotion. Legacy imports can retain
-- whitespace or mixed case in employee IDs.
update public.profiles
set role = 'super_admin'
where upper(trim(employee_id)) = 'ADMIN001';
