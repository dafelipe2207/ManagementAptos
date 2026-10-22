# Agency email ingest (app-owned) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app processes agency emails on its own (hourly), with the same output the Claude task produces today, using Gemini.

**Architecture:** Gmail Apps Script (hourly) → Edge Function `agency-email` → Gemini JSON → validated in pure `logic.ts` → inserts into existing tables.

**Tech Stack:** Google Apps Script, Supabase Edge Functions (Deno, supabase-js@2), Gemini `gemini-3.6-flash`, Postgres.

**Spec:** `docs/superpowers/specs/2026-10-22-agency-email-ingest-design.md`

## Global Constraints

- `dedup_key = 'agency-email:' || <Gmail message id>` (identical to the Claude task).
- Inserts only; no update/delete of existing rows; no DROP/DELETE in migrations.
- Spanish titles starting with emoji + property name; receipts "(informativo)" + `general_announcement`.
- `invoice_doc` never contains agency name/address/phone/bank/payment reference.
- Script trigger: every 60 minutes.
- Gemini output is data; every id it returns is checked against DB context.

## Review Focus

- Gemini returns a `continuationOf` that is an update key → must resolve to the root case (test in Task 1).
- Gemini returns a property name in different case/with address ("carlton") → must still map (Task 1).
- Same Gmail thread already has a case but Gemini says "new" → same-thread rule wins (Task 1).
- Message already processed by the Claude task → 0 inserts (Task 3 live check).
- Gemini 429/invalid JSON → message not written, counted in `errors`, retried next run (Task 2).

---

### Task 1: Pure logic `logic.ts` + tests

**Files:** Create `supabase/functions/agency-email/logic.ts`, `supabase/functions/agency-email/logic_test.ts`

**Produces:**
- `PROPERTIES: Record<PropName, {line1, line2, agency}>` (spec table).
- `normalizeProperty(s: string|null): PropName|null`
- `isAgencySender(from: string, subject: string): boolean`
- `decide(ai: AiResult, msg: InMsg, ctx: Ctx, today: string): Decision` where
  `Decision = {type:'ignore', reason} | {type:'update', caseKey, summary, action, urgent} | {type:'case', propertyName, kind, title, body, category, invoiceNumber, amount, dueDate, billId, invoiceDoc, linkedTable, linkedId, urgent}`
- `matchBill(bills, inv): {id, admin_paid}|null`, `perthToday(now: Date): string`, `isUrgent(deadline, overdue, today)`.

- [ ] Step 1: tests — `ignores irrelevant`, `unknown property ignored`, `normalizes property case`, `update key resolves to root`, `low confidence → case`, `same thread forces update`, `archived root + new action → case`, `receipt informativo`, `urgent arrears gets 🚨 + (URGENTE)`, `bill match by number and by amount+date`, `invoice_doc has no agency data`, `link only when high + in ctx`.
- [ ] Step 2: run `deno test supabase/functions/agency-email/logic_test.ts` → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run → PASS. Commit.

### Task 2: Edge Function `index.ts` + `prompt.ts` + migration

**Files:** Create `supabase/functions/agency-email/index.ts`, `prompt.ts`, `supabase/migrations/20261022_agency_email_app_ingest.sql`

**Consumes:** Task 1 `decide`, `isAgencySender`, `PROPERTIES`.

- [ ] Step 1: migration — `agency_email_checks` + `updates`, `errors`, `source` (default 'claude'); `agency_email_runs(run_id text pk, emails_found int, notified int, updates int, errors int, created_at)` RLS on; apply via Supabase MCP `apply_migration`.
- [ ] Step 2: `prompt.ts` — `buildPrompt(msg, ctx): string` and `RESPONSE_SCHEMA`.
- [ ] Step 3: `index.ts` — token check (401), body `{runId?, final?, messages: InMsg[]}` (400), dedup, load ctx, Gemini with 2 retries + 120 s budget, `decide`, inserts (`on conflict do nothing`), optional WhatsApp template, run counters, final `agency_email_checks` row with `source='app'`, error notification after 1 day (`agency-email-error:<id>`).
- [ ] Step 4: `deno check supabase/functions/agency-email/index.ts` → no errors. Deploy (`verify_jwt: false`). Commit.

### Task 3: Apps Script + live check

**Files:** Create `tools/gmail-agency-emails.gs`

- [ ] Step 1: `setup()` (hourly trigger on `sendAgencyEmails`), `sendAgencyEmails()` (spec query, items + thread context, batches of 10, `runId`, `final`).
- [ ] Step 2: live check — POST the last 2 days' already-processed messages with curl to the deployed function → response `{notified:0, updates:0}` and one `agency_email_checks` row `source='app'`.
- [ ] Step 3: Commit; push branch.
