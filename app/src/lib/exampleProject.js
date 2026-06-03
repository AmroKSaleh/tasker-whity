export const EXAMPLE_PROJECT = {
  name: 'product-launch-campaign',
  description: 'Product Launch Campaign',
  sections: [
    {
      title: 'Market Research',
      groups: [
        {
          name: 'Competitor Analysis',
          tasks: [
            {
              text: 'Map out top 5 competitors',
              priority: 'high',
              focus: {
                reason: "Understanding who else is playing this game shapes every positioning decision you'll make. Do this before you build anything.",
                steps: [
                  { summary: 'Search for direct competitors', detail: 'Google your core value proposition. Who else shows up? Check Product Hunt, G2, and App Store searches too.' },
                  { summary: 'Build a comparison table', detail: 'For each competitor: name, pricing, core feature, and who they target. A simple spreadsheet works fine.' },
                  { summary: 'Use each product for 10 minutes', detail: 'Sign up for free trials. Actually using the product reveals things no review will tell you.' },
                  { summary: 'Identify where they are weak', detail: 'Note what customers complain about in reviews. One-star reviews on G2 or the App Store are a goldmine.' },
                  { summary: 'Summarize the gap', detail: "Write one sentence on the gap your product will fill that competitors aren't addressing." },
                ],
              },
            },
            { text: 'Note their pricing and positioning', priority: 'medium' },
            {
              text: 'Identify gaps in the market',
              priority: 'high',
              focus: {
                reason: "Gaps in the market are the only spaces where a new product can win. If you don't find yours now, your positioning will be generic.",
                steps: [
                  { summary: 'Review your competitor table', detail: 'Look at the features, pricing, and target audiences you mapped. Where are the whitespace areas?' },
                  { summary: 'Read negative reviews of competitors', detail: 'One-star reviews tell you exactly what the market wants and is not getting. Collect the most common complaints.' },
                  { summary: 'List underserved customer segments', detail: 'Who is using competitor products but complaining the most? That is often a segment being poorly served.' },
                  { summary: 'Identify missing features', detail: 'What workflow do customers do manually because no tool handles it? That manual workaround is often a product opportunity.' },
                  { summary: 'Write a gap statement', detail: "One sentence: 'No current product does X well for Y type of customer.' That is your opening." },
                ],
              },
            },
          ],
        },
        {
          name: 'Customer Insights',
          tasks: [
            {
              text: 'Interview 5 potential customers',
              priority: 'rush',
              focus: {
                reason: "You can't build what people don't want. Without real customer voices this early, every decision downstream is a guess.",
                steps: [
                  { summary: 'Identify who to talk to', detail: 'List 5–10 people who match your target audience. Look in your network first — LinkedIn, Slack communities, or past colleagues in the space.' },
                  { summary: 'Write your interview script', detail: 'Prepare 5–7 open-ended questions focused on their current problems, not your solution. Avoid leading questions.' },
                  { summary: 'Book the interviews', detail: 'Send short, direct messages explaining what you are building and asking for 20 minutes. A calendar link removes friction.' },
                  { summary: 'Run each interview', detail: 'Listen more than you talk. Take notes on exact words they use — those phrases will sharpen your messaging later.' },
                  { summary: 'Synthesize the findings', detail: 'After all 5 interviews, look for recurring themes. Write a one-paragraph summary of the core pain point that kept coming up.' },
                ],
              },
            },
            { text: 'Create user persona profiles', priority: 'medium' },
            {
              text: 'Define core pain points to address',
              priority: 'high',
              focus: {
                reason: "Every feature, message, and decision in this project should trace back to a specific pain. If you can't name it clearly, your product will be vague.",
                steps: [
                  { summary: 'Pull your interview notes together', detail: 'Read through every interview note you took. Look for moments where frustration, time loss, or cost came up.' },
                  { summary: 'List raw pain statements', detail: 'Write down the exact words customers used to describe their problems. Do not paraphrase yet.' },
                  { summary: 'Group into themes', detail: 'Cluster similar complaints together. You are looking for 2–4 core themes that came up repeatedly.' },
                  { summary: 'Rank by frequency and intensity', detail: 'Which pain came up most often? Which caused the most frustration? The intersection of both is your priority.' },
                  { summary: 'Write your pain statement', detail: "Draft a one-sentence problem statement: 'People who do X struggle with Y, which causes Z.' This becomes your north star." },
                ],
              },
            },
          ],
        },
      ],
      tasks: [],
    },
    {
      title: 'Product Development',
      groups: [
        {
          name: 'MVP Features',
          tasks: [
            {
              text: 'Finalize feature list for v1',
              priority: 'rush',
              focus: {
                reason: "Everything in development depends on this list being locked. Scope creep kills launches — committing to v1 features now keeps the timeline real.",
                steps: [
                  { summary: 'List all candidate features', detail: "Dump every feature idea you have. Don't filter yet — get them all visible in one place." },
                  { summary: "Apply the must/should/won't filter", detail: "Mark each feature: must have for launch, should have if time allows, or won't ship in v1. Be ruthless." },
                  { summary: "Cut everything below must-have", detail: 'Remove should-have items from the v1 list. Create a v2 backlog for them so they are not lost.' },
                  { summary: 'Validate against customer insights', detail: 'Check your finalized list against the pain points from your customer interviews. Every must-have should directly address a real problem.' },
                  { summary: 'Write it down and lock it', detail: 'Document the final v1 feature list somewhere visible. Share it with anyone involved. This is now the contract.' },
                ],
              },
            },
            {
              text: 'Build core functionality',
              priority: 'high',
              focus: {
                reason: "The feature list is locked — now the only thing that matters is shipping working software. Every day of delay is a day your competitors have the market.",
                steps: [
                  { summary: 'Break features into dev tasks', detail: 'Take each must-have feature and break it into specific engineering tasks. Nothing should take more than a day or two each.' },
                  { summary: 'Start with the user-facing core', detail: 'Build the thing users will touch first. Getting the primary flow working gives you something to test and show early.' },
                  { summary: 'Build vertically, not horizontally', detail: 'Finish one feature end-to-end before starting the next. Avoid building infrastructure in isolation.' },
                  { summary: 'Test as you go', detail: "After each feature, test it yourself. Don't save QA for the end — bugs found early are 10x cheaper to fix." },
                  { summary: 'Commit and document daily', detail: "End each day with a commit and a one-line note on what changed. You'll thank yourself during launch week." },
                ],
              },
            },
            {
              text: 'Internal testing and bug fixes',
              priority: 'high',
              focus: {
                reason: "A buggy launch is worse than a late one. Finding and fixing critical issues now costs a fraction of what it will after real users encounter them.",
                steps: [
                  { summary: 'Write a test script for the core flow', detail: 'Document the exact steps a new user takes from landing on your product to completing the main action. Test this completely.' },
                  { summary: 'Test on multiple devices', detail: 'Use at least two browsers and a mobile device. Most bugs hide in device and browser differences.' },
                  { summary: 'Log every issue you find', detail: 'Write down every bug, no matter how small. Categorize as critical (blocks core flow) or minor (everything else).' },
                  { summary: 'Fix all critical bugs first', detail: 'Do not ship with anything that blocks the main user journey. Minor visual issues are acceptable — broken core flows are not.' },
                  { summary: 'Do a final clean run-through', detail: 'After fixing critical bugs, run the entire test script one more time from scratch. Only sign off when it passes completely.' },
                ],
              },
            },
          ],
        },
        {
          name: 'Design',
          tasks: [
            { text: 'Create wireframes for main screens', priority: 'medium' },
            { text: 'Design final UI with brand colors', priority: 'medium' },
            { text: 'Prepare marketing assets', priority: 'low' },
          ],
        },
      ],
      tasks: [],
    },
    {
      title: 'Marketing & Outreach',
      groups: [],
      tasks: [
        {
          text: 'Write launch announcement copy',
          priority: 'high',
          focus: {
            reason: "Your announcement is the first impression for everyone who hasn't heard of you yet. Weak copy means a quiet launch — this deserves real attention.",
            steps: [
              { summary: 'Write for one person, not everyone', detail: 'Picture your ideal customer reading this. Write to them specifically, not to a generic audience.' },
              { summary: 'Lead with the problem, not the product', detail: 'Start with the pain your customer feels, then introduce your solution as the answer. Never lead with features.' },
              { summary: 'Write three versions of the headline', detail: 'Try a direct version, a curiosity version, and a bold claim version. Pick the one that makes you feel something.' },
              { summary: 'Add social proof if you have it', detail: 'Even one beta user quote adds more credibility than five feature bullets. If you have it, use it.' },
              { summary: 'End with one clear action', detail: 'One CTA only. Not a newsletter signup AND a demo AND a follow. Pick the most important next step and ask for only that.' },
            ],
          },
        },
        {
          text: 'Build email waitlist landing page',
          priority: 'high',
          focus: {
            reason: "Every person you tell about this product needs somewhere to go. A live page with a signup form means no interested person slips through the cracks.",
            steps: [
              { summary: 'Write the headline first', detail: 'The headline is 80% of the page. It should name the problem and hint at the solution in one line.' },
              { summary: 'Add a subheadline with the payoff', detail: 'One sentence on what the user gets and why it is different. No jargon.' },
              { summary: 'Keep the page to one screen', detail: 'Above the fold should have: headline, subheadline, email input, and a submit button. Nothing else is required.' },
              { summary: 'Set up email capture', detail: 'Use Mailchimp, ConvertKit, or a simple form. Make sure submitted emails actually land somewhere you can access.' },
              { summary: 'Publish and test the flow', detail: 'Submit your own email to test the full journey. Check the confirmation message and that your email arrived in the tool.' },
            ],
          },
        },
        { text: 'Schedule social media posts', priority: 'medium' },
        {
          text: 'Reach out to 10 potential early adopters',
          priority: 'rush',
          focus: {
            reason: "Early adopters are your launch amplifiers. Getting 10 committed before you ship means day-one momentum instead of silence.",
            steps: [
              { summary: 'Define your ideal early adopter', detail: 'Write a one-sentence profile: who feels the pain most acutely and is willing to try something new? Use your interview findings.' },
              { summary: 'Build a list of 20 candidates', detail: 'You need 20 to get 10 to say yes. Search LinkedIn, communities, Twitter, and your existing network.' },
              { summary: 'Write a personal outreach message', detail: 'Keep it to 3 sentences: the problem you are solving, that you are launching soon, and a specific ask. No pitch decks.' },
              { summary: 'Send messages in batches', detail: 'Send 5–7 per day. Track responses in a simple spreadsheet — yes, no, and follow-up needed.' },
              { summary: 'Follow up once', detail: 'If no reply after 5 days, send one follow-up. If still no reply, move on to the next name on your list.' },
            ],
          },
        },
        { text: 'Prepare press kit', priority: 'low' },
      ],
    },
    {
      title: 'Launch Day',
      groups: [],
      tasks: [
        {
          text: 'Publish product page',
          priority: 'rush',
          focus: {
            reason: "Everything you have built until now points here. The product page is where interest becomes action — it has to be live before anything else.",
            steps: [
              { summary: 'Do a final copy review', detail: 'Read every word on the page out loud. Fix anything that sounds like marketing-speak. Clear beats clever.' },
              { summary: 'Test all links and CTAs', detail: 'Click every button, form, and link. Make sure the primary call-to-action works and routes correctly.' },
              { summary: 'Check on mobile', detail: 'Open the page on your phone. Most visitors will see it on mobile first — font sizes, buttons, and images need to work.' },
              { summary: 'Set the page to live', detail: 'Remove any coming-soon gate or draft status. Double-check the URL is correct and accessible without login.' },
              { summary: 'Take a screenshot for the record', detail: "Capture the live page at launch. You'll want to look back at this — and it's useful for social posts." },
            ],
          },
        },
        {
          text: 'Send launch email to waitlist',
          priority: 'rush',
          focus: {
            reason: "Your waitlist signed up because they want this. This email is the payoff of every person you asked to wait — don't let it sit in drafts.",
            steps: [
              { summary: 'Review the email one last time', detail: 'Check subject line, preview text, and body. The subject line is the most important word you will write today.' },
              { summary: 'Send a test to yourself', detail: 'Send to your own email and open it on mobile. Look for broken formatting, clipped text, or missing links.' },
              { summary: 'Verify the product page is live', detail: 'Do not send until the page works. Click the main link in the email yourself before hitting send.' },
              { summary: 'Send to your full list', detail: "Hit send. Don't overthink it — a slightly imperfect email that goes out beats a perfect one that doesn't." },
              { summary: 'Monitor open rates and clicks', detail: 'Check your email platform dashboard after 30 minutes. Follow up personally with the most engaged people.' },
            ],
          },
        },
        {
          text: 'Post on relevant communities',
          priority: 'high',
          focus: {
            reason: "Communities are where your early adopters are already gathered. A well-timed, genuine post here can drive more day-one signups than any ad spend.",
            steps: [
              { summary: 'List your target communities', detail: 'Identify 5–8 communities where your target users spend time: Reddit, Hacker News, Slack groups, Discord servers, or niche forums.' },
              { summary: "Read each community's rules", detail: 'Nothing kills launch momentum like a removed post. Check rules before posting — especially around self-promotion.' },
              { summary: 'Write a community-specific post', detail: 'Do not paste the same text everywhere. Each community has a different tone. Show you are a real member, not just a promoter.' },
              { summary: 'Post at peak hours', detail: 'Most communities are most active on weekday mornings. Check each platform\'s analytics if available.' },
              { summary: 'Respond to every comment', detail: 'Engagement drives visibility in most platforms. Reply to every comment within the first hour — it signals the post is active.' },
            ],
          },
        },
        {
          text: 'Monitor feedback and bug reports',
          priority: 'high',
          focus: {
            reason: "The first hours after launch are the most information-dense of your entire project. What users do and say now shapes every next decision.",
            steps: [
              { summary: 'Set up your monitoring channels', detail: 'Know where feedback will come from: email, community posts, in-app forms, social mentions. Have all tabs open before launch.' },
              { summary: 'Create a feedback log', detail: 'Use a spreadsheet or doc to capture every piece of feedback in real time. Do not rely on memory or email search later.' },
              { summary: 'Tag issues by type', detail: 'Label each item: bug, UX confusion, feature request, or positive feedback. Patterns will emerge fast.' },
              { summary: 'Fix critical bugs immediately', detail: 'If something is blocking users from completing the core action, drop everything and fix it. Communicate the fix publicly.' },
              { summary: 'Write a launch-day summary', detail: 'At the end of day one, write a brief summary of what you heard. This will directly inform your next sprint.' },
            ],
          },
        },
        { text: 'Write post-launch retrospective', priority: 'low' },
      ],
    },
  ],
}
