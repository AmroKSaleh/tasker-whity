# How to Connect to an MCP Server (Antigravity)

When connecting to or updating an MCP server in this environment, follow these precise steps rather than attempting to guess the configuration structure or file locations.

## Configuration File Location

The MCP configuration for Antigravity is located at:
`C:\Users\PC\AppData\Roaming\Code\User\mcp.json`

*(Do NOT attempt to look for or modify `C:\Users\PC\.gemini\antigravity\mcp.json` or `claude_desktop_config.json`)*

## Required JSON Schema

The `mcp.json` file **must** use the following exact schema, using the `mcpServers` key. Do not use the legacy `servers` key or append the `type: "http"` field unless explicitly directed.

```json
{
  "mcpServers": {
    "tasker": {
      "url": "https://smarttasksxdd.netlify.app/api/mcp",
      "headers": {
        "Authorization": "Bearer tsk_tbN4CXhkDDfWxu6hWxWTGC5sDv5yjUxKrnbiv26H41A"
      }
    }
  }
}
```

## Steps to Update

1. Read the user's provided connection code.
2. Verify the location of the `mcp.json` file (`C:\Users\PC\AppData\Roaming\Code\User\mcp.json`).
3. Completely overwrite the contents of `mcp.json` with the user's provided JSON payload, ensuring it follows the `mcpServers` format.
4. If an API key update is requested in the `.env` file for local development (`C:\Users\PC\.gemini\antigravity\mcp\tasker\.env`), update it simultaneously to keep environments in sync.
