-- Wi-Fi details per property (network name + password), shown to that property's tenants.
alter table public.properties add column if not exists wifi_ssid text;
alter table public.properties add column if not exists wifi_password text;
alter table public.properties add column if not exists wifi_notes text;
