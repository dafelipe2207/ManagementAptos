-- Staff can cancel (delete) a move-out settlement that hasn't been approved yet.
-- Completed (approved) settlements stay — they're the record of what happened to the bond.
create policy move_out_settlements_staff_delete on public.move_out_settlements
  for delete using (status <> 'completed' and locked_at is null and can_manage_property(property_of_tenant(tenant_id)));
