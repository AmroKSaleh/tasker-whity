#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot generator for plugin/tests/Contract/original-tool-schemas.json —
    the committed snapshot of the ORIGINAL Tasker app's MCP tool contracts.

.DESCRIPTION
    Run manually, commit the result. This is NOT part of the test run: the
    parity test reads the committed JSON so it stays hermetic and CI-runnable
    (CI has neither the design repo nor a live MCP host).

        powershell -NoProfile -ExecutionPolicy Bypass -File host/scripts/extract-original-schemas.ps1

    THREE SOURCES, IN DESCENDING ORDER OF TRUST — read this before trusting the
    output:

    1. The LIVE original MCP server. Authoritative. Five tool definitions were
       captured from it by hand on 2026-08-11 and are applied below as
       $LiveOracleCorrections / $LiveOnlyToolNames. Task 11 established the rule
       the hard way: the original app's own in-app docs page
       (app/src/docs/contentMcpV2.js) CONTRADICTS its live server, so nothing in
       the design repo is trusted by default.

    2. The design repo's edge function, c:\Projects\tasker\V2\supabase\functions
       \mcp\index.ts. The real deployed source — but a SNAPSHOT of it. Verified
       stale as of this writing (design-repo HEAD 2f1826ea, 2026-07-18):
         - It carries 131 tools. The live server carries 143.
         - update_task is missing `tags` and `current_state`.
         - create_task is missing `tags`.
       Every tool it DOES carry is still live, and no tool it carries has been
       removed — the drift observed is purely additive. That is what makes it
       usable as a floor, once corrected by (1).

    3. app/src/docs/contentMcpV2.js — NOT USED. Known wrong (see Task 11).

    The extraction itself evaluates the file's `const TOOLS = [...]` literal in
    a Node VM sandbox rather than regex-scraping it. The array is 1600+ lines of
    nested object literals with escaped quotes and em-dashes in every
    description; a regex parser would be the least trustworthy link in a chain
    whose entire purpose is trustworthiness. Node evaluates the same literal the
    Deno runtime does. Only the declarations TOOLS actually references are
    pulled in with it (RULE_SCHEMA, CONTRACT_SCHEMA, and the two string-list
    constants), so nothing in the file executes.

.PARAMETER DesignRepo
    Root of the design repo holding the original edge function.

.PARAMETER Out
    Destination JSON path. Defaults to the committed fixture.
#>
param(
    [string]$DesignRepo = 'c:\Projects\tasker',
    [string]$Out
)

$ErrorActionPreference = 'Stop'

$hostDir  = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $hostDir

if (-not $Out) {
    $Out = Join-Path $repoRoot 'plugin\tests\Contract\original-tool-schemas.json'
}

$indexTs = Join-Path $DesignRepo 'V2\supabase\functions\mcp\index.ts'
if (-not (Test-Path $indexTs)) {
    throw "Original MCP edge function not found at $indexTs - pass -DesignRepo <path>"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node is required (the TOOLS literal is evaluated, not regex-scraped)'
}

# Provenance: which revision of the design repo this snapshot came from, so a
# future reader can tell whether re-running would change anything.
$sourceCommit = 'unknown'
$sourceDate   = 'unknown'
try {
    Push-Location $DesignRepo
    $sourceCommit = (git log -1 --format='%H' -- 'V2/supabase/functions/mcp/index.ts') 2>$null
    $sourceDate   = (git log -1 --format='%cI' -- 'V2/supabase/functions/mcp/index.ts') 2>$null
} catch {
    # A design repo without git history is not a reason to fail the extraction.
} finally {
    Pop-Location
}
if (-not $sourceCommit) { $sourceCommit = 'unknown' }
if (-not $sourceDate)   { $sourceDate   = 'unknown' }

# ── The live-server oracle ────────────────────────────────────────────────────
#
# Captured by hand from the ORIGINAL app's LIVE MCP server on 2026-08-11 and
# applied on top of the extraction. Each entry names a property the live server
# declares that index.ts does not. Do NOT add anything here that was not read
# off the live server: this table is the only part of the snapshot that is not
# mechanically reproducible, so its provenance has to stay exact.
#
# COMPLETENESS IS BOUNDED BY WHAT WAS HAND-CAPTURED. This table can only correct
# tools somebody actually read off the live server. The extractor throws when a
# correction becomes REDUNDANT (index.ts caught up), but it cannot detect a
# correction that was never written — so a tool nobody captured stays silently
# short. Coverage so far: all 36 tools shared with this plugin were compared
# against the live server during Task 12's review; 35 matched and list_tasks did
# not. The 95 unported tools have NOT been compared and may be short too. That is
# tolerable only because nothing measures against them yet.
$liveOracleCorrections = @'
[
  { "tool": "create_task", "property": "tags",
    "schema": { "type": "array", "items": { "type": "string" } },
    "note": "Live server declares tags on create_task; index.ts (2026-07-18) has no tags anywhere." },
  { "tool": "update_task", "property": "tags",
    "schema": { "type": "array", "items": { "type": "string" } },
    "note": "Live server declares tags on update_task; index.ts has no tags anywhere." },
  { "tool": "update_task", "property": "current_state",
    "schema": { "type": "string" },
    "note": "Live server declares current_state on update_task; the string does not occur in index.ts at all." },

  { "tool": "list_tasks", "property": "flow_id", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks (Task 12 review, all-36-tool comparison). Name captured, shape not." },
  { "tool": "list_tasks", "property": "gate_status", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks. Name captured, shape not - likely carries an enum, so the enum check cannot run for it." },
  { "tool": "list_tasks", "property": "blocking", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks. Name captured, shape not." },
  { "tool": "list_tasks", "property": "phase_id", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks - part of the phases feature that post-dates index.ts entirely (see liveOnlyToolNames)." },
  { "tool": "list_tasks", "property": "cursor", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks. Name captured, shape not." },
  { "tool": "list_tasks", "property": "limit", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks. Name captured, shape not." },
  { "tool": "list_tasks", "property": "sort", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks. Name captured, shape not - likely carries an enum, so the enum check cannot run for it." },
  { "tool": "list_tasks", "property": "updated_since", "schema": { "description": "NAME ONLY - shape not captured." },
    "note": "Live-only on list_tasks. Name captured, shape not." }
]
'@

# Tools the LIVE server exposes that index.ts does not define at all. Their
# input schemas are unknown (no live capture was taken), so they are recorded as
# NAMES ONLY and counted by the unported-surface test rather than compared
# property-by-property. If a later slice ports one of these, that test fails and
# forces someone to capture the real schema before the port can be called done —
# which is the correct outcome, not an inconvenience.
$liveOnlyToolNames = @'
[
  "add_task_link", "create_phase", "delete_phase", "get_flow_exceptions",
  "get_project_delta", "get_task_history", "list_phases", "post_project_update",
  "resolve_reference", "set_active_phase", "set_task_phase", "update_phase"
]
'@

$extractor = @'
import fs from 'node:fs';
import vm from 'node:vm';

const [srcPath, outPath, correctionsPath, liveOnlyPath, sourceCommit, sourceDate] = process.argv.slice(2);
const src = fs.readFileSync(srcPath, 'utf8');
const correctionsJson = fs.readFileSync(correctionsPath, 'utf8');
const liveOnlyJson = fs.readFileSync(liveOnlyPath, 'utf8');

/**
 * Slice out `const NAME = <open>...<close>` by bracket matching, skipping over
 * string literals (single, double, template) and line comments so a brace or
 * bracket inside a description never terminates the slice early.
 */
function extractDecl(text, name, open, close) {
  const marker = `const ${name} = ${open}`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`declaration not found: ${name}`);
  let i = start + marker.length - 1;
  let depth = 0, inStr = null, esc = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error(`unbalanced ${open}${close} while reading ${name}`);
  return text.slice(start, i);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  extractDecl(src, 'RULE_SCHEMA', '{', '}'),
  extractDecl(src, 'CONTRACT_SCHEMA', '{', '}'),
  extractDecl(src, 'KB_CATEGORIES', '[', ']'),
  extractDecl(src, 'FOUNDATION_ORDER', '[', ']'),
  extractDecl(src, 'TOOLS', '[', ']'),
  'globalThis.__TOOLS = TOOLS;',
].join('\n'), ctx);

const tools = {};
for (const t of ctx.__TOOLS) {
  if (!t || typeof t.name !== 'string') throw new Error('a TOOLS entry has no name');
  if (tools[t.name]) throw new Error(`duplicate tool name in TOOLS: ${t.name}`);
  tools[t.name] = t.inputSchema ?? { type: 'object' };
}

const corrections = JSON.parse(correctionsJson);
for (const c of corrections) {
  const schema = tools[c.tool];
  if (!schema) throw new Error(`live-oracle correction targets an unknown tool: ${c.tool}`);
  schema.properties = schema.properties || {};
  if (schema.properties[c.property]) {
    throw new Error(
      `live-oracle correction for ${c.tool}.${c.property} is STALE - index.ts now declares it. ` +
      'Re-verify against the live server and drop the correction.'
    );
  }
  schema.properties[c.property] = c.schema;
}

const liveOnly = JSON.parse(liveOnlyJson);
for (const n of liveOnly) {
  if (tools[n]) throw new Error(`${n} is listed as live-only but index.ts defines it - the list is stale`);
}

const sorted = {};
for (const k of Object.keys(tools).sort()) sorted[k] = tools[k];

const doc = {
  _meta: {
    generatedBy: 'host/scripts/extract-original-schemas.ps1',
    doNotEditByHand: 'Re-run the generator instead; the live-oracle corrections live in it.',
    source: 'c:/Projects/tasker/V2/supabase/functions/mcp/index.ts (design repo, the original app\u2019s deployed MCP edge function)',
    sourceCommit,
    sourceCommitDate: sourceDate,
    extractedAt: new Date().toISOString(),
    toolsFromSource: Object.keys(sorted).length,
    liveOnlyToolCount: liveOnly.length,
    originalSurfaceSize: Object.keys(sorted).length + liveOnly.length,
    sourceIsStale:
      'index.ts is a SNAPSHOT and is behind the live server. Verified 2026-08-11: 131 tools here vs 143 live; ' +
      'the 12 extra live names are in liveOnlyToolNames; update_task/create_task were missing tags and ' +
      'current_state, and list_tasks was missing 8 properties - all applied from the live oracle (see ' +
      'liveOracleCorrections). The drift observed was purely additive - no tool or property present here has been ' +
      'removed upstream - so this file is a FLOOR on the original\u2019s surface, not an exact image of it.',
    correctionCoverage:
      'THE FLOOR IS ONLY AS COMPLETE AS THE HAND CAPTURE. liveOracleCorrections can only fix tools somebody read ' +
      'off the live server; the generator throws when a correction becomes redundant but CANNOT detect one that ' +
      'was never written, so an uncaptured tool stays silently short. Compared against the live server so far: all ' +
      '36 tools shared with this plugin (35 matched; list_tasks did not). NOT compared: the 95 unported tools here ' +
      'and the 12 in liveOnlyToolNames, whose schemas were never captured at all. Treat a tool outside the shared ' +
      '36 as unverified until someone compares it.',
    liveOracleCorrections: corrections,
  },
  tools: sorted,
  liveOnlyToolNames: liveOnly,
};

fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
process.stderr.write(`tools from source: ${Object.keys(sorted).length}\n`);
process.stderr.write(`live-only names:   ${liveOnly.length}\n`);
process.stderr.write(`wrote ${outPath}\n`);
'@

# The two JSON payloads go to disk rather than onto the command line: passing a
# quote-bearing string to a native executable makes PowerShell strip the inner
# double quotes, which turns valid JSON into a parse error at the far end.
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)
$tempDir    = [System.IO.Path]::GetTempPath()
$stamp      = [guid]::NewGuid()
$tempJs     = Join-Path $tempDir ("extract-original-schemas-{0}.mjs" -f $stamp)
$tempFix    = Join-Path $tempDir ("extract-original-corrections-{0}.json" -f $stamp)
$tempLive   = Join-Path $tempDir ("extract-original-liveonly-{0}.json" -f $stamp)
try {
    # UTF-8 without BOM: node treats a BOM at the head of an ESM file as a parse error.
    [System.IO.File]::WriteAllText($tempJs, $extractor, $utf8NoBom)
    [System.IO.File]::WriteAllText($tempFix, $liveOracleCorrections, $utf8NoBom)
    [System.IO.File]::WriteAllText($tempLive, $liveOnlyToolNames, $utf8NoBom)

    $outDir = Split-Path -Parent $Out
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

    & node $tempJs $indexTs $Out $tempFix $tempLive $sourceCommit $sourceDate
    if ($LASTEXITCODE -ne 0) { throw "extraction failed with exit code $LASTEXITCODE" }
}
finally {
    Remove-Item $tempJs, $tempFix, $tempLive -ErrorAction SilentlyContinue
}
