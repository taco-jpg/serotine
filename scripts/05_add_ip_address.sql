-- Add IP address column to devices table
alter table public.devices add column if not exists ip_address text;

-- Add index for faster IP lookups
create index if not exists idx_devices_ip_address on public.devices(ip_address);
