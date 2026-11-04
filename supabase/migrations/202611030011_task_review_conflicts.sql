-- A stale draft/review is a business conflict, not a retryable PostgreSQL
-- serialization failure. Avoid automatic database-client retries of decisions
-- that must be refreshed by the person submitting them.
do $$
declare signature regprocedure; definition text;
begin
  foreach signature in array array[
    'public.crm_save_task_photos(bigint,uuid,text,jsonb,jsonb)'::regprocedure,
    'public.crm_review_task_submission(bigint,bigint,uuid,text,text)'::regprocedure
  ] loop
    definition := pg_get_functiondef(signature);
    execute replace(definition, '''40001''', '''P0001''');
  end loop;
end $$;
