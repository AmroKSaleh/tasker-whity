# MCP: ilike takes a PATTERN, not a string — escape user input, and never resolve ambiguity by "newest"

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Fixed in TDE-872, 2026-08-07. Two separate lessons; the second is the one that generalises.

**1. Anything passed to `.ilike()` is a LIKE PATTERN.** `%`, `_` and `\` are operators there, so raw user input silently becomes a query language. `project_id: "T_E"` resolved `TDE`. `"%"` matched every row the caller owned. Use `escapeLike()` (defined near `resolveProject`) at EVERY interpolation site, including ones that intend an exact match — a `%…%` wrapper added later around an unescaped value is exactly how this returns.

Postgres LIKE treats backslash as the default escape character, so prefixing the three metacharacters is enough; no `ESCAPE` clause needed. Verified that the backslash survives PostgREST: a flow literally named `ZZ_THROWAWAY_underscore_probe` still resolves, while `ZZ%probe` no longer matches it.

Explicitly NOT a security issue, and do not let anyone re-file it as one: every affected query was scoped by `.eq('user_id', userId)`, so a caller could only wildcard-match their own rows. The parameterization was intact throughout. This was correctness and predictability.

**2. The dangerous half was never the escaping — it was `.order('created_at', desc).limit(1)` as a resolution strategy.**

Three flow lookups used it. That shape does not fail on ambiguity; it returns the caller's most recently created flow. An agent asks for flow A, operates on flow B, and no error appears anywhere. Escaping removes the wildcard route in, but two flows genuinely containing "deploy" are ambiguous for entirely ordinary input — so the bug survives escaping. **`limit(1)` over an ordered ambiguous match is a guess wearing the costume of an answer.**

**The structural finding worth remembering: six sites doing the same lookup had drifted into FOUR different behaviours.** One listed the candidates and refused. Two returned null, so callers reported "not found" when the truth was "ambiguous" — a different and misleading fact. Three guessed the newest. Nobody decided this; it accumulated by copy-paste over months, and the correct implementation was sitting 200 lines from the worst one.

So the open design question on the task ("should ambiguous lookups return candidates instead of guessing?") did not need a decision — the codebase had already answered it in its best site. **When N copies of one operation disagree, look for the copy that is already right before designing something new.** Now unified in `findFlowsByName` + `ambiguousFlowMessage`.

**Idiom to reuse:** `resolveFlow` / `resolveFlowRef` return `{ ambiguous: <message> }` on a multi-match, and every caller guards with `if (flow?.ambiguous) return flow.ambiguous` before its not-found check. Both are typed `Promise<any>` deliberately — a discriminated union would force narrowing at all seven call sites for no behavioural gain.

**Gotcha for future bulk edits in this repo:** `supabase/functions/mcp/index.ts` has **CRLF** line endings. A `perl -0pi` pattern anchored on `\n` matches nothing and reports success. Use `\r?\n`, and always count the result — the first pass here silently changed zero lines.

