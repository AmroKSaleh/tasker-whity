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

    1. The LIVE original MCP server. Authoritative. Was ahead of the design
       repo as of 2026-08-11, when eleven properties across three tools were
       captured from it by hand and applied as $LiveOracleCorrections, plus
       twelve tool names it exposed that the design repo did not yet define
       at all ($LiveOnlyToolNames). Task 11 established the rule the hard
       way: the original app's own in-app docs page
       (app/src/docs/contentMcpV2.js) CONTRADICTS its live server, so nothing
       in the design repo is trusted by default.

       RESOLVED 2026-08-13: the design repo merged up to current upstream
       (Xardoxis/tasker) and now matches the live server's tool count exactly
       (143). Every one of the eleven corrections tripped the generator's own
       staleness throw — proof index.ts now declares them for real — and both
       tables below are empty as a result. See original-tool-schemas.json's
       `_meta` for the current provenance statement.

    2. The design repo's edge function, now at
       c:\Projects\tasker\supabase\functions\mcp\index.ts — PATH MOVED
       2026-08-13, see the code below for why. The real deployed source. As
       of sourceCommit this is a faithful, wholesale image of the live
       server's tool surface (verified by name-count, not by re-diffing every
       property of every tool — see `_meta.correctionCoverage` in the output
       for the exact boundary of what "verified" means here).

    3. app/src/docs/contentMcpV2.js — NOT USED. Known wrong (see Task 11).

    The extraction itself evaluates the file's `const TOOLS = [...]` literal in
    a Node VM sandbox rather than regex-scraping it. The array is 1600+ lines of
    nested object literals with escaped quotes and em-dashes in every
    description; a regex parser would be the least trustworthy link in a chain
    whose entire purpose is trustworthiness. Node evaluates the same literal the
    Deno runtime does. Only the declarations TOOLS actually references are
    pulled in with it (RULE_SCHEMA, CONTRACT_SCHEMA, the two string-list
    constants, and — since the 2026-08-13 re-sync, when TOOLS started
    interpolating them into a couple of `limit` descriptions —
    DEFAULT_PAGE_SIZE and MAX_PAGE_SIZE), so nothing in the file executes.

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

# PATH MOVED 2026-08-13: upstream (Xardoxis/tasker) retired v1 and flattened
# V2/ to the repo root, so the old V2\supabase\... path is gone. The design
# repo has since been merged up to that upstream state. If a future upstream
# reorg moves it again, `git log --follow` below will not help (it only
# tracks the CURRENT path's history) - re-locate the file by name first.
$indexTs = Join-Path $DesignRepo 'supabase\functions\mcp\index.ts'
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
    $sourceCommit = (git log -1 --format='%H' -- 'supabase/functions/mcp/index.ts') 2>$null
    $sourceDate   = (git log -1 --format='%cI' -- 'supabase/functions/mcp/index.ts') 2>$null
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
#
# 2026-08-13 RE-SYNC: every one of the 11 corrections that used to live here
# (create_task.tags, update_task.tags, update_task.current_state, and 8
# NAME-ONLY list_tasks properties) is now REDUNDANT — the generator's own
# staleness throw fired for each in turn as it was re-run against the
# current index.ts, confirming the live server and git are back in
# agreement. That is the success condition this table exists to detect, not
# a failure: see original-tool-schemas.json's _meta for what each one
# resolved to. The table is intentionally empty; do not repopulate it
# without a fresh, hand-verified live-server capture (see the THREE SOURCES
# note above this variable's own history for why that bar is high).
$liveOracleCorrections = @'
[]
'@

# Tools the LIVE server exposes that index.ts does not define at all. Their
# input schemas are unknown (no live capture was taken), so they are recorded as
# NAMES ONLY and counted by the unported-surface test rather than compared
# property-by-property. If a later slice ports one of these, that test fails and
# forces someone to capture the real schema before the port can be called done —
# which is the correct outcome, not an inconvenience.
#
# 2026-08-13 RE-SYNC: all 12 names formerly here (add_task_link, create_phase,
# delete_phase, get_flow_exceptions, get_project_delta, get_task_history,
# list_phases, post_project_update, resolve_reference, set_active_phase,
# set_task_phase, update_phase) are now DEFINED in index.ts for real — the
# extractor's own "listed as live-only but index.ts defines it" guard caught
# all 12 and forced this list empty. They now flow through as ordinary
# extracted tools with real schemas instead of names-only.
$liveOnlyToolNames = @'
[]
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

/**
 * Slice out a single-line `const NAME = <literal>` declaration verbatim (no
 * bracket matching needed - the value ends at the line break). Added when the
 * 2026-08-13 re-sync found TOOLS now interpolates DEFAULT_PAGE_SIZE /
 * MAX_PAGE_SIZE into a couple of `limit` property descriptions; those two are
 * plain numeric consts, not nested literals, so extractDecl's bracket-matcher
 * does not apply and would be overkill for a bare number.
 */
function extractScalarConst(text, name) {
  const marker = `const ${name} = `;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`declaration not found: ${name}`);
  const lineEnd = text.indexOf('\n', start);
  return text.slice(start, lineEnd < 0 ? text.length : lineEnd);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  extractScalarConst(src, 'DEFAULT_PAGE_SIZE'),
  extractScalarConst(src, 'MAX_PAGE_SIZE'),
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
    source: 'c:/Projects/tasker/supabase/functions/mcp/index.ts (design repo, the original app\u2019s deployed MCP edge function; path moved here 2026-08-13 when upstream retired v1 and flattened V2/ to the repo root)',
    sourceCommit,
    sourceCommitDate: sourceDate,
    extractedAt: new Date().toISOString(),
    toolsFromSource: Object.keys(sorted).length,
    liveOnlyToolCount: liveOnly.length,
    originalSurfaceSize: Object.keys(sorted).length + liveOnly.length,
    sourceIsStale:
      'RESOLVED 2026-08-13. index.ts was a stale snapshot (131 tools vs 143 live) until the design repo was merged ' +
      'up to current upstream (Xardoxis/tasker, 46 commits); it now declares all 143 tool names the live server ' +
      'reported, so liveOnlyToolNames is empty and every liveOracleCorrections entry (update_task.tags, ' +
      'update_task.current_state, create_task.tags, and 8 list_tasks NAME-ONLY properties) tripped the generator\u2019s ' +
      'own staleness throw in turn and was removed - index.ts now declares all of them directly. This file is an ' +
      'exact image of index.ts at sourceCommit, not a hand-corrected floor.',
    correctionCoverage:
      'PROVENANCE, POST RE-SYNC: this snapshot is extracted WHOLESALE from index.ts at sourceCommit, not hand-patched ' +
      '- liveOracleCorrections is empty because nothing here needed a manual fix. Cross-checked against the live ' +
      'server on tool COUNT only: 143 unique names in TOOLS here matches the 143 the live server reported during the ' +
      'last slice, with none appearing on one side and not the other. That is coarser than the old per-tool hand ' +
      'capture (which compared the 36 shared tools\u2019 full argument shapes against the live server one property at a ' +
      'time): a name-count match proves no tool was added or dropped between git and the deployed surface, but not ' +
      'that every property of every one of the 107 unported tools is byte-identical to what the live server would ' +
      'return for it. Treat an unported tool\u2019s exact shape as unverified until someone compares it directly.',
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
