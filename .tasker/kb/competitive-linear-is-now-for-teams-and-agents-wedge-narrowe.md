# Competitive: Linear is now "for teams and agents" — wedge narrowed to quality-gated + solo (TDE-368)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Checked linear.app 2026-07-10 (TDE-368, rush). Finding: the Foundation risk "MCP becomes commoditized by larger tools" HAS MATERIALIZED via Linear.

**What Linear has now:**
- Tagline: "The product development system for teams and agents." Agents are first-class workspace members — issues assignable to OpenAI Codex, Cursor, GitHub Copilot, Devin, Sentry, ChatPRD, Factory, Charlie, etc. Human stays primary assignee, agent = contributor.
- Official MCP server (mcp.linear.app/mcp, OAuth 2.1 + dynamic client registration): issues/comments/projects/milestones/initiatives/releases/docs-search readable+writable by any AI client.
- Linear Agent also CONSUMES MCP (Apr 2026): pulls external context (Granola, Glean, Notion, PostHog) — context-aggregation hub in both directions. Admin allowlists, workspace-level MCP permissions.
- "Diffs": first-class surface for reviewing code + agent output.

**Consequences for Tasker:**
1. The Foundation line "No other task app lives inside the developer's AI workflow" is NO LONGER TRUE — do not ship messaging containing it (revise during TDE-370).
2. Of the positioning wedge (durable / human-shared / quality-gated — TDE-367), Linear commoditizes DURABLE and HUMAN-SHARED for teams. **QUALITY-GATED is the load-bearing leg**: Linear has transparency (watch/inspect agent reasoning) but NO enforcement gates — no handoff contracts, no validation loop that fails→regenerates, no independent adversarial review. Diffs = review surface, not gate.
3. Audience gap holds: Linear's center of gravity is product TEAMS (cycles, triage, initiatives, enterprise admin). Solo devs / non-programmer AI-native builders — Tasker's Phase 1 — are structurally underserved by it; and Linear's agent model is "delegate to a worker colleague," not "AI as primary interface+executor."
4. Validation: their named-agent model (assign to a specific agent identity) rhymes with TDE-363 (downloadable Tasker "Agents") — direction resonates in-market.

**Action taken:** folded into TDE-370 — messaging must lean hardest on quality-gated + solo/AI-native-builder framing; durable/shared alone is table stakes vs Linear.

Sources: linear.app landing, linear.app/agents, linear.app/changelog/2026-04-23-linear-agent-mcp-support, linear.app/docs/linear-agent.
