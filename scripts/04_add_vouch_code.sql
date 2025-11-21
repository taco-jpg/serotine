-- Add vouch_code to devices table
alter table public.devices 
add column if not exists vouch_code text;

-- Add index for faster lookups
create index if not exists devices_vouch_code_idx on public.devices(vouch_code);
