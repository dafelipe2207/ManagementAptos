import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a TENANT view the original invoice document (photo/PDF) of a bill they're allocated to.
// The `receipts` storage bucket is private and its RLS only lets someone read files under their
// OWN auth uid folder — but a bill's document is uploaded under the STAFF member's uid, not the
// tenant's, so a tenant can never satisfy that policy directly. This Edge Function checks (with
// the service role key) that the caller really is allocated a share of that specific bill, then
// hands back a short-lived signed URL for its document — without changing the storage RLS at
// all, so staff-to-staff access and the tenant's own uploaded documents are unaffected.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) return json({ error: "Missing Authorization header." }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } }
  });
  const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerData?.user) return json({ error: "Not signed in." }, 401);

  let body: { billId?: string };
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "Invalid request body." }, 400);
  }
  const billId = body.billId || "";
  if (!billId) return json({ error: "Missing billId." }, 400);

  // Staff can already read any receipt through the storage RLS directly, so this only needs to
  // handle the tenant case — but check both, in case a staff member's own client calls it too.
  const { data: callerProfile } = await admin
    .from("profiles").select("role, is_active").eq("auth_user_id", callerData.user.id).maybeSingle();
  const isStaff = !!callerProfile && (callerProfile.role === "super_admin" || callerProfile.role === "administrator") && callerProfile.is_active;

  if (!isStaff) {
    const { data: tenantRow } = await admin
      .from("tenants").select("id").eq("auth_user_id", callerData.user.id).maybeSingle();
    if (!tenantRow) return json({ error: "No tenant record linked to your account." }, 403);

    const { data: allocRow } = await admin
      .from("bill_allocations").select("id").eq("bill_id", billId).eq("tenant_id", tenantRow.id).maybeSingle();
    if (!allocRow) return json({ error: "You don't have a share of this bill." }, 403);
  }

  const { data: bill, error: billErr } = await admin
    .from("bills").select("receipt_path").eq("id", billId).maybeSingle();
  if (billErr || !bill) return json({ error: "That bill was not found." }, 400);
  if (!bill.receipt_path) return json({ error: "No document is attached to this bill." }, 404);

  const { data: signed, error: signErr } = await admin.storage.from("receipts").createSignedUrl(bill.receipt_path, 300);
  if (signErr || !signed) {
    console.error("tenant-bill-receipt: could not sign URL:", signErr);
    return json({ error: "Could not open the document right now." }, 500);
  }

  return json({ url: signed.signedUrl });
});
