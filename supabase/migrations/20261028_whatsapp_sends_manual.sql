-- "Already charged" on a bill: logged as kind 'manual' (charged outside the app's WhatsApp sends).
alter table public.whatsapp_sends drop constraint if exists whatsapp_sends_kind_check;
alter table public.whatsapp_sends add constraint whatsapp_sends_kind_check check (kind in ('tenant','group','manual'));
