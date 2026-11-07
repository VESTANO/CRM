-- Unmapped biometric punches do not belong to a store yet. Retain the
-- existing can_view_store_member decision (Super Admin only for NULL users)
-- so store feature checks do not hide records awaiting employee mapping.
drop policy if exists attendance_read_store_allowed on public.attendance_records;
create policy attendance_read_store_allowed on public.attendance_records for select to authenticated
  using(public.current_user_role() is not null and public.can_view_store_member(user_id)
    and (user_id is null or public.store_feature_enabled_for_user(user_id, 'attendance')));

notify pgrst, 'reload schema';
