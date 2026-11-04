alter table public.crm_task_images
  add column thumbnail_path text unique,
  add column byte_size integer check (byte_size between 1 and 262144),
  add column thumbnail_byte_size integer check (thumbnail_byte_size between 1 and 20480),
  add column width integer check (width between 1 and 1280),
  add column height integer check (height between 1 and 1280);
alter table public.crm_visit_images
  add column thumbnail_path text unique,
  add column byte_size integer check (byte_size between 1 and 262144),
  add column thumbnail_byte_size integer check (thumbnail_byte_size between 1 and 20480),
  add column width integer check (width between 1 and 1280),
  add column height integer check (height between 1 and 1280);

-- Keep the existing assignment/review transaction and its permission checks;
-- extend only the attachment INSERT to store the optimized photo metadata.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.crm_save_task_photos(bigint,uuid,text,jsonb,jsonb)'::regprocedure);
  if position('original_name, submission_id)' in definition)=0 then raise exception 'Unexpected task photo function version'; end if;
  definition := replace(definition,'original_name, submission_id)',
    'original_name, submission_id, thumbnail_path, byte_size, thumbnail_byte_size, width, height)');
  definition := replace(definition,'image->>''original_name'', submission_id);',
    'image->>''original_name'', submission_id, nullif(image->>''thumbnail_path'', ''''), (image->>''byte_size'')::integer, (image->>''thumbnail_byte_size'')::integer, (image->>''width'')::integer, (image->>''height'')::integer);');
  execute definition;
end $$;

-- Original files are compressed in the browser. Enforce the resulting upload
-- budget in Storage too, including callers that bypass the normal photo form.
update storage.buckets set file_size_limit=262144 where id in ('crm-task-images','crm-visit-images');
