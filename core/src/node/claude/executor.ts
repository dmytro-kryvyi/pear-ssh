// Moved to the platform-pure layer (core/src/claude/executor.ts) so the
// Android backend can reuse it; this shim keeps existing node-path imports.
export * from '../../claude/executor';
