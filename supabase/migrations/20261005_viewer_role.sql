-- Read-only "Viewer" role.
-- A viewer is assigned properties exactly like an Administrator (property_administrators) and can
-- READ everything for those properties — and nothing else. Only SELECT policies are added: every
-- write policy already requires a super admin, an assigned *administrator* (can_manage_property),
-- is_staff(), or the tenant's own row, and none of those match a viewer, so writes stay refused.
-- Deliberately not readable by a viewer: profiles (holds users' passwords), audit_logs (Super
-- Admin only) and staff notifications.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['super_admin'::text, 'administrator'::text, 'tenant'::text, 'viewer'::text]));

create or replace function public.is_viewer()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.current_profile_role() = 'viewer', false);
$$;

-- True when the signed-in user is a viewer assigned to this property.
create or replace function public.viewer_can_see_property(prop_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.is_viewer() and public.is_admin_assigned(prop_id), false);
$$;

create or replace function public.viewer_can_see_linked_row(p_table text, p_id uuid)
returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare v_property_id uuid;
begin
  if not public.is_viewer() then return false; end if;
  if p_table = 'cleaning_tasks' then select property_id into v_property_id from cleaning_tasks where id = p_id;
  elsif p_table = 'maintenance_requests' then select property_id into v_property_id from maintenance_requests where id = p_id;
  elsif p_table = 'bin_out_tasks' then select property_id into v_property_id from bin_out_tasks where id = p_id;
  elsif p_table = 'inspection_submissions' then select property_id into v_property_id from inspection_submissions where id = p_id;
  elsif p_table = 'tenant_documents' then
    select t.property_id into v_property_id from tenant_documents d join tenants t on t.id = d.tenant_id where d.id = p_id;
  else return false;
  end if;
  return v_property_id is not null and public.is_admin_assigned(v_property_id);
end;
$$;

do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
    -- tables with their own property_id
    ('activity_log', 'property_id'), ('bills', 'property_id'), ('bin_duties', 'property_id'),
    ('bin_out_tasks', 'property_id'), ('cleaning_comments', 'property_id'), ('cleaning_submissions', 'property_id'),
    ('cleaning_tasks', 'property_id'), ('house_rules', 'property_id'), ('inspection_comments', 'property_id'),
    ('inspection_submissions', 'property_id'), ('lease_payments', 'property_id'), ('maintenance_log', 'property_id'),
    ('maintenance_requests', 'property_id'), ('real_estate_inspections', 'property_id'), ('recurring_bills', 'property_id'),
    ('rent_payment_reports', 'property_id'), ('rooms', 'property_id'), ('task_index', 'property_id'),
    ('tenants', 'property_id'), ('trash_schedule', 'property_id'), ('weekly_duties', 'property_id'),
    ('properties', 'id'),
    -- tables linked through the tenant
    ('bonds', 'property_of_tenant(tenant_id)'), ('payments', 'property_of_tenant(tenant_id)'),
    ('rent_schedules', 'property_of_tenant(tenant_id)'), ('tenant_documents', 'property_of_tenant(tenant_id)'),
    ('move_out_settlements', 'property_of_tenant(tenant_id)'),
    -- tables linked through the bill / room
    ('bill_allocations', 'property_of_bill(bill_id)'), ('payment_reports', 'property_of_bill(bill_id)'),
    ('room_included_bills', '(select rooms.property_id from rooms where rooms.id = room_included_bills.room_id)')
  ) as v(tbl, prop)
  loop
    expr := format('public.viewer_can_see_property(%s)', r.prop);
    execute format('drop policy if exists "Viewer can read" on public.%I', r.tbl);
    execute format('create policy "Viewer can read" on public.%I for select to authenticated using (%s)', r.tbl, expr);
  end loop;
end $$;

drop policy if exists "Viewer can read" on public.entity_links;
create policy "Viewer can read" on public.entity_links for select to authenticated
  using (public.viewer_can_see_linked_row(from_table, from_id));

-- Files (photos, receipts, documents): readable by a viewer. Their paths are only reachable from
-- rows the viewer can already see, which are limited to their assigned properties.
drop policy if exists "Viewer can read files" on storage.objects;
create policy "Viewer can read files" on storage.objects for select to authenticated
  using (public.is_viewer() and bucket_id in ('inspection-photos','cleaning-photos','move-out-evidence',
    'maintenance-photos','documents','receipts','bin-out-evidence','house-rules'));
