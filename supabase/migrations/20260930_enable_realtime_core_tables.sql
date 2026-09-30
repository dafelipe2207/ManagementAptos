-- Instant cross-device sync: the app subscribes to changes on these tables (see
-- setupRealtimeSync in app.js). RLS still applies to what each user receives.
alter publication supabase_realtime add table
  public.bills, public.bill_allocations, public.payments, public.payment_reports,
  public.rent_payment_reports, public.rent_schedules, public.tenants, public.bonds,
  public.maintenance_requests, public.move_out_settlements, public.rooms, public.properties,
  public.recurring_bills;
