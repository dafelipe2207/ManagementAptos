-- Follow-up status for each agency email case (Correos page).
alter table public.agency_email_cases
  add column if not exists status text not null default 'pendiente_revisar'
    check (status in ('pendiente_revisar','revisado','ot_creada','enviado_rs','esperando_respuesta','visita_programada','pendiente_pago','resuelto','sin_accion')),
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_by_profile_id uuid references public.profiles(id) on delete set null;

-- Receipts / informative emails need no follow-up.
update public.agency_email_cases set status = 'sin_accion' where kind = 'receipt' and status = 'pendiente_revisar';
