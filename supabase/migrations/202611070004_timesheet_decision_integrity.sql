begin;
-- A decision is final for this submission. Rejected entries can be edited by
-- their owner through update_timesheet_entry, which resubmits them for review.
create or replace function public.review_timesheet_entry(p_id uuid,p_approval_status text,p_approval_comment text)
returns public.timesheet_entries language plpgsql security definer set search_path=public,pg_temp as $$
declare reviewer public.profiles; result public.timesheet_entries;
begin
  select * into reviewer from public.profiles where id=auth.uid() and active and role in ('super_admin','admin');
  if reviewer.id is null then raise exception 'Only admins can approve entries.' using errcode='42501'; end if;
  if p_approval_status is null or p_approval_status not in ('Approved','Rejected') then
    raise exception 'Choose Approved or Rejected.' using errcode='22023';
  end if;
  if p_approval_status='Rejected' and trim(coalesce(p_approval_comment,''))='' then
    raise exception 'Rejection feedback is required.' using errcode='22023';
  end if;
  select * into result from public.timesheet_entries where id=p_id and public.can_view_store_member(user_id) for update;
  if result.id is null then raise exception 'Timesheet entry not found in your store.' using errcode='P0002'; end if;
  if result.approval_status<>'Submitted' then
    raise exception 'This timesheet submission has already been reviewed. Refresh the approval queue.' using errcode='P0001';
  end if;
  update public.timesheet_entries set approval_status=p_approval_status,
    approval_comment=trim(coalesce(p_approval_comment,'')),approved_by=reviewer.name,approved_at=now()
  where id=p_id returning * into result;
  return result;
end $$;
revoke all on function public.review_timesheet_entry(uuid,text,text) from public,anon;
grant execute on function public.review_timesheet_entry(uuid,text,text) to authenticated,service_role;
notify pgrst,'reload schema';
commit;
