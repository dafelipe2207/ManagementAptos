Deployed Edge Function `login-by-reference` (verify_jwt: false). Lets a tenant sign in with their
payment reference (tenants.payment_reference, e.g. NOE105) + password. Looks up the tenant's auth
user server-side, checks the password with signInWithPassword, and returns only a session. Every
failure returns the same generic "Invalid login credentials". Client side: lib/auth.js
signInWithReference().
