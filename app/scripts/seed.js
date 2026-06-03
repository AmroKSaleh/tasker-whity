/**
 * Seed script — imports all tasks from project-dashboard.html into Supabase.
 * Run once: node scripts/seed.js
 * Requires SEED_EMAIL and SEED_PASSWORD in .env.local
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createClient } from '@supabase/supabase-js'

// ── Load env from .env.local ──────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const envText = readFileSync(join(__dirname, '../.env.local'), 'utf8')
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
    .map(l => { const [k, ...rest] = l.split('='); return [k.trim(), rest.join('=').trim()] })
)

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY
const EMAIL       = env.SEED_EMAIL
const PASSWORD    = env.SEED_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('Add SEED_EMAIL and SEED_PASSWORD to .env.local before running this script.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractPriority(tags = []) {
  if (tags.some(t => ['rush','urgent','p1'].includes(t))) return 'rush'
  if (tags.some(t => ['high','p2','blocked'].includes(t))) return 'high'
  if (tags.some(t => ['medium','p3','schema'].includes(t))) return 'medium'
  if (tags.some(t => ['low','p4'].includes(t))) return 'low'
  return null
}

function cleanTags(tags = []) {
  const priority = ['rush','urgent','p1','high','p2','blocked','medium','p3','schema','low','p4']
  return tags.filter(t => !priority.includes(t))
}

// ── Task data (sourced from project-dashboard.html) ──────────────────────────
const PROJECTS = [
  {
    name: 'master', label: 'Master TDL', position: 0,
    sections: [
      {
        title: 'Strategic Priorities',
        items: [
          { text: 'Create the lead magnet document', tags: ['rush','p1'] },
          { text: 'Have Amro explain what he is doing with his uncle — then identify what content would improve the outcome', detail: 'Get context from Amro on the initiative, then map it to content needs: blog posts, lead magnets, LinkedIn posts, or landing pages depending on the goal.', tags: ['rush'], done: true },
          { text: 'Stage 1 EN baseline articles complete — all 14 available published', detail: 'All 14 available EN articles published (Articles 5-7 blocked, RTM cluster). Last few articles missing images due to Gemini technical issues — resolve before adding images. Arabic translations in progress: AR 1-4 done, AR 8-9 done, AR 10 next.', tags: ['p1'], done: true },
          { text: 'Ask Abed this week — case studies + G2/Capterra reviews', detail: '(a) Name 2-3 clients willing to be cited in case studies with real outcome data. (b) Personally reach out to 10-15 clients and ask for G2/Capterra reviews. See Credibility Gaps tab.', tags: ['p2','abed'] },
          { text: 'Website parallel track: credibility fixes + schema', detail: 'While content is being written. See Credibility Gaps tab and What Top Pages Do tab.', tags: ['p3'] },
          { text: 'Fix website technical issues', detail: 'GA4 installed. Remaining: waqtak-scripts.js 404, email capture. 2026-04-28 audit found 10 more actionable issues — see Website tab Site Audit Fixes section.', tags: ['p4'] },
          { text: 'After Stage 1: Industry posts', detail: 'Government (GCC-focused, Arabic-first), Banking (English-first), Healthcare (GCC signals)', tags: ['low'] },
          { text: 'After Stage 1 + industry: Five Blind Spots pillar content', detail: 'Blog + LinkedIn + gated PDF', tags: ['low'] },
          { text: 'After baseline: Playbook content track', detail: 'Daily/weekly/monthly workflows for Firas', tags: ['low'] },
        ]
      },
      {
        title: 'Backlog',
        items: [
          { text: 'Waqtak NHS Integration', detail: 'Reference doc: https://docs.google.com/document/d/1y41ToMOvSqDKhpmHfX4r_J0C-ofdpteK-iv5PzoB81k/edit?usp=sharing', tags: ['low'], reference: true },
          { text: 'Discuss hardware-to-SaaS upsell strategy', tags: ['low'], reference: true },
        ]
      },
      {
        title: 'Completed',
        items: [
          { text: 'Blog section built locally and deployed to live site', done: true },
          { text: 'Yoast SEO installed, meta descriptions on all pages', done: true },
          { text: 'Content strategy finalized via multi-model feedback loop', done: true },
          { text: 'Article production workflow established (16-step process)', done: true },
          { text: 'Articles 1-3 written and published (What is QMS / Types / Benefits)', done: true },
          { text: 'Duplicate title tags removed sitewide', done: true },
          { text: 'Organization schema added (Facebook, LinkedIn, Instagram)', done: true },
          { text: 'SERP competitor analysis (10 pages) + SEO reference files created', done: true },
          { text: 'All 14 available Stage 1 EN articles published — Articles 5-7 blocked (RTM). Images missing on last few due to Gemini technical issues.', done: true },
          { text: 'GA4 installed on waqtak.io', done: true },
          { text: 'Full bilingual site audit completed (2026-04-28) — 14 actionable issues catalogued across 35 pages', done: true },
          { text: 'Arabic contact page /ar/contact-ar/ deployed (was 404 on production)', done: true },
          { text: 'Stage 1 Arabic started — QMS cluster AR (articles 1-3 published)', done: true },
        ]
      },
    ]
  },

  {
    name: 'website', label: 'waqtak Website', position: 1,
    sections: [
      {
        title: 'Technical Fixes',
        items: [
          { text: 'Fix waqtak-scripts.js 404', detail: "A script is being enqueued but the file doesn't exist or the path is wrong. Flagged by Google Rich Results Test as a failed resource on every page load.", tags: ['high'], done: true },
          { text: 'Fix TOC scrolling on blog posts', detail: 'Table of contents scroll behavior is broken. Investigate and fix.', tags: ['medium'] },
        ]
      },
      {
        title: 'Schema',
        items: [
          { text: 'Add FAQPage schema to all solution pages and blog articles', detail: 'Use Yoast FAQ block on each page. Validate at validator.schema.org after each page. Generates rich snippet real estate in SERPs without changing ranking position.', tags: ['schema','high'] },
          { text: 'Add SoftwareApplication schema to all solution pages', detail: 'JSON-LD: @type SoftwareApplication, applicationCategory: BusinessApplication, operatingSystem: Web. Add via Yoast or a custom JSON-LD block in the theme head.', tags: ['schema','medium'] },
          { text: 'Fix author sameAs', detail: 'Update the "alaa" WordPress user profile to point to a real LinkedIn URL instead of the site homepage. Yoast uses this for E-E-A-T signals.', tags: ['schema','medium'] },
        ]
      },
      {
        title: 'Content Fixes',
        items: [
          { text: 'Fix Platform page "Why It Sucks" heading', detail: 'Off-tone for B2B enterprise audience. Rewrite to match the voice of other solution pages.', tags: ['medium'] },
          { text: 'Rewrite Appointments problem cards (#11)', detail: "Each card must map to the 'unmanaged demand' blind spot. Same quality as the Monitoring rewrites. Cards should remove the blind spot, not just describe a pain point.", tags: ['medium'] },
          { text: 'Rewrite Customer Feedback problem cards (#17)', detail: 'Map to "silent churn" blind spot. Fix the heading that currently duplicates Monitoring copy. Each card should make the reader feel the problem.', tags: ['medium'] },
          { text: 'Publish Arabic blog post', detail: 'EN blog has 1 post live at /what-is-queue-management-software-qms/. Arabic blog is empty. Translate and publish the Arabic version.', tags: ['medium'] },
          { text: 'Translate FAQs to Arabic and add to site', detail: 'After FAQPage schema is done on all solution pages, translate each FAQ block to Arabic and add to the corresponding Arabic solution pages.', tags: ['medium'] },
          { text: 'Update /pdf-download/ page copy for QMS Vendor Evaluation Scorecard', detail: 'Remove all Five Blind Spots references. Replace headline, description, and form context to match the new lead magnet. Hold until PDF from waqtak-content is ready.', tags: ['medium'] },
        ]
      },
      {
        title: 'Site Audit Fixes (2026-04-28)',
        items: [
          { text: 'Remove English headline from /ar/analytics-kpis-ar/ hero', detail: 'The hero section shows "Stop managing by intuition. Start managing by data." in English alongside the Arabic. Open the page in WP editor and delete the English text block from the hero section.', tags: ['high'], done: true },
          { text: 'Em dash sweep — sitewide EN pages', detail: 'Find and replace all em dashes with periods, commas, or parentheses. Affected: homepage, /about_us/, /pdf-download/, and all 6 industry pages.', tags: ['high'], done: true },
          { text: 'Remove stale /arabic/waqtak-solution-*/ language widgets from all 5 EN solution pages', detail: 'Every solution page has an in-content language widget with dead URLs. Remove the whole widget block from each page in WP editor.', tags: ['high'], done: true },
          { text: 'Fix Polylang mapping for /contact-us/ AR counterpart', detail: 'The AR language toggle on /contact-us/ points to /ar/1367-2/ (raw post ID). Fix by setting the Arabic page slug in Polylang settings for that page pair.', tags: ['high'], done: true },
          { text: 'Remove /book-demo/ URL references from /book-a-demo/ and /pdf-download/', detail: 'The wrong URL variant /book-demo/ (no "a") appears on these pages. Scrub all /book-demo/ references from both pages.', tags: ['high'], done: true },
          { text: 'Fix /ar/about-ar/ footer language toggle', detail: 'The EN link in the footer toggle points back to /ar/about-ar/ instead of /about_us/. Header toggle is correct — footer only is broken.', tags: ['high'], done: true },
          { text: 'Add per-language fallbacks to customizer-driven text (footer + nav CTA)', detail: 'Footer column headings, tagline, copyright, and nav CTA button text all pull from a single customizer value with no per-language variant.', tags: ['medium'], done: true },
          { text: 'Remove stale /arabic/waqtak-X/ links from footer sitewide', detail: 'Footer still references old /arabic/ URL pattern on /platform/, all industry pages, /book-a-demo/, /pdf-download/.', tags: ['medium'], done: true },
          { text: 'Fix "Contact Us" footer link on /appointments/', detail: 'Currently points to /about/ instead of /contact-us/. All other pages are correct — this is the only anomaly.', tags: ['medium'], done: true },
          { text: 'Fix /ar/industries-ar/ hero image alt text', detail: 'Currently alt="Placeholder". Replace with descriptive Arabic text.', tags: ['low'], done: true },
        ]
      },
      {
        title: 'Blocked on Abed',
        items: [
          { text: 'Fix About page placeholder text (EN + AR)', detail: 'EN: founding year, Keylife description, placeholder images. AR: same in Arabic. Cannot proceed without Abed providing the real content.', tags: ['high','abed'], done: true },
          { text: 'Fix Demo page placeholder testimonial', detail: '"[Short quote], [Name], [Title, Organization]" still visible to live users. Blocked on real client quote from Abed.', tags: ['high','abed'], reference: true },
          { text: 'Get Univia Pro font files and add to theme', detail: 'Font files needed from Abed. Currently falling back to system font.', tags: ['high','abed'], reference: true },
        ]
      },
      {
        title: 'Backlog',
        items: [
          { text: 'Fix image .png/.webp mismatch sitewide (#69)', tags: ['low'], reference: true },
          { text: 'Remove USAID logo and "250+ organizations trust Waqtak" text from Industries page', tags: ['low'], reference: true },
          { text: 'Reduce "citizen" usage on Government page (currently 14 instances)', tags: ['low'], reference: true },
          { text: 'Shorten Telecom H1 (126 chars), Healthcare H1 (94 chars), Retail H1 (89 chars)', tags: ['low'], reference: true },
          { text: 'Analytics & KPIs problem cards — too abstract, need rewrite', tags: ['low'], reference: true },
          { text: 'Fix duplicate hreflang tags sitewide', tags: ['low'], reference: true },
          { text: 'Fix /about/ vs /about_us/ URL inconsistency', tags: ['low'], reference: true },
          { text: 'GEO one-time setup — Register waqtak.io with Perplexity Publisher Program + upload llms.txt to site root', tags: ['low'], reference: true },
          { text: "Remove AI claims from F6S profile — edit product description to remove AI, predictive, or intelligent language that doesn't reflect the actual product", tags: ['low'], reference: true },
        ]
      },
      {
        title: 'Completed',
        items: [
          { text: 'Rewrite Analytics & KPIs problem cards', done: true },
          { text: 'Full Real-Time Monitoring page rewrite', done: true },
          { text: 'Build and deploy blog section (listing, single post, CSS, RTL, search, categories, TOC)', done: true },
          { text: 'Install Yoast SEO, configure meta descriptions for all 36 pages', done: true },
          { text: 'Fix Arabic footer sitewide (tagline, nav headings, copyright, social URLs, CTA text)', done: true },
          { text: 'Fix 8 waqtak.local URLs on Appointments EN page', done: true },
          { text: 'Fix /book-demo redirect sending EN users to Arabic demo page', done: true },
          { text: 'Remove duplicate title tags sitewide', done: true },
          { text: 'Add Organization schema (Facebook, LinkedIn, Instagram via Yoast)', done: true },
          { text: 'Install Google Analytics GA4 tag in header.php', done: true },
          { text: 'Deploy /ar/contact-ar/ Arabic contact page (was 404 on production)', done: true },
          { text: 'Fix Load More button on /blog/ — added missing AJAX handler to functions.php', done: true },
          { text: 'Build waqtak/partner-card Gutenberg block — logo, name, country tag, description, contact info, custom text + icon, PHP render callback, equal-height CSS', done: true },
          { text: 'Translate "250+ organizations trust Waqtak" caption to Arabic on /ar/home-ar/', done: true },
          { text: 'Fix Arabic contact page slug — /ar/1367-2/ renamed to /ar/contact-ar/', done: true },
          { text: 'Add 301 redirect from /ar/about-ar/ to /ar/about_us-ar/', done: true },
        ]
      },
    ]
  },

  {
    name: 'content', label: 'waqtak Content', position: 2,
    sections: [
      // Stage 1 EN clusters → individual sections
      { title: 'Stage 1 EN — Queue Management', items: [
        { text: 'What is a Queue Management System?', tags: ['stage1'], done: true },
        { text: 'Types of Queue Management Systems', tags: ['stage1'], done: true },
        { text: 'Benefits of a Queue Management System', tags: ['stage1'], done: true },
        { text: 'How to Choose the Right Queue Management System', tags: ['stage1'], done: true },
      ]},
      { title: 'Stage 1 EN — Real-Time Monitoring', items: [
        { text: 'What is Real-Time Branch Monitoring?', tags: ['stage1'] },
        { text: 'Benefits of Real-Time Monitoring', tags: ['stage1'] },
        { text: 'How to Choose a Monitoring Solution', tags: ['stage1'] },
      ]},
      { title: 'Stage 1 EN — Analytics & KPIs', items: [
        { text: 'What is Operational Analytics for Branches?', tags: ['stage1'], done: true },
        { text: 'Benefits of Operational Analytics', tags: ['stage1'], done: true },
        { text: 'How to Choose an Analytics Platform', tags: ['stage1'], done: true },
      ]},
      { title: 'Stage 1 EN — Appointments', items: [
        { text: 'What is an Appointment Scheduling System for Branches?', tags: ['stage1'], done: true },
        { text: 'Types of Appointment Scheduling Systems', tags: ['stage1'], done: true },
        { text: 'Benefits of Appointment Scheduling', tags: ['stage1'], done: true },
        { text: 'How to Choose an Appointment System', tags: ['stage1'], done: true },
      ]},
      { title: 'Stage 1 EN — Customer Feedback', items: [
        { text: 'What is Customer Feedback Management?', tags: ['stage1'], done: true },
        { text: 'The 5 Benefits of Customer Feedback Management Systems', tags: ['stage1'], done: true },
        { text: 'How to Choose a Customer Feedback Solution', tags: ['stage1'], done: true },
      ]},
      { title: 'Stage 1 Arabic — Queue Management', items: [
        { text: 'ما هو نظام إدارة الطوابير؟', tags: ['stage1','arabic'], done: true },
        { text: 'أنواع أنظمة إدارة الطوابير', tags: ['stage1','arabic'], done: true },
        { text: '5 فوائد نظام إدارة الطوابير', tags: ['stage1','arabic'], done: true },
        { text: 'كيف تختار نظام إدارة الطوابير', tags: ['stage1','arabic'], done: true },
      ]},
      { title: 'Stage 1 Arabic — Analytics & KPIs', items: [
        { text: 'ما هي البيانات والتحليلات التشغيلية للفروع؟', tags: ['stage1','arabic'], done: true },
        { text: 'فوائد البيانات والتحليلات التشغيلية للفروع', tags: ['stage1','arabic'], done: true },
        { text: 'كيف تختار منصة التحليلات', tags: ['stage1','arabic','here'] },
      ]},
      { title: 'Stage 1 Arabic — Remaining Clusters', items: [
        { text: 'Appointments cluster AR (4 articles — EN 11-14)', tags: ['stage1','arabic'], reference: true },
        { text: 'Customer Feedback cluster AR (3 articles — EN 15-17)', tags: ['stage1','arabic'], reference: true },
      ]},
      { title: 'Stage 1 Arabic — Real-Time Monitoring (Blocked)', items: [
        { text: 'RTM cluster AR (3 articles — EN 5-7) — blocked pending Abed answer on minimum branch count', tags: ['stage1','arabic','blocked'], reference: true },
      ]},
      { title: 'Stage 2: Problem-Framing (EN)', items: [
        { text: 'Revise "What Your Operation Loses Without a Queue Management System"', detail: 'Apply 10-point revision plan. Add GCC layer.', tags: ['stage2'] },
        { text: 'Write Real-Time Monitoring problem-framing article', tags: ['stage2'] },
        { text: 'Write Analytics & KPIs problem-framing article', tags: ['stage2'] },
        { text: 'Write Appointments problem-framing article', tags: ['stage2'] },
        { text: 'Write Customer Feedback problem-framing article', tags: ['stage2'] },
      ]},
      { title: 'Stage 2 Arabic', items: [
        { text: 'Batch translate all 5 problem-framing articles to Arabic', tags: ['stage2','arabic'] },
      ]},
      { title: 'Stage 3: Industry Posts', items: [
        { text: 'Government industry blog post', detail: 'GCC-focused, Arabic-first', tags: ['stage3'] },
        { text: 'Banking industry blog post', detail: 'GCC-focused, English-first', tags: ['stage3'] },
        { text: 'Healthcare industry blog post', detail: 'GCC signals', tags: ['stage3'] },
      ]},
      { title: 'Backlog', items: [
        { text: 'Add images to EN articles missing them (Articles 4, 8–17) — Gemini technical issues blocking image generation. Resolve Gemini issue or switch tool before resuming.', reference: true },
        { text: 'Complete Arabic refinement of Article 9 (فوائد البيانات والتحليلات التشغيلية للفروع) — user noted it was not fully finished', reference: true },
        { text: 'Remove checklist from "How to Choose a QMS" and convert to gated PDF lead magnet', reference: true },
        { text: 'Five Blind Spots blog post (pillar article, after baseline)', reference: true },
        { text: 'Five Blind Spots LinkedIn post', reference: true },
        { text: 'Five Blind Spots gated PDF lead magnet', reference: true },
        { text: 'Playbook content: daily check-in, weekly review, monthly staffing plan', reference: true },
      ]},
    ]
  },

  {
    name: 'getlisted', label: 'Get Listed', position: 3,
    sections: [
      {
        title: 'Action Items — In Priority Order',
        items: [
          { text: 'Claim G2 + Capterra profiles — do this now, before first articles publish', detail: "G2: create vendor account → select 'Queue Management' category → add product details, screenshots, pricing, integrations. Capterra/Software Advice/GetApp: one profile covers all three.", tags: ['rush'] },
          { text: 'Get 10-15 verified client reviews on G2 — within 30 days of claiming profile', detail: "Abed identifies 10-15 existing clients. Send them G2's direct review link. Reviews must be from verified current users. Spread reviews over several weeks.", tags: ['rush','abed'] },
          { text: 'Submit to TheCXLead for editorial review — after G2/Capterra have 5-10 reviews', detail: "Visit thecxlead.com and use the 'Interested in being reviewed?' link. Pitch: 'We're the only queue management platform built specifically for the GCC market.'", tags: ['high'] },
          { text: 'Add FAQ schema to all solution pages and blog articles', detail: 'Add a FAQ section (5 questions minimum) to each solution page. Implement FAQ schema via Yoast. Validate at validator.schema.org.', tags: ['high'] },
          { text: 'Publish pricing information on waqtak.io', detail: "Even a rough tier structure is better than nothing: 'Starts at $X/branch/month. Enterprise pricing on request.' Confirm pricing structure with Abed before publishing.", tags: ['medium','abed'] },
          { text: 'Contact ScanQueue about MENA inclusion — after G2/Capterra are live', detail: "Reach out via ScanQueue's contact page once G2/Capterra profiles are active. Don't do this before G2/Capterra are active.", tags: ['low'] },
        ]
      },
    ]
  },

  {
    name: 'toppages', label: 'What Top Pages Do', position: 4,
    sections: [
      {
        title: 'Content Structure',
        items: [
          { text: 'Word count meets the minimum for the page type', detail: 'Competitive queries: 3,500-7,000 words. Educational pillar pages: 3,500-4,500 words. Product/solution pages: 2,000-3,000 words. Pages under 1,000 words do not rank.', tags: [] },
          { text: 'Page includes all four required sections', detail: '"What is [topic]?" anchors informational queries. Industry verticals section captures high-intent vertical searches. "How to choose" section captures decision-stage queries. FAQ section captures long-tail variants.', tags: [] },
          { text: 'Roundup/list content uses year + number in H1', detail: 'Pattern: "15 Best Queue Management Systems in 2026 (3 Are Free)". Signals freshness and specificity. Update the year annually or Google treats it as stale.', tags: [] },
        ]
      },
      {
        title: 'SEO Signals',
        items: [
          { text: 'FAQ schema implemented and validated', detail: 'SEDCO, Qwaiting, and ScanQueue use it. Wavetec and Qmatic don\'t — leaving SERP real estate unclaimed. 15 minutes per page.', tags: ['seo'] },
          { text: 'Pricing information is published on the page', detail: "ScanQueue's editorial criteria explicitly weights vendors with published pricing higher. Even a rough tier ('starts at $X/month') beats 'contact for quote.'", tags: ['seo'] },
          { text: 'Third-party review scores displayed', detail: 'Qwaiting displays 4.8 Capterra, 4.7 G2, 4.8 GetApp above the fold. WaitWell uses G2 award badges. Borrowed authority matters most when competing against established players.', tags: ['seo'] },
          { text: 'Quantified outcomes in case studies', detail: 'SEDCO: "reduce customer waiting time up to 40%," "registration time from 10-20 minutes to under 1 minute." Named institutional clients earn backlinks from press and news coverage.', tags: ['seo'] },
        ]
      },
      {
        title: 'Architecture',
        items: [
          { text: 'Informational pillar pages are separate from product pages', detail: "Qmatic's 'Guide to Queue Management Systems' is a dedicated 4,500-word educational resource at its own URL, separate from their product page. Waqtak's blog architecture is already correct.", tags: ['arch'] },
          { text: 'Industry depth has dedicated pages, not just bullet points', detail: 'SEDCO, Qmatic, and Wavetec each have dedicated solution pages per vertical. Homepage bullet points cannot replicate topical authority clusters. Waqtak already has industry pages — keep them deepened.', tags: ['arch'] },
        ]
      },
      {
        title: 'What to Ignore',
        items: [
          { text: 'Hardware queries are not worth competing for', detail: 'Kiosk, ticket dispenser, display screens, self-service check-in terminal. These are queries a pure SaaS product cannot and should not compete for.', reference: true },
          { text: "Longevity claims cannot be faked — compete on modernity instead", detail: '"40+ years of expertise" (SEDCO), "founded 1986" (Wavetec). Compete on: cloud-native, mobile-first, Arabic-first, GCC-specific. That\'s the angle no established player owns.', reference: true },
        ]
      },
    ]
  },

  {
    name: 'credibility', label: 'Credibility Gaps', position: 5,
    sections: [
      {
        title: 'Blocked on Abed',
        items: [
          { text: 'Named case studies (2-3 clients)', detail: 'Highest-impact item on this list. For each client: name, industry, deployment scale (branches/counters), one quantified outcome. Build a Case Studies page or embed in solution pages.', tags: ['rush','abed'] },
          { text: 'Product demo video', detail: '2-3 minute screen recording of the real dashboard in use (real interface, real data, not a slide deck). Embed on homepage and solution pages.', tags: ['high','abed'] },
          { text: 'G2 + Capterra client reviews', detail: 'Abed personally reaches out to 10-15 existing clients this week and asks for reviews. Time-sensitive: ChatGPT sources review platforms when evaluating vendors.', tags: ['high','abed'] },
          { text: 'agile.ps datasheet update', detail: "Third-party PDF at agile.ps is shaping how AI tools read Waqtak. If it's outdated or inaccurate, ask Abed whether Agile PS can update it.", tags: ['medium','abed'] },
        ]
      },
      {
        title: 'Assign to Website Sub-Project',
        items: [
          { text: 'Audit and fix AI/predictive claims sitewide', detail: 'Find every instance of "AI," "predictive," and "intelligent." For each: either add proof or rewrite to accurate language.', tags: ['rush','website'], done: true },
          { text: 'Strengthen traction signals on homepage', detail: '"9M+ tickets served" is on the site but not prominent enough. Move the strongest verifiable proof point into the hero or stats section.', tags: ['high','website'] },
        ]
      },
      {
        title: 'Quick Audit — You',
        items: [
          { text: 'App store audit', detail: "Check App Store and Google Play for Waqtak's customer-facing app. Note: current ratings, review count, and what negative reviews say.", tags: ['medium','you'] },
        ]
      },
      {
        title: 'Cannot Fix With Content Alone',
        items: [
          { text: 'F6S founding date (2022) is a public record', detail: "ChatGPT will always flag this. The only counter is overwhelming proof of operational scale — deployment numbers, client tenure, volume of tickets served.", reference: true },
          { text: 'App store ratings require product improvement or active solicitation', detail: "Website copy won't change what Google Play shows. Diagnose the root cause before deciding how to respond.", reference: true },
          { text: 'Third-party sources (agile.ps, F6S) are not fully in your control', detail: "ChatGPT cited both. Neither is a Waqtak property. The agile.ps datasheet is the more actionable one.", reference: true },
        ]
      },
    ]
  },
]

// ── Main ──────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('Signing in…')
  const { error: authError } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  if (authError) { console.error('Auth failed:', authError.message); process.exit(1) }

  const { data: { user } } = await supabase.auth.getUser()
  console.log(`Signed in as ${user.email}`)

  // Check if already seeded
  const { data: existing } = await supabase.from('projects').select('id').eq('user_id', user.id)
  if (existing?.length > 0) {
    console.log(`Found ${existing.length} existing projects. Delete them first if you want to re-seed.`)
    process.exit(0)
  }

  for (const proj of PROJECTS) {
    console.log(`\nCreating project: ${proj.name}`)
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .insert({ name: proj.name, user_id: user.id, position: proj.position, description: proj.label })
      .select()
      .single()
    if (projErr) { console.error('Project error:', projErr.message); continue }

    for (let si = 0; si < proj.sections.length; si++) {
      const sec = proj.sections[si]
      const { data: section, error: secErr } = await supabase
        .from('sections')
        .insert({ project_id: project.id, title: sec.title, position: si })
        .select()
        .single()
      if (secErr) { console.error('Section error:', secErr.message); continue }

      const taskRows = sec.items.map((item, ti) => ({
        user_id:    user.id,
        project_id: project.id,
        section_id: section.id,
        text:       item.text,
        detail:     item.detail || null,
        priority:   extractPriority(item.tags),
        tags:       [...cleanTags(item.tags || []), ...(item.reference ? ['reference'] : [])],
        done:       item.done || false,
        in_progress: false,
        position:   ti,
        updated_at: new Date().toISOString(),
        completed_at: item.done ? new Date().toISOString() : null,
      }))

      const { error: taskErr } = await supabase.from('tasks').insert(taskRows)
      if (taskErr) console.error('Task error in', sec.title, ':', taskErr.message)
      else console.log(`  ✓ ${sec.title} (${taskRows.length} tasks)`)
    }
  }

  console.log('\nSeed complete.')
}

seed().catch(console.error)
