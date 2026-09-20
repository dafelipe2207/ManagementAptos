// services/migrationService.js
// One-time migration: reads the OLD Belmont Manager localStorage keys (from
// artifact/index.html's scheme) and inserts them into Supabase, in
// dependency order, building an old-string-id -> new-uuid map as it goes so
// every foreign key is rewired correctly. Does NOT clear localStorage
// afterwards (kept as a safety-net backup). Best-effort: if one row fails,
// its descendants are skipped and reported, but everything already
// successfully inserted is left in place and reported as done.

import * as propertyService from './propertyService.js';
import * as roomService from './roomService.js';
import * as tenantService from './tenantService.js';
import * as bondService from './bondService.js';
import * as rentScheduleService from './rentScheduleService.js';
import * as paymentService from './paymentService.js';
import * as billService from './billService.js';
import * as billAllocationService from './billAllocationService.js';

const KEYS = {
  properties: 'belmont-manager-properties-v1',
  rooms: 'belmont-manager-rooms-v1',
  tenants: 'belmont-manager-tenants-v1',
  bonds: 'belmont-manager-bonds-v1',
  rentSchedules: 'belmont-manager-rentschedules-v1',
  payments: 'belmont-manager-payments-v1',
  bills: 'belmont-manager-bills-v1'
};

function readOldArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** True if there is any old-format data in this browser worth migrating. */
export function hasLocalData() {
  return Object.values(KEYS).some(function (key) {
    try {
      const raw = localStorage.getItem(key);
      return !!raw && raw !== '[]';
    } catch (e) {
      return false;
    }
  });
}

export async function migrate() {
  const oldProperties = readOldArray(KEYS.properties);
  const oldRooms = readOldArray(KEYS.rooms);
  const oldTenants = readOldArray(KEYS.tenants);
  const oldBonds = readOldArray(KEYS.bonds);
  const oldRentSchedules = readOldArray(KEYS.rentSchedules);
  const oldPayments = readOldArray(KEYS.payments);
  const oldBills = readOldArray(KEYS.bills);

  const propIdMap = {};
  const roomIdMap = {};
  const tenantIdMap = {};
  const billIdMap = {};

  const counts = { properties: 0, rooms: 0, tenants: 0, bonds: 0, rentSchedules: 0, payments: 0, bills: 0, allocations: 0 };
  const failures = [];

  for (const oldProp of oldProperties) {
    let newProp;
    try {
      newProp = await propertyService.create({
        name: oldProp.name, address: oldProp.address, bedrooms: oldProp.bedrooms,
        bathrooms: oldProp.bathrooms, notes: oldProp.notes || ''
      });
      propIdMap[oldProp.id] = newProp.id;
      counts.properties++;
    } catch (err) {
      failures.push({ entity: 'property', oldId: oldProp.id, reason: err.message || String(err) });
      continue; // nothing under this property can be safely inserted
    }

    const propRooms = oldRooms.filter(function (r) { return r.propertyId === oldProp.id; });
    for (const oldRoom of propRooms) {
      try {
        const newRoom = await roomService.create({ propertyId: newProp.id, name: oldRoom.name });
        roomIdMap[oldRoom.id] = newRoom.id;
        counts.rooms++;
      } catch (err) {
        failures.push({ entity: 'room', oldId: oldRoom.id, reason: err.message || String(err) });
      }
    }

    const propTenants = oldTenants.filter(function (t) { return t.propertyId === oldProp.id; });
    for (const oldTenant of propTenants) {
      const newRoomId = roomIdMap[oldTenant.roomId];
      if (oldTenant.roomId && !newRoomId) {
        failures.push({ entity: 'tenant', oldId: oldTenant.id, reason: "Skipped: this tenant's room failed to migrate." });
        continue;
      }
      let newTenant;
      try {
        newTenant = await tenantService.create({
          fullName: oldTenant.fullName, phone: oldTenant.phone, email: oldTenant.email,
          propertyId: newProp.id, roomId: newRoomId || null,
          moveInDate: oldTenant.moveInDate, expectedMoveOutDate: oldTenant.expectedMoveOutDate,
          actualMoveOutDate: oldTenant.actualMoveOutDate, rentAmount: oldTenant.rentAmount || 0,
          rentFrequency: oldTenant.rentFrequency || 'weekly', paymentDay: oldTenant.paymentDay || 1,
          notes: oldTenant.notes
        });
        tenantIdMap[oldTenant.id] = newTenant.id;
        counts.tenants++;
      } catch (err) {
        failures.push({ entity: 'tenant', oldId: oldTenant.id, reason: err.message || String(err) });
        continue;
      }

      const oldBond = oldBonds.find(function (b) { return b.tenantId === oldTenant.id; });
      if (oldBond) {
        try {
          await bondService.create({
            tenantId: newTenant.id, amountRequired: oldBond.amountRequired, amountPaid: oldBond.amountPaid,
            amountReturned: oldBond.amountReturned, deduction: oldBond.deduction, status: oldBond.status
          });
          counts.bonds++;
        } catch (err) {
          failures.push({ entity: 'bond', oldId: oldBond.id, reason: err.message || String(err) });
        }
      }

      const oldSchedule = oldRentSchedules.find(function (s) { return s.tenantId === oldTenant.id; });
      if (oldSchedule) {
        try {
          await rentScheduleService.create({ tenantId: newTenant.id, frequency: oldSchedule.frequency, amount: oldSchedule.amount, startDate: oldSchedule.startDate });
          counts.rentSchedules++;
        } catch (err) {
          failures.push({ entity: 'rentSchedule', oldId: oldTenant.id, reason: err.message || String(err) });
        }
      }

      const tenantPayments = oldPayments.filter(function (p) { return p.tenantId === oldTenant.id; });
      for (const oldPayment of tenantPayments) {
        try {
          await paymentService.create({ tenantId: newTenant.id, amount: oldPayment.amount, date: oldPayment.date });
          counts.payments++;
        } catch (err) {
          failures.push({ entity: 'payment', oldId: oldPayment.id, reason: err.message || String(err) });
        }
      }
    }
  }

  for (const oldBill of oldBills) {
    const newPropertyId = propIdMap[oldBill.propertyId];
    if (!newPropertyId) {
      failures.push({ entity: 'bill', oldId: oldBill.id, reason: "Skipped: this bill's property failed to migrate." });
      continue;
    }
    let newBill;
    try {
      newBill = await billService.create({
        propertyId: newPropertyId, billType: oldBill.billType, provider: oldBill.provider,
        invoiceNumber: oldBill.invoiceNumber, issueDate: oldBill.issueDate, dueDate: oldBill.dueDate,
        billingPeriodStart: oldBill.billingPeriodStart, billingPeriodEnd: oldBill.billingPeriodEnd,
        amount: oldBill.amount, status: oldBill.status, allocationMethod: oldBill.allocationMethod, notes: oldBill.notes
      });
      billIdMap[oldBill.id] = newBill.id;
      counts.bills++;
    } catch (err) {
      failures.push({ entity: 'bill', oldId: oldBill.id, reason: err.message || String(err) });
      continue;
    }

    if (Array.isArray(oldBill.allocations) && oldBill.allocations.length) {
      const rows = [];
      for (const alloc of oldBill.allocations) {
        const newTenantId = tenantIdMap[alloc.tenantId];
        if (!newTenantId) {
          failures.push({ entity: 'bill_allocation', oldId: oldBill.id + '/' + alloc.tenantId, reason: "Skipped: this allocation's tenant failed to migrate." });
          continue;
        }
        rows.push({ tenantId: newTenantId, amount: alloc.amount, paid: alloc.paid, paidDate: alloc.paidDate });
      }
      if (rows.length) {
        try {
          await billAllocationService.replaceForBill(newBill.id, rows);
          counts.allocations += rows.length;
        } catch (err) {
          failures.push({ entity: 'bill_allocation', oldId: oldBill.id, reason: err.message || String(err) });
        }
      }
    }
  }

  return { counts, failures, success: failures.length === 0 };
}
