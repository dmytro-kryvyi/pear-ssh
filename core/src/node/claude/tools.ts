// Moved to the platform-pure layer (core/src/claude/tools.ts) so the Android
// backend can serve the same MCP tools; this shim keeps node-path imports.
export * from '../../claude/tools';
