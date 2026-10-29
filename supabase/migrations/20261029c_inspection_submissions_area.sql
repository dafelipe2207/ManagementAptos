-- Move-in/move-out photos are now organised by area (bedroom, bathroom, kitchen, dining/common)
-- instead of one big pile per tenant — see INSPECTION_AREAS in app.js. Older rows keep area=null
-- and still show (grouped as "General").
alter table public.inspection_submissions add column if not exists area text;
comment on column public.inspection_submissions.area is 'Which part of the room/apartment these photos are of: bedroom | bathroom | kitchen | common | null (older rows, uncategorised).';
