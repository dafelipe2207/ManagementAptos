-- house_rules / real_estate_inspections: the "write" policies were FOR ALL, which also covers
-- SELECT and overlapped the separate *_select policies. Same access as before, just one policy
-- per action so each rule reads clearly: staff of the property can insert/update/delete,
-- reading stays with *_select (staff + the property's tenants).

drop policy if exists house_rules_write on public.house_rules;
create policy house_rules_insert on public.house_rules for insert with check (public.can_manage_property(property_id));
create policy house_rules_update on public.house_rules for update using (public.can_manage_property(property_id)) with check (public.can_manage_property(property_id));
create policy house_rules_delete on public.house_rules for delete using (public.can_manage_property(property_id));

drop policy if exists rei_write on public.real_estate_inspections;
create policy rei_insert on public.real_estate_inspections for insert with check (public.can_manage_property(property_id));
create policy rei_update on public.real_estate_inspections for update using (public.can_manage_property(property_id)) with check (public.can_manage_property(property_id));
create policy rei_delete on public.real_estate_inspections for delete using (public.can_manage_property(property_id));
