-- A tenant may open any receipt attached to THEIR OWN payments, even when the admin uploaded it.
create or replace function public.tenant_can_read_receipt(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.payments where receipt_path = p_name and tenant_id = public.current_tenant_id()
    union all select 1 from public.bill_allocations where receipt_path = p_name and tenant_id = public.current_tenant_id()
    union all select 1 from public.payment_reports where proof_path = p_name and tenant_id = public.current_tenant_id()
    union all select 1 from public.rent_payment_reports where proof_path = p_name and tenant_id = public.current_tenant_id()
  );
$$;
revoke all on function public.tenant_can_read_receipt(text) from public;
grant execute on function public.tenant_can_read_receipt(text) to authenticated;
drop policy if exists tenant_read_own_payment_receipts on storage.objects;
create policy tenant_read_own_payment_receipts on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.tenant_can_read_receipt(name));
