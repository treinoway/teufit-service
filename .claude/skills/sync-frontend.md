# Sync Frontend

Invoke the **frontend-engineer** agent (located at `/Users/adeildoneto/Coding/treinoway-web/.claude/agents/frontend-engineer.md`) to implement the frontend changes corresponding to the latest backend API changes.

The agent will:
1. Read the backend action log at `/Users/adeildoneto/Coding/treinoway-service/.claude/action-log.md`
2. Read the backend git diff for full context
3. Implement the corresponding changes in the frontend repo at `/Users/adeildoneto/Coding/treinoway-web`
4. Write tests and verify lint passes

## Additional context from user:
$ARGUMENTS
