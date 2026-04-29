#!/bin/bash
# Open Brain — MCP Agent Integration (optional)
# Only needed if your agent prefers MCP stdio transport over CLI subprocess.
# CLI is always available — this step is entirely optional.

echo "=== Open Brain — MCP Agent Integration (Optional) ==="
echo ""
echo "NOTE: This step is optional. CLI is primary — run openbrain --help to start."
echo "Only use this if your agent requires MCP stdio transport."
echo ""
echo "STEP 1: Copy the MCP wrapper script"
echo "  cp local-version/scripts/mcp-wrapper.sh ~/.openbrain/mcp-wrapper.sh"
echo "  chmod +x ~/.openbrain/mcp-wrapper.sh"
echo ""
echo "STEP 2: Add to Claude Code (~/.claude/mcp.json)"
echo "  {"
echo '    "mcpServers": {'
echo '      "openbrain": {'
echo '        "command": "~/.openbrain/mcp-wrapper.sh"'
echo "      }"
echo "    }"
echo "  }"
echo ""
echo "STEP 3: Restart Claude Code"
echo "  The new MCP server will be detected on restart."
echo ""
echo "STEP 4: Verify"
echo "  In Claude Code, try: search_thoughts with query='test'"
echo ""
echo "---"
echo "Cursor / VS Code Copilot / Windsurf:"
echo "  Same wrapper script works with all stdio-based MCP agents."
echo "  Add to your editor's MCP settings using the same JSON format."
echo ""
echo "---"
echo "Multiple agents sharing one brain:"
echo "  All agents connect to the same Docker container."
echo "  The 'source' column tracks which agent captured each entry."
