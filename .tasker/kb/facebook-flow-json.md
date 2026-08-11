# Facebook Flow JSON

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

{
  "flow": {
    "name": "Facebook Post Flow",
    "prefix": "FB-F",
    "project": "WCC",
    "description": "Transform a blog article + image into a ready-to-publish Facebook post with optimized copy and visual",
    "input_contract": {
      "blog_article": "HTML or plaintext blog article (full text or URL)",
      "images": "1-3 image files (JPEG, PNG, WebP)"
    },
    "output_contract": {
      "facebook_post_copy": "80-150 word post (4-7 sentences, ready to paste)",
      "facebook_ready_images": "Facebook-optimized image files (1080px+ width, <500KB)",
      "ready_to_publish_folder": "Package with post copy + images + metadata"
    },
    "success_criteria": [
      "Post is 80–150 words",
      "Post follows 4–7 sentence structure (hook → context → stakes → CTA)",
      "Post uses second-person ('you') and conversational tone",
      "CTA is specific and includes benefit preview (not generic 'learn more')",
      "Image is Facebook-ready (correct dimensions, optimized file size)",
      "No editing needed; ready to publish as-is",
      "Ready-to-publish folder is organized and clearly labeled"
    ]
  },
  "tasks": [
    {
      "id": "FB-F-1",
      "title": "Extract key insights from blog article for Facebook post",
      "activeForm": "Extracting key insights from blog article",
      "description": "Pull the core problem, stakes, and benefit from the blog article",
      "input": "Blog article (full HTML/text)",
      "output": "Structured insights document (problem, context, stakes, benefit, headline, URL)",
      "instruction_set": {
        "overview": "Read the blog article and extract 5 key elements",
        "steps": [
          "Problem statement (1 sentence, under 20 words) - the core blind spot or operational failure",
          "Why it matters (1–2 sentences) - operational impact on branch operations/ops directors",
          "Stakes (1 sentence, max 15 words) - what happens if this problem persists",
          "Benefit/outcome (1 sentence, max 15 words) - what changes when this problem is addressed",
          "Article headline & URL - for CTA in the Facebook post"
        ]
      },
      "knowledge_base": {
        "title": "Facebook B2B audience and problem extraction",
        "content": [
          "Facebook B2B audience (ops directors, branch managers): they care about operational efficiency, cost avoidance, and visibility",
          "They're busy; respect their time (no fluff). They've heard many pitches; authenticity matters. They scan; make insights punchy and specific.",
          "Problem extraction: focus on emotional pain (frustration, blindness, loss) not just features",
          "Avoid jargon; use their real-world language. One problem per post (don't stack).",
          "Extract must be observable, measurable situation — not a feeling",
          "Why it matters must be specific to ops directors or branch operations (not generic CX)",
          "Stakes sentence must include a cost or consequence (not just 'important')",
          "Benefit is outcome-focused (what changes, not what you get)",
          "All extracted text must be verbatim or paraphrased from the article (no invention)"
        ]
      },
      "acceptance_rules": [
        "Problem statement is concrete, not abstract (observable, measurable situation — not a feeling)",
        "Why it matters is specific to ops directors or branch operations (not generic CX)",
        "Stakes sentence includes a cost or consequence (not just 'important')",
        "Benefit is outcome-focused (what changes, not what you get)",
        "All extracted text is verbatim or paraphrased from the article (no invention)"
      ]
    },
    {
      "id": "FB-F-2",
      "title": "Write Facebook post copy (80–150 words, 4–7 sentences)",
      "activeForm": "Writing Facebook post copy",
      "description": "Craft B2B Facebook post copy following best practices",
      "input": "Key insights from FB-F-1",
      "output": "Facebook post copy ready to paste (80-150 words, 4-7 sentences)",
      "instruction_set": {
        "overview": "Write a Facebook post using a 4-part structure",
        "structure": [
          "Hook (1 sentence): Problem statement as a fact, not a question. Use second-person ('You're probably...') to address reader directly. Tone: Empathetic, not alarmist.",
          "Context (2–3 sentences): Expand on why this matters to ops directors. Reference the real-world scenario. Show you understand their reality.",
          "Stakes (1 sentence): What happens if ignored. Make it concrete (cost, risk, missed opportunity).",
          "CTA (1 sentence): Action + benefit preview. Format: 'Read the full story — and [benefit]'. Benefit should match the stakes/outcome."
        ],
        "example": "Your branch manager just heard from 2 unhappy customers this week. They're not happy. But here's what keeps most ops directors up at night: those 2 are probably the only ones who actually complained. The other 24 who felt the same way? They just walked out the door. It's called silent churn, and it costs more than you think. Read the full story — and discover what actually works to catch them: [LINK]"
      },
      "knowledge_base": {
        "title": "Facebook B2B organic post best practices",
        "content": [
          "Sweet spot: 80–150 words (longer posts bury the CTA, shorter posts don't establish context)",
          "Sentence structure: Vary lengths (1 short, 2 medium, 2 long) to maintain rhythm",
          "Tone: Conversational, warm, empathetic (not corporate-speak)",
          "Perspective: Second-person ('you') builds connection; first-person ('we') distances",
          "CTA structure: Always '[Action] — and [benefit]' not just '[Action]'",
          "AVOID: Curiosity gaps ('You won't believe...' — kills trust on Facebook), Questions as hooks ('Did you know...?' — feels salesy), Vague CTAs ('Learn more' — doesn't sell the benefit), Multiple takeaways (one insight per post), Self-promotion ('We're proud to announce...' — Facebook users scroll past this)"
        ]
      },
      "acceptance_rules": [
        "Post is 80–150 words (count actual words)",
        "Has exactly 4–7 sentences (structure is clear)",
        "Hook is a fact statement, not a question",
        "Uses second-person ('you') or direct address",
        "Context section shows empathy before delivering problem",
        "Stakes sentence includes a concrete cost/consequence (not vague)",
        "CTA is specific and includes benefit preview (not 'click here' or 'learn more')",
        "No curiosity gaps or hidden CTAs",
        "Tone is conversational but professional (not corporate, not casual)",
        "Post can be pasted directly into Facebook with no editing needed"
      ]
    },
    {
      "id": "FB-F-3",
      "title": "Prepare image(s) for Facebook (dimensions, overlay, optimization)",
      "activeForm": "Preparing image for Facebook",
      "description": "Format provided image(s) for Facebook with text overlay (if needed) and verify dimensions",
      "input": "Image file(s) from user (JPEG, PNG, WebP; any dimension)",
      "output": "Facebook-ready image(s) with text overlay + metadata",
      "instruction_set": {
        "overview": "Format each image for Facebook and verify specifications",
        "steps": [
          "Check dimensions & aspect ratio: Facebook feed ideal is 1.2:1 (vertical/portrait) or 1.91:1 (wide). If landscape (>1.91:1), consider cropping to 1.2:1. If square (1:1), it works but vertical performs better.",
          "Assess text overlay opportunity: If image is from Carousel Master Template (has empty space for text), add ONE headline (max 8 words) as text overlay with white text, bold, 48–56px, positioned center or bottom-center with semi-transparent dark background. If image is plain/photographic (no text space), no overlay needed but verify contrast is strong.",
          "Export & optimize: Export as JPEG (Facebook compresses anyway). Resolution: 1200px on longest edge. File size: <500KB. Verify no watermarks, artifacts, or quality loss.",
          "Document image metadata: Filename: 'waqtak-facebook-{article-slug}-{version}.jpg'. Note final dimensions. Write one-sentence alt text describing the image."
        ]
      },
      "knowledge_base": {
        "title": "Facebook image specifications and best practices",
        "content": [
          "Facebook feed ideal aspect ratio: 1.2:1 (portrait) — takes up more vertical space, higher CTR",
          "Minimum recommended: 1080px on longest edge",
          "File formats: JPEG (best), PNG (heavier), WebP (best compression, less browser support)",
          "File size: 500KB max for fast loading",
          "Text on images: Minimum 20% of image area must be clear space (Facebook's guideline)",
          "Text overlay rules: ONE headline only (max 8 words, 48–56px bold), max 20% of image covered by text, always semi-transparent dark background behind text, use brand font (Univia Pro) or clean sans-serif, white text (highest contrast)",
          "Image source priority: (1) Carousel Master Template slide (already design-approved, branded), (2) Blog article inline image, (3) Generic Waqtak/Keylife branded imagery"
        ]
      },
      "acceptance_rules": [
        "Image dimensions verified (actual pixel dimensions noted)",
        "Aspect ratio is 1.2:1 or better (portrait or wide, not extreme)",
        "Image is at least 1080px on longest edge",
        "File is JPEG or PNG, <500KB",
        "If text overlay added: font is readable at mobile (small-screen test passed)",
        "If text overlay added: max 20% of image is covered (Facebook guideline)",
        "No watermarks, artifacts, or visible compression artifacts",
        "Alt text written (one sentence describing image content)",
        "Filename follows convention: 'waqtak-facebook-{slug}-{version}.jpg'"
      ]
    },
    {
      "id": "FB-F-4",
      "title": "Assemble final Facebook post (copy + image, ready to publish)",
      "activeForm": "Assembling final Facebook post",
      "description": "Combine post copy + image into a single ready-to-publish package",
      "input": "Post copy from FB-F-2 + image(s) from FB-F-3",
      "output": "Final Facebook post (copy + image in correct format, ready to paste into Facebook)",
      "instruction_set": {
        "overview": "Combine post copy and image into a ready-to-publish package",
        "steps": [
          "Create final post package: Post copy (from FB-F-2) at the top. Image file(s) listed below (with filename, dimensions, alt text). Link in post copy should read '[LINK: article-URL]' (user will paste actual URL at publish time).",
          "Format for easy publishing: Copy should be ready to paste directly into Facebook's composer. No formatting needed (Facebook will preserve line breaks). Image should be in a folder named 'waqtak-facebook-{article-slug}/'. Include a README.txt with: post copy, image alt texts, recommended posting time, hashtags (if any).",
          "Verification checklist: Post copy is 80–150 words. Post copy includes article link placeholder. Image(s) are in dedicated folder. Alt text provided for each image. File naming is consistent. No editing needed; ready to publish as-is.",
          "Deliver: Folder containing: image(s) + README.txt with post copy. Filename convention: 'waqtak-facebook-{article-slug}-ready/'. User can extract image + copy and paste directly into Facebook."
        ]
      },
      "knowledge_base": {
        "title": "Facebook publishing workflow and best practices",
        "content": [
          "Facebook publishing workflow: (1) User logs into Waqtak Facebook page, (2) Click 'Create Post', (3) Paste post copy into text area, (4) Upload image(s), (5) Set link (if CTA includes external link), (6) Review preview, (7) Choose posting time (Tuesday–Thursday, 9 AM–12 PM), (8) Publish",
          "Post assembly best practices: Include publishing recommendation (best day/time for B2B organic reach), Include hashtags (optional, but 3–5 relevant hashtags can boost reach if budget allows paid boost later), Document which slide of carousel master template was used (for consistency across posts)",
          "Recommended posting times: Tuesday–Thursday, 9 AM–12 PM (B2B office hours)",
          "Publishing frequency: 1 post per week (consistency signals activity without overwhelming feed)"
        ]
      },
      "acceptance_rules": [
        "Post copy is present and unchanged from FB-F-2",
        "Image file(s) are present and verified as Facebook-ready",
        "README.txt includes: post copy, image alt texts, recommended posting time",
        "Folder name follows convention: 'waqtak-facebook-{article-slug}-ready/'",
        "No additional editing needed; ready for immediate publishing",
        "Link placeholder is marked as '[LINK: article-URL]' (user fills in)"
      ]
    }
  ],
  "flow_level_kb": {
    "title": "Facebook B2B organic posting strategy",
    "content": [
      "One post per article (don't multi-post the same article)",
      "Post to company page (Waqtak)",
      "Publishing frequency: Once per week (Tuesday–Thursday, 9 AM–12 PM GMT+3 or user's timezone)",
      "Engagement signal: Company page should respond to comments within 24 hours",
      "Organic reach expectation: 500–2K impressions per post (highly variable based on page following)",
      "Link tracking: Use UTM parameters or Facebook link tracking to measure clicks back to article",
      "Content lifecycle: (1) Blog article published → (2) Run through FB-F flow → (3) Post to Facebook (organic) → (4) Monitor engagement (comments, shares, link clicks) → (5) Screenshot engagement for brand audit → (6) After 3–7 days, consider boosting with small budget ($5–20 USD) if engagement is strong"
    ]
  },
  "flow_level_is": {
    "title": "Facebook Post Flow Execution Instructions",
    "content": [
      "When to run this flow: After a blog article is published and has been live for 24+ hours. Once per article (each Waqtak blog post gets ONE Facebook post). Do not re-post the same article to Facebook multiple times (use different insights for follow-up posts).",
      "Running the flow: (1) Gather: Published blog article (URL) + 1–3 images (from article or carousel master template). (2) Start at FB-F-1: Feed the article into the extraction task. (3) Complete FB-F-1, submit for validation. (4) Proceed to FB-F-2: Write post copy (feeds from FB-F-1 insights). (5) Complete FB-F-2, submit for validation. (6) Proceed to FB-F-3: Prepare image(s). (7) Complete FB-F-3, submit for validation. (8) Proceed to FB-F-4: Assemble final post. (9) Output: Ready-to-publish folder with post copy + images. (10) User publishes to Facebook (copy + image, link filled in).",
      "Quality gate between tasks: Each task output must pass validation before proceeding to the next. If validation fails, return to the failing task, apply feedback, and resubmit. Do not proceed with low-quality output (post copy with vague CTAs, images with bad dimensions, etc.)."
    ]
  },
  "files_and_artifacts": {
    "inputs": [
      "Blog article (HTML or plaintext)",
      "Image(s) (JPEG, PNG, WebP)"
    ],
    "outputs": [
      "Folder: 'waqtak-facebook-{article-slug}-ready/'",
      "  ├── image.jpg (or multiple images)",
      "  └── README.txt (post copy + metadata)"
    ],
    "file_naming_convention": "waqtak-facebook-{article-slug}-{version}.jpg"
  },
  "next_steps_after_publishing": [
    "Monitor post engagement (comments, shares, link clicks) for 3–7 days",
    "Screenshot engagement metrics for brand audit",
    "Respond to comments within 24 hours",
    "Consider boosting with small budget ($5–20 USD) if engagement is strong",
    "Use link tracking (UTM or Facebook's parameter) to measure traffic back to article"
  ]
}

