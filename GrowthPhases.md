# Tasker Growth Phases Strategy

**Document Date:** 2026-05-28  
**Status:** LOCKED IN - Strategic direction decided and committed to  
**Owner:** User (solo founder, bootstrapped)

---

## Executive Summary

Tasker will grow through two distinct phases:

**Phase 1 (Now):** Free product for solo developers. Build deep engagement, prove product-market fit, gather feedback on the web app interface (treating solo devs as Phase 2 early testers). Target 5k+ engaged monthly active users. Completely bootstrapped, sustainable costs.

**Phase 2 (Later):** When Phase 1 hits success metrics, pivot to B2B teams. The web app is already built and tested. Add team collaboration features (shared visibility, task assignment, roles), monetize at $10-20/user/month, pitch to VCs with proof of product-market fit.

---

## The Journey to This Decision

### Part 1: The Architecture Question

#### The Problem We Identified

As we built out Tasker's features, a critical realization emerged: **the app was making expensive API calls to LLM providers** (Gemini, Claude) for in-app AI features like:
- Section context sidebar with AI chat
- Daily AI briefing on the Today page
- AI-powered task analysis and insights

Meanwhile, we had built MCP tools that solo developers could use in Claude Code. When using MCP:
- Developers call Tasker MCP tools (just HTTP data fetches, no token cost)
- Claude/GPT reasoning about that data (user pays their own subscription)
- **Result:** Token-efficient, cheap, sustainable

But when using the app:
- Tasker calls Gemini/Claude API (expensive inference calls)
- User or Tasker pays for every token
- **Result:** Expensive, unsustainable at scale

**The core tension:** We were building an expensive in-app AI layer while simultaneously providing a cheap MCP interface. This didn't make sense.

#### The Options Considered

We debated three architectural approaches:

**Option 1: Standalone App + Free MCP (No In-App AI)**
- App works completely standalone (no AI built-in)
- MCP tools expose all functionality (free, users call Claude Code)
- No in-app inference calls (zero token costs)
- Users choose: use the app solo, OR use Claude Code with MCP, OR both
- **Pros:** Cheap, independent, sustainable, flexible
- **Cons:** No "premium AI features" to monetize immediately
- **Business model:** Later (B2B teams, premium features)

**Option 2: Dual Interfaces with Heavy In-App AI**
- Rich web app with AI features
- MCP tools mirror the app
- Both interfaces maintain parity
- **Pros:** Complete feature set in both places
- **Cons:** Expensive to maintain, token costs scale poorly, confusing for users

**Option 3: MCP-First, App is Just a Viewer**
- MCP tools are the primary interface
- Web app is supplementary (read-only dashboard)
- All work happens through MCP
- **Pros:** Single source of truth
- **Cons:** App feels weak, removes the gearbox visualization entirely

#### Decision: Option 1

**Why Option 1 won:**

The cost analysis was clear: in-app AI inference calls are unsustainable for a bootstrapped product. But Option 1 doesn't sacrifice features — it just moves them to where they're cheaper (MCP + user's Claude subscription).

More importantly, **Option 1 is the right product strategy**, not just cost-cutting:

Solo developers are text-native. They live in their editors and AI platforms (Claude Code, Cursor, etc.). They're not switching windows to open a web app for every decision. MCP is the interface they want.

The web app becomes what it should be: **a visualization and collaboration tool**. For solo devs, it's optional (nice to have). For teams (Phase 2), it becomes essential (you need visual shared visibility).

**Architectural implications:**
- Remove section-chat edge function (in-app AI chat)
- Remove AI briefing from Today page
- Simplify SectionContextSidebar to data-only (no chat, just showing task counts/groups/recent tasks)
- Move AI analysis to MCP tools: `analyze_section` (structured data) and `section_insights` (AI-powered diagnosis)

### Part 2: The Business Model Question

Once the architecture was decided, the business model became clearer. But we had to answer: **How does Tasker make money?**

#### The Tension

A visualization tool is a commodity. Notion, Asana, Linear, Todoist all have beautiful task boards. Just being "another task app" doesn't attract venture funding or create a business.

But stripping out in-app AI (Option 1) seems to remove the differentiator. So what are we selling?

#### The Realization

The user (you) made a key insight: **You don't know if solo developers even want the visualization.** They're used to text-based interfaces. They might be perfectly happy with MCP in Claude Code and never open the web app.

This forced a decision point: **Either:**
- Build the web app anyway and test that assumption with solo devs
- Skip the web app and go MCP-only

#### The Strategic Choice

You chose to build the full web app, but with a clear rationale:

1. **Phase 2 definitely needs visualization** — Teams need to see shared tasks, workload, project status visually
2. **Testing with solo devs is valuable** — Gather UX/interface feedback that will inform Phase 2 team features
3. **Time-to-market trade-off** — Slower Phase 1 launch, but Phase 2 is already built and validated

This led to the two-phase model:

### Part 3: The Two-Phase Growth Strategy

#### Phase 1: Solo Developers (Now)

**Goal:** Build a beloved product for solo developers. Prove product-market fit. Test the interface design. Get deeply engaged users.

**Target Audience:**
- Solo developers, indie hackers, freelancers
- Developers comfortable with AI tools (Claude Code, Cursor, etc.)
- People building their own projects
- Comfortable with text/MCP interfaces
- Age: 25-45 typically, experienced developers

**What They Get:**
- Free web app (complete, beautiful, standalone)
- Free MCP tools (work inside Claude Code)
- AI analysis via MCP (free, they pay Claude subscription)
- No subscription, no vendor lock-in, low friction

**Why This Works:**
- Solo devs validate the product with zero acquisition cost
- They tell you what's broken, what's missing, what matters
- Deep engagement is possible because they're the target user
- Easy to measure (DAU, retention, churn are clear metrics)

**Success Metrics:**
- 5,000+ monthly active users (MAU)
- 40%+ DAU/MAU ratio (shows they're using it regularly, not just once)
- <5% monthly churn (they stick around)
- 60%+ feature adoption (they're actually using groups, sections, focus mode, MCP tools)
- Organic growth visible (word-of-mouth, community mentions)

**Key Activities:**
- Build the full web app (with Phase 2 team needs in mind)
- Remove in-app AI (replace with MCP tools for analysis)
- Add MCP analysis tools (`analyze_section`, `section_insights`)
- Launch to solo dev communities (Indie Hackers, Hacker News, Twitter, direct outreach)
- Gather feedback on UI/visualization (treating them as Phase 2 early testers)
- Measure engagement ruthlessly (DAU, retention, churn, feature adoption)
- Build community (Discord, Twitter presence, responsive to feedback)

**Timeline:** Until Phase 1 success metrics are hit consistently (estimated 6-12 months)

**Cost Model:**
- $0 to users (free forever)
- $0 revenue (completely bootstrapped)
- Sustainable infrastructure costs (Supabase, Netlify, AWS for MCP)

---

#### Phase 2: B2B Teams (Later)

**Goal:** Scale to profitability. Target teams of developers. Pitch to VCs with proof of market fit.

**When to Start:**
When Phase 1 hits:
- 5k+ MAU consistently
- >40% DAU/MAU ratio
- <5% churn
- Clear product-market fit signals
- User feedback: teams asking for shared features

**What They Get:**
- Everything Phase 1 had (app, MCP tools)
- Team collaboration (shared projects, visibility)
- Task assignment (assign work to team members)
- Role-based access (different permissions)
- Premium AI features (team-wide insights, planning assistance)
- Webhooks, integrations, automation

**Revenue Model:**
- SaaS: $10-20 per user per month
- Team accounts (minimum 3 users to justify overhead)
- Free tier: maybe 1 team of 3, then upgrade required

**Why This Works:**
- Solo devs are already using Tasker, love it
- Natural upsell: team wants shared task visibility
- Proven product: no "does anyone want this?" risk
- Teams have budgets for productivity tools
- Clear growth story for VCs (free → paid upgrade path)

**VC Pitch:**
"We built Tasker for solo developers and got X engaged users without paying for acquisition. Teams wanted to use it too, so we added collaboration features. Here's the developer productivity market size. Here's our user retention, engagement, cohort analysis. Here's why B2B teams will pay."

**Why VCs Love This:**
- Proof of product-market fit (solo devs chose it, weren't sold)
- Lower risk (validated with real users)
- Warm customer base for upsell (no cold outreach)
- Founder-led product (not committee-built)
- Clear SaaS model (proven, scalable)

**Phase 2 Work:**
- Add team management features (org, roles, permissions)
- Build shared views and collaboration signals
- Premium AI features (team planning, insights)
- Payment/billing system
- Customer support infrastructure

**Timeline:** Starts when Phase 1 success metrics hit, estimated 6-12 months later

---

## The Gearbox Mental Model

Throughout this entire strategy, the user articulated a powerful organizing metaphor:

**Project = the complete machine** (all moving parts in concert)
**Sections = gearboxes** (self-contained functional units that work together)
**Groups = how gears are arranged** (logical organization within a section)
**Tasks = individual gears** (atomic units of work)

This model informs everything:
- When a solo dev "focuses" on a section, they're zooming into one gearbox
- Teams can see the whole machine, understand how gearboxes interact
- The visualization helps teams see if a gearbox is overloaded or underfunctioning
- MCP tools let you query and manipulate gears textually (for developers)
- The web app lets you see the structure visually (for teams and non-devs)

This isn't just metaphor — it's the information architecture that makes Tasker different from other task apps.

---

## Why This Strategy is Solid

### 1. De-risks the business entirely

Phase 1 costs $0 to run (bootstrapped, sustainable). Either it works or it doesn't. No money wasted before you know the market wants it.

### 2. Addresses the real problem

Solo developers already use AI tools. They need better organization for their work. Tasker meets them where they are (Claude Code) and provides organization they can't get elsewhere.

### 3. Builds moat through adoption

By Phase 2, thousands of developers know Tasker, love it, use it daily. Teams naturally want to collaborate using it. Switching costs are real (they've organized their entire project structure in Tasker).

### 4. Makes VC pitch inevitable, not forced

If Phase 1 works, the VC conversation starts naturally: "Hey, our users are asking for team features. We'd love to scale this." VCs back winners, not founders who need to convince them to fund a risky bet.

### 5. Keeps options open

If B2B doesn't work out, you have a thriving solo dev community using the free product. That's a lifestyle business with no obligations. If it does work, you scale it.

### 6. Honest timeline

Phase 1 might take 12 months. Phase 2 might take 12 months. Total path to Series A: ~24 months. That's realistic and de-risks investor expectations.

---

## What We're NOT Doing

**Not building B2B features in Phase 1** — Would be wasted effort. Solo devs don't need them, they'll inform Phase 2 anyway.

**Not chasing venture before Phase 1 proof** — Weak pitch, high risk of pivoting later and confusing investors.

**Not optimizing for VC metrics before PMF** — If you chase revenue/growth metrics too early, you'll optimize for the wrong thing and miss what users actually need.

**Not building two separate products** — App and MCP are one product, two interfaces. Sync'd at the Supabase backend.

**Not removing the web app** — It's essential for Phase 2. Testing it with Phase 1 users validates the UX before teams depend on it.

**Not keeping in-app AI** — It's expensive, unsustainable, and users prefer MCP anyway. Better to move AI analysis to MCP tools where it's cheap and natural.

---

## Implementation Roadmap

### Immediate (Next 1-2 weeks)
1. Remove section-chat edge function
2. Simplify SectionContextSidebar (data-only, no chat)
3. Add `analyze_section` MCP tool (structured section health data)
4. Add `section_insights` MCP tool (AI-powered section analysis via Claude)

### Short-term (Weeks 3-8)
1. Polish web app for Phase 1 launch (visual clarity, gearbox metaphor, performance)
2. Set up analytics (DAU, MAU, churn, feature adoption tracking)
3. Create marketing materials (demo video, blog post, launch post)
4. Prepare beta testing (20-50 early adopters, gather feedback)

### Medium-term (Weeks 8-12)
1. Public launch (Indie Hackers, Twitter, communities)
2. Monitor Phase 1 metrics daily
3. Gather user feedback (surveys, interviews, Discord discussions)
4. Respond quickly to bugs, feedback, feature requests
5. Build community (be present, helpful, genuine)

### Long-term (Months 6-12)
1. Track Phase 1 success metrics
2. Gather feedback on visualization/interface
3. Analyze what teams would need (based on power users)
4. Plan Phase 2 team features
5. Decide: when are we ready for Phase 2?

---

## Success Looks Like

**Phase 1 Success:**
- 5k+ solo developers using Tasker
- They open the app at least 2-3x per week
- They use sections, groups, focus mode, MCP tools
- Churn is low (<5% monthly)
- They tell their friends about it (organic growth)
- They give you detailed feedback on what's missing
- You feel confident in the product-market fit

**Phase 2 Success:**
- Teams are asking for shared features
- Churn from Phase 1 is minimal (users stay as they upgrade to team version)
- You have a clear roadmap of what teams need
- You're ready to raise a seed round ($500k-2M) with confidence
- VC pitch is strong: "We have X users, Y retention, Z engagement, here's the market"

**Ultimate Success:**
- Tasker becomes the default task tool for developers
- Teams use it to organize their work
- It's profitable or well-funded enough to sustain
- You've built something people genuinely love and can't live without

---

## Commitment

The owner (you) is committed to:
- Focusing on Phase 1 success (not jumping to Phase 2 too early)
- Measuring engagement metrics ruthlessly
- Gathering feedback from users (not just building features)
- Growing organically first (not paid acquisition)
- Building community and relationships
- Staying bootstrapped until Phase 2 is ready

This is a serious strategic commitment to a 12-24 month runway before deciding on venture funding.

---

## Questions Answered

**"Will solo devs actually use the web app if they're in Claude Code?"**
- Unknown. Phase 1 will test this. If they don't, we'll know visualization isn't critical for solo devs.
- But it's fine because Phase 2 teams definitely need it. So we build it anyway.

**"Why not just go MCP-first and skip the web app?"**
- Because teams will need the web app. Building it in Phase 1 means we get feedback, test the design, and it's ready for Phase 2.

**"How do you make money?"**
- Phase 1: $0 (bootstrapped)
- Phase 2: SaaS ($10-20/user/month for teams)

**"Why not monetize solo devs?"**
- Because the goal is adoption and engagement, not immediate revenue. Charging solo devs kills growth and limits feedback.
- Money comes from teams in Phase 2. Solo devs prove the product works first.

**"What if Phase 1 doesn't hit success metrics?"**
- Then Tasker stays a free tool for solo developers. That's a valid outcome. You have a thriving community, low costs, no obligations.
- But you wouldn't have Phase 2 revenue or VC funding. That's okay.

**"What if solo devs don't want to pay in Phase 2?"**
- Then Phase 2 becomes team-only features. Solo devs stay on free plan, teams pay.
- Or you discover that developers (even in teams) don't want to pay. Then you find another revenue model (premium features, integrations, consulting).

---

## Final Note

This strategy is based on one core insight: **The best way to find product-market fit is to build something you and users love, measure engagement ruthlessly, and let the data guide growth.**

Tasker is a genuinely good product for solo developers. Phase 1 proves that. Phase 2 scales it to teams. VCs back proven winners, not speculative bets.

Everything is documented. The path is clear. Execute Phase 1, measure success, decide on Phase 2.

Go build. 🚀
