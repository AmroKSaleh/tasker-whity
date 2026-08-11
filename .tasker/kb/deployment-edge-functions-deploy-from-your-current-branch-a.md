# Deployment: edge functions deploy from your CURRENT BRANCH — a second branch can silently undo the first

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Edge-function deploys are branch-shaped. The database is not.

Learned the hard way on 2026-08-07 while shipping TDE-882 and TDE-822 back to back.

## What happened

1. Fixed TDE-882 on its own branch (off `main`), deployed `mcp`, verified live. Correct.
2. Branched TDE-822 off **`main`** — which does not contain the TDE-882 fix.
3. Deployed `mcp` again from the TDE-822 branch.
4. **The TDE-882 fix silently disappeared from production.** Section counts went straight back to being wrong. Nothing errored; the deploy just shipped an older version of the same file.

`supabase functions deploy` uploads whatever is in your working tree. It has no concept of branches, no merge, no warning that you are shipping a file older than what is already live.

## The rule

**Two unmerged branches that touch the same edge function cannot both be deployed.** The last deploy wins outright and reverts the other.

If you must ship two features before either merges, **stack them**: branch the second off the first, or rebase it on top, so the deployed tree contains both.

```
git rebase <first-branch>     # from the second branch
```

Then redeploy and **re-verify the FIRST feature**, not just the one you were working on.

## Migrations make this worse, asymmetrically

The remote database is shared across all branches, and migrations are **not** reverted when you switch. So after step 2 above, `supabase db push` failed with:

> Remote migration versions not found in local migrations directory.

Because the remote had already applied TDE-882's migration while the TDE-822 branch had no such file. Do **not** reach for `supabase migration repair --status reverted` here — that lies to the history table and the migration gets re-applied later. Bring the missing migration file into the branch instead (`git checkout <other-branch> -- supabase/migrations/<file>`), or rebase so it is genuinely present.

Net asymmetry worth internalising: **schema changes accumulate across branches; function code does not.** Half your change can be live while the other half is not.

## Verification implication

After deploying anything from a branch, re-run the check for every *other* feature currently expected to be live on that function. A passing check from an hour ago proves nothing once someone deploys again.

