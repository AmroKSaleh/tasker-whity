// TDE-816: the Flows page and the MCP's get_flow_exceptions must never disagree about
// what needs a human — a drifted copy would tell you a flow is clean while the agent is
// being told a gate failed. So this is NOT a mirror (unlike flowGraph.js): it re-exports
// the server's own derivation. The module is pure and dependency-free precisely so both
// runtimes can import it; vite.config.js allows serving it from outside the app root.
export { deriveFlowExceptions, flowTerminalIds, taskRef } from '../../../supabase/functions/mcp/flow_exceptions.ts'
