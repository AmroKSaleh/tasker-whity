# Core-workflow S1 measurement: batching is a non-optimization, get_task context is the real cost (2026-08-04)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Measured, not reasoned. A repeatable synthetic pass (S1, TDE-343) populated a 10-task section via MCP against project AAA on 2026-08-04. Baseline left in place in AAA section "Measurement Run S1" so the numbers can be re-derived after any change.

**The headline: the proposed optimization was ~30x smaller than the actual waste, and only measuring found that out.**

TDE-343 had proposed `create_section_with_tasks` to batch section+task creation, justified as saving tokens/time and stopping the AI "timing out halfway through." All three premises weakened on contact with data:
- **Concurrency already solves the timeout and wall-clock concern.** The 10 create_task calls were issued in a single message and ran concurrently — ~1 round-trip of wall-clock, not 10. Nothing was at risk of dying halfway. This is the general point: *a tool-call count is not a latency measurement* when the client can parallelize. Only clients that cannot batch concurrently would benefit.
- **Token cost sits in the REQUEST, not the response.** create_task returns two lines. The bulk is the task titles, details, and milestones — which must be written either way, batched or not. Real saving is protocol framing, under 1k tokens on a 10-task batch.
- Meanwhile the same session leaked ~27k redundant tokens through get_task re-sending the full project context on every call (filed as its own high-priority bug). Same workflow, 30x the cost, and nobody had proposed fixing it because nobody had counted.

**Reusable rule:** before building an efficiency feature, run the workflow once and count. The intuition about where the cost is was off by more than an order of magnitude here, and the wrong fix would have shipped while the real one stayed invisible.

**Other measured results, all clean — do not re-investigate these without new evidence:**
- 10/10 tasks landed in the intended section with priorities and milestones intact. The TDE-369 failure class (section_id written null → task invisible on the board) does NOT recur through the MCP path.
- The TDE-379 similarity check produced ZERO false refusals across 10 thematically-related tasks. It does not obstruct a legitimate batch, which was the main risk of having it auto-refuse.

**One real friction found, with a cheap fix:** create_task returns only `id: <uuid>`, never the short ID. Discovering the batch had become AAA-1..AAA-10 required an extra list_tasks round-trip, and without it an agent cannot tell the human which tasks it just created. **Returning short_id in the create_task response** is a tiny change that removes a round-trip and captures most of the value the larger "deep links" idea was after. Do it independently of that decision.

**Method note worth keeping:** the split into two passes — synthetic for repeatable numbers, real work for honest feel — is what let the mechanical half be discharged immediately while the subjective half waited for the human. A single fused "does it feel great" task was unanswerable and sat open for a month. When a criterion mixes measurement with judgment, separate them and the measurable half usually closes the same day.

