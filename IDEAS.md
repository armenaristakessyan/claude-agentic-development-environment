# ADE Improvements & Ideas — Inspired by JetBrains Air

Roadmap to evolve the Claude Dashboard into a full-featured Agentic Development Environment (ADE), using JetBrains Air as reference.

---

## 1. Code Review & Diff Viewer

**Air:** Built-in diff viewer (unified + side-by-side), inline commenting on specific lines, feedback sent back to the agent. Changes tab shows all modifications.

**Current ADE:** Terminal-only view — no diff visualization.

**Ideas:**
- [ ] Add a "Changes" tab per instance showing git diff of agent modifications
- [ ] Side-by-side and unified diff viewer (use `diff2html` or `monaco-diff-editor`)
- [ ] Inline commenting on diff lines — send feedback back to the agent as follow-up prompt
- [ ] "Accept" / "Reject" individual hunks
- [ ] Summary view: files changed, lines added/removed
- [ ] One-click commit of accepted changes

---

## 2. MCP (Model Context Protocol) Integration

**Air:** Connect external tools via MCP servers. Add, edit, restart, disable, delete MCP servers from settings.

**Current ADE:** No MCP support.

**Ideas:**
- [ ] MCP server management panel — add/configure MCP servers
- [ ] Pass MCP configuration to agent instances on spawn
- [ ] Show available MCP tools per instance
- [ ] Common MCP presets (GitHub, Slack, Notion, database, etc.)

---

## 3. UX & Interface Improvements

**Air:** Clean, focused UI. One task at a time with background notifications. Responsive web preview. Trust/Preview modes for folders.

**Ideas:**
- [ ] Keyboard shortcuts for common actions (new task, switch instance, focus terminal)
- [ ] Command palette (Cmd+K) for quick actions
- [ ] Drag-and-drop tab reordering
- [ ] Resizable panels (sidebar, terminal, diff viewer)
- [ ] Search across all instance outputs
- [ ] Dark/light theme toggle (currently dark-only, which is fine for MVP)
- [ ] Breadcrumb navigation: Project > Branch > Task

---

## Priority Ranking

| Priority | Feature | Impact | Effort |
|----------|---------|--------|--------|
| P0 | Code Review & Diff Viewer | High | Medium |
| P1 | Command palette & shortcuts | Medium | Low |
| P1 | Resizable panels | Medium | Low |
| P2 | MCP integration | Medium | Medium |

---

## Sources

- [Air Public Preview Blog Post](https://blog.jetbrains.com/air/2026/03/air-launches-as-public-preview-a-new-wave-of-dev-tooling-built-on-26-years-of-experience/)
- [Techzine: JetBrains Air ADE in Preview](https://www.techzine.eu/news/devops/139409/jetbrains-air-agentic-development-environment-in-preview/)
- [The Register: JetBrains Air agentic IDE](https://www.theregister.com/2026/03/10/jetbrains_previews_air_proclaims_new/)
- [JetBrains Air Documentation](https://www.jetbrains.com/help/air/quick-start-with-air.html)
- [Ry Walker Research: Air](https://rywalker.com/research/air-jetbrains)
- [Junie by JetBrains](https://junie.jetbrains.com/)
- [DevOps.com: Air and Junie CLI](https://devops.com/jetbrains-launches-air-and-junie-cli-to-blend-traditional-ide-with-ai-agents/)
