@echo off
rem AutoQC Studio MCP server launcher (for Claude Code / Claude Desktop). Start AutoQC Studio (start.bat) first.
cd /d "%~dp0.."
node node_modules\tsx\dist\cli.mjs tools\mcp-server.ts
