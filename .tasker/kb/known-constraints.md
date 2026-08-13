# Known Constraints

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Known Constraints

- **No Docker**: Supabase CLI deploys work without Docker using --no-verify-jwt flag. Always include this flag or the function will 401 all requests.
- **MCP tool list is session-cached**: Newly deployed tools won't appear in an active Claude Code session - user must restart the MCP connection.
- **Supabase project ref**: rzjhmipbamyvpwlkfvxx (Tasker v2). The other project (gcbpuxpagbnlghhrdrst) is an unrelated personal project.
- **Netlify site**: smarttasksxdd.netlify.app
- **README KB entries are not deduped**: importing a repo twice creates two README entries. Fix pending.
