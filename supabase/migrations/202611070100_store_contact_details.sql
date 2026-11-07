-- Keep existing stores intact; contact fields apply to newly created stores.
alter table public.crm_stores
  add column if not exists contact_person text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists address_line1 text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text;

alter table public.crm_stores
  add constraint crm_stores_contact_person_length check (contact_person is null or char_length(contact_person) between 1 and 120),
  add constraint crm_stores_contact_email_length check (contact_email is null or char_length(contact_email) between 3 and 254),
  add constraint crm_stores_contact_phone_length check (contact_phone is null or char_length(contact_phone) between 7 and 20),
  add constraint crm_stores_address_line1_length check (address_line1 is null or char_length(address_line1) between 1 and 240),
  add constraint crm_stores_city_length check (city is null or char_length(city) between 1 and 100),
  add constraint crm_stores_state_length check (state is null or char_length(state) between 1 and 100),
  add constraint crm_stores_postal_code_length check (postal_code is null or char_length(postal_code) between 1 and 20);
