# {deployment} NEVER redeploy an edge function while a request against it is in flight — it can drop the request and lose data

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

**Incident 2026-06-25: a task was permanently lost** when a `supabase functions deploy mcp` was run IN PARALLEL (same tool-call batch) with a `move_task` request hitting that same mcp function.

## What happened
move_task(TDE-276 → TG) returned a success message ("Moved … to TG-31"), but the task ended up nowhere — not in TDE, not in TG, gone from the DB entirely. A later move computed MAX(short_id) and reused 31, confirming 276's row never persisted its move. Root cause: the edge function was being torn down / swapped mid-request by the concurrent redeploy, so the write was lost despite the optimistic success response.

## Rule
- NEVER batch a function deploy in the same turn as an MCP tool call that hits that function. Deploys and live calls must be serialized.
- More generally: don't run mutation tool calls concurrently with a redeploy of the server handling them.
- After any deploy that raced with activity, VERIFY data integrity before trusting success messages.

## Recovery
The lost task ("Add the ability to share projects", was rush priority) was recreated in TG B2B & Teams from content captured earlier in the session (id fb26293b-6c5d-4c9b-8543-b83f393f6b83). Bulk move_task lesson still stands separately: run moves sequentially (short_id = MAX+1 with no advisory lock — see the move_task KB).
