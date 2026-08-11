# Task Input/Output System Design

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## Task Input/Output System: Core Workflow Engine

**Purpose:** Move Tasker from task organizer to workflow engine. Tasks declare dependencies with validation and feedback loops.

### The Idea

Each task can have:
- **Input:** What task is this waiting for, and what type/format do we expect?
- **Output:** What task is waiting for us, and what do they expect from us?

When a task completes:
1. System validates output against target task's expectations
2. If invalid, feedback is sent back to source task
3. Source task can iterate based on feedback
4. Once valid, target task can proceed

This creates a feedback loop: tasks communicate about mismatches and iterate toward meeting expectations.

### Data Model

```typescript
task.input = {
  source_task_id: string,           // UUID or short ID (TDE-45)
  expected_type: string,            // "string" | "document" | "code" | "decision" | "other"
  validation_rules: string,         // "user-defined rules or AI-powered"
}

task.output = {
  target_task_id: string,           // UUID or short ID (TDE-46)
  validation_status: string,        // "pending" | "valid" | "invalid"
  feedback: string,                 // "what's wrong, what to fix"
}
```

### Validation Logic

**Context-aware validation:** Parse the output from source task, validate against target task's expectations.

Approaches:
1. **Type checking** — Is this a document, code, decision, etc.?
2. **Rule-based** — Does it contain required sections/components?
3. **AI-powered** — Ask Claude: "Does this match the requirements?"

Example:
- Task A (write API spec): output is "document"
- Task B expects: "document with sections: endpoints, auth, errors"
- Validation: parse document, check for required sections
- If missing: feedback "missing 'auth' section"
- Task A creator sees feedback, adds it
- Once valid: Task B can proceed with implementation

### MCP Tools (4 total)

1. **set_task_input(task_id, source_task_id, expected_type, validation_rules)**
   - Declares what this task expects
   - Example: `set_task_input("TDE-46", "TDE-45", "document", "must have: intro, body, conclusion")`

2. **set_task_output(task_id, target_task_id)**
   - Declares where this task's output goes
   - Example: `set_task_output("TDE-45", "TDE-46")`

3. **validate_output(task_id)**
   - Validates task's output against target task's expectations
   - Returns: {status: "valid" | "invalid", feedback: "..."} 

4. **get_validation_feedback(task_id)**
   - Get feedback from target task about output validity
   - Returns: feedback string or "no feedback yet"

### Workflow Example

1. **Setup:**
   - Task A (Implement feature) outputs to Task B (Test feature)
   - Task B expects: "working code with tests passing"

2. **Execution:**
   - Developer completes Task A, marks it done
   - System validates: does the code pass tests?
   - If fails: Task A gets feedback "test failures in: auth.test.js"

3. **Iteration:**
   - Developer sees feedback in Task A
   - Fixes the failing tests
   - Re-submits (mark complete again?)
   - Validation passes
   - Task B now ready to proceed

### Why This Matters for Phase 1

Transforms Tasker from "organize tasks" to "manage workflow dependencies."

Solo developers can:
- Build projects with explicit dependencies
- Get automated feedback when work doesn't meet expectations
- Iterate based on concrete feedback (not guessing)
- See the full workflow (what depends on what)

### Phase 2 Visualization

The real USP comes when we visualize this as a **dependency graph** (like Unreal Engine blueprints):
- Nodes = tasks/groups
- Edges = dependencies
- Color = validation status (valid, invalid, pending)
- Shows critical path, blockers, etc.

This visual representation is what teams will pay for.

### Implementation Status

- **Phase 1:** Build the system, works via MCP (text-based, no visualization)
- **Phase 2:** Add visual dependency graph as premium feature

### Notes

- Start simple: user-defined validation rules
- Later: add AI-powered validation (Claude validates context)
- No real-time validation yet: user triggers it manually
- Feedback is stored as task metadata, not separate notifications
