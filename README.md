# H.E. Pennypacker

> *"I'm H.E. Pennypacker. I'm a wealthy American industrialist."*

Personal finance tracker that scrapes your Empower (Personal Capital) dashboard and stores historical snapshots in SQLite. No paid APIs, no monthly fees. Just a browser, some cookies, and a dream.

## What it does

- **Scrapes** your Empower dashboard for all account balances and investment holdings
- **Stores** historical snapshots in SQLite for net worth tracking over time
- **CLI** for quick terminal-based financial overview
- **MCP server** for AI assistant integration (Zoey/Claude Code)

## Setup

```bash
bun install
cp .env.example .env
# Edit .env if needed (defaults work for most Empower accounts)
```

## Usage

```bash
# First run — opens browser, you log in, cookies get saved
bun run scrape

# Check your net worth
bun run status

# See investment holdings
bun run holdings

# Net worth history
bun run history        # last 30 days
bun run history 90     # last 90 days

# All accounts
bun run accounts
```

## MCP Server

Add to your Claude Code config:

```json
{
  "mcpServers": {
    "pennypacker": {
      "command": "bun",
      "args": ["run", "/path/to/pennypacker/src/mcp/server.ts"]
    }
  }
}
```

Tools: `pennypacker_status`, `pennypacker_accounts`, `pennypacker_holdings`, `pennypacker_history`, `pennypacker_query`

## Architecture

```
Empower Dashboard ──→ Playwright Scraper ──→ SQLite
                                               ↓
                                          CLI / MCP Server
```

- **Bun** runtime (fast, native SQLite, TypeScript)
- **Playwright** for browser automation
- **SQLite** for zero-dependency historical storage
- Cookie-based session management (log in once, reuse cookies)

## Database

Three tables: `snapshots` (net worth per scrape), `accounts` (balances per account per scrape), `holdings` (investment positions per scrape). All queryable via the `pennypacker_query` MCP tool or directly with `sqlite3 data/pennypacker.db`.
