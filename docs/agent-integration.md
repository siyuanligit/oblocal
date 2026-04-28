# Agent Integration

Connect AI coding agents to your local Open Brain via the MCP server running in Docker.

## Claude Code

Add this to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "openbrain": {
      "command": "/path/to/local-version/scripts/mcp-wrapper.sh"
    }
  }
}
```

## Cursor / VS Code Copilot / Windsurf

Same wrapper script works for all stdio-based MCP agents. Add the same config to their respective MCP settings:

- **Cursor**: Settings → MCP → Add server
- **VS Code Copilot**: Extensions → MCP → Add
- **Windsurf**: Settings → AI → MCP servers

Point the `command` to your local `scripts/mcp-wrapper.sh`.

## Multiple Agents Sharing One Brain

All agents connect to the same Docker container via the stdio wrapper. The `source` column in `thoughts` tracks which agent captured each entry — useful for understanding the provenance of your memories.