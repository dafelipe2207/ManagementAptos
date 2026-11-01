-- Room items checklist: what the room comes with (bed, bedside tables, mattress, pillows, blankets,
-- sheets, mattress protector…) and, per tenant, which of those were handed over and which came back.
--   rooms.items              [{ id, name, qty }]  — set by staff in Properties → Edit room.
--   tenants.room_items_check { "<item id>": { "d": "YYYY-MM-DD"|null, "r": "YYYY-MM-DD"|null } }
--                            d = date it was delivered, r = date it was returned. Staff write it;
--                            the tenant only reads their own row (existing RLS), so they can see it.
alter table public.rooms add column if not exists items jsonb not null default '[]'::jsonb;
alter table public.tenants add column if not exists room_items_check jsonb not null default '{}'::jsonb;
