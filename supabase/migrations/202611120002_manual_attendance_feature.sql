-- Allow each store to enable or disable Manual Attendance independently from
-- device-based attendance, timesheets, and overtime.
begin;

alter table public.crm_stores
  drop constraint if exists crm_stores_features_shape;

update public.crm_stores
set features = jsonb_build_object(
  'dashboard', coalesce((features->>'dashboard')::boolean, true),
  'customers', coalesce((features->>'customers')::boolean, true),
  'sales', coalesce((features->>'sales')::boolean, true),
  'attendance', coalesce((features->>'attendance')::boolean, true),
  'manual_attendance', coalesce((features->>'manual_attendance')::boolean, true),
  'callbacks', coalesce((features->>'callbacks')::boolean, true),
  'reminders', coalesce((features->>'reminders')::boolean, true),
  'reports', coalesce((features->>'reports')::boolean, true),
  'tasks', coalesce((features->>'tasks')::boolean, true),
  'task_images', coalesce((features->>'task_images')::boolean, true)
);

alter table public.crm_stores
  alter column features set default '{"dashboard":true,"customers":true,"sales":true,"attendance":true,"manual_attendance":true,"callbacks":true,"reminders":true,"reports":true,"tasks":true,"task_images":true}'::jsonb;

alter table public.crm_stores
  add constraint crm_stores_features_shape check (
    jsonb_typeof(features) = 'object'
    and features ?& array['dashboard','customers','sales','attendance','manual_attendance','callbacks','reminders','reports','tasks','task_images']
    and (features - array['dashboard','customers','sales','attendance','manual_attendance','callbacks','reminders','reports','tasks','task_images']) = '{}'::jsonb
    and jsonb_typeof(features->'dashboard') = 'boolean'
    and jsonb_typeof(features->'customers') = 'boolean'
    and jsonb_typeof(features->'sales') = 'boolean'
    and jsonb_typeof(features->'attendance') = 'boolean'
    and jsonb_typeof(features->'manual_attendance') = 'boolean'
    and jsonb_typeof(features->'callbacks') = 'boolean'
    and jsonb_typeof(features->'reminders') = 'boolean'
    and jsonb_typeof(features->'reports') = 'boolean'
    and jsonb_typeof(features->'tasks') = 'boolean'
    and jsonb_typeof(features->'task_images') = 'boolean'
  );

notify pgrst, 'reload schema';

commit;
