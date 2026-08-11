---
id: TDE-95
title: Login Issue
status: done
priority: medium
section: bugs
order: 13
updated_at: 2026-08-01T09:35:21.807Z
---

## Problem
Users who signed up with Google/GitHub OAuth couldn't sign in with email/password using the same email address. Supabase returns "Invalid login credentials" for both wrong passwords AND OAuth-only accounts (no password set), making it impossible to distinguish.

## Key Question & Answer
**Q: When the user resets their password, will they be able to use both OAuth and email/password login, or will that break things?**
**A: Yes, both work together.** Supabase links multiple auth methods to a single user account by email. Setting a password via reset enables email/password login while OAuth continues working on the same account.

## Root Cause
Supabase doesn't provide a way to distinguish between "wrong password" and "no password set" from the client side. The API returns the same error for both cases.

## Solution Implemented
Instead of trying to detect the error type, offer password reset in two scenarios:

1. **Signup with duplicate email** - Detect when Supabase returns "already registered" error and suggest password reset
2. **Signin with OAuth-only account** - When "Invalid login credentials" is returned, offer password reset as a solution

Both flows now:
- Show a clear error message explaining the situation
- Offer a "Send password reset link" button
- Let the user set a password and use both auth methods going forward

## Testing Approach
1. Sign up with Google
2. Try to sign in with email/password (should show error + reset button)
3. Click "Send password reset link"
4. Check email for reset link, set password
5. Sign in with email/password (should work)
6. Sign out and try Google OAuth (should still work)
7. Confirm both methods work on the same account

## Files Changed
- LoginPage.jsx: Enhanced signup error handling + password reset button visibility in both tabs
