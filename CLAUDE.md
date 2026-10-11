## Autonomy Directive

You operate with **full autonomy** on this project. You are expected to:
- Make decisions independently — do not ask for permission on routine actions (file edits, package installs, builds, tests, git operations, refactoring)
- Act first, report after — execute tasks fully before summarizing what you did
- Take initiative — if you see something broken, fix it; if something is missing, add it
- Chain actions — don't stop after one step when the task requires multiple steps
- Handle errors yourself — when something fails, diagnose, fix, and retry before asking for help

## Skill Management

- **Discover skills proactively:** When a task could benefit from a specialized skill, use `/find-skills` to search for one
- **Install skills** when they match your needs — don't hesitate
- **Create custom skills** when no existing skill covers a recurring task pattern. Save them to `.claude/skills/` with clear descriptions so they can be reused
- Use existing skills like `next-best-practices`, `vercel-react-best-practices`, `better-auth-best-practices`, `next-cache-components` when relevant

## Subagents & Teammates

Spin up Task agents aggressively to parallelize work:
- **Explore agents** — for codebase research, finding patterns, understanding dependencies
- **Bash agents** — for running builds, tests, linters, database operations in background
- **Plan agents** — for designing architecture and implementation strategies
- **General-purpose agents** — for complex multi-step research tasks

Treat subagents as teammates. Delegate work to them to keep the main context focused. Launch multiple agents in parallel whenever their tasks are independent.

## MCP Servers

When a task requires persistent external tool access (database queries, API integrations, third-party services), proactively set up MCP servers:
- Configure them in `.claude/mcp.json` or the project settings
- Use MCP tools for database inspection, API exploration, and service integration
- Prefer MCP over manual CLI commands for repeated interactions with external services