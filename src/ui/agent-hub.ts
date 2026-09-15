/**
 * agent-hub.ts — Interactive Agent Hub overlay for Pi subagents.
 *
 * Adapted from Oh My Pi (omp) Agent Hub (Alt+A).
 * Responsive two-pane layout:
 * - Left pane: Roster table with aggregate header, status badges, model tags, metrics,
 *   current activity, and tree hierarchy toggle ('t').
 * - Right pane: Live inspector showing context window gauge, tool parameters, last response,
 *   lineage, and output/worktree artifacts.
 *
 * Controls:
 * - j / k, Up / Down: select agent
 * - t: toggle flat vs tree view
 * - Tab: toggle inspector on narrow terminals (< 96 cols)
 * - PageUp / PageDown: scroll inspector
 * - r: revive / resume parked agent
 * - x: abort / kill running agent
 * - Enter: open conversation viewer
 * - Esc / Alt+A: close Hub
 */

import {
  type Component,
  isKeyRelease,
  Key,
  matchesKey,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  type AgentActivity,
  describeActivity,
  formatCost,
  formatDuration,
  formatTokens,
  type Theme,
} from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

const SPLIT_MIN_WIDTH = 96;
const ROSTER_MIN_WIDTH = 48;
const DETAIL_MIN_WIDTH = 34;
const TICK_MS = 200;

export interface AgentMetrics {
  tokens: number;
  requests: number;
  tools: number;
  cost: number;
  durationMs: number;
}

export interface AggregateMetrics extends AgentMetrics {
  running: number;
  idle: number;
  completed: number;
  aborted: number;
  total: number;
}

interface AgentTreeProjection {
  rows: AgentRecord[];
  depthById: Map<string, number>;
  parentById: Map<string, string>;
  lastSiblingById: Map<string, boolean>;
}

function sanitizeDisplayText(text: string): string {
  return stripTerminalSequences(text).replace(/[\r\n\t]+/g, " ").trim();
}

function padding(len: number): string {
  return len > 0 ? " ".repeat(len) : "";
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w < width) return text + padding(width - w);
  const cut = truncateToWidth(text, width);
  const cw = visibleWidth(cut);
  return cw < width ? cut + padding(width - cw) : cut;
}

function alignRight(text: string, width: number): string {
  const w = visibleWidth(text);
  return padding(Math.max(0, width - w)) + text;
}

export function contextGauge(tokens: number, window: number, theme: Theme): string {
  if (window <= 0) return `${tokens} tok`;
  const ratio = Math.max(0, Math.min(1, tokens / window));
  const filled = Math.round(ratio * 10);
  const bar = theme.fg("accent", "━".repeat(filled)) + theme.fg("dim", "─".repeat(10 - filled));
  const pct = Math.round(ratio * 100);
  return `${bar} ${formatTokens(tokens)}/${formatTokens(window)} ${pct}%`;
}

export function projectAgentTree(refs: readonly AgentRecord[]): AgentTreeProjection {
  const ids = new Set<string>();
  const operationalIndex = new Map<string, number>();
  for (let i = 0; i < refs.length; i++) {
    ids.add(refs[i].id);
    operationalIndex.set(refs[i].id, i);
  }

  const parentById = new Map<string, string>();
  const children = new Map<string, AgentRecord[]>();
  for (const ref of refs) {
    const parent = ref.parentAgentId && ids.has(ref.parentAgentId) ? ref.parentAgentId : "main";
    parentById.set(ref.id, parent);
    const siblings = children.get(parent);
    if (siblings) siblings.push(ref);
    else children.set(parent, [ref]);
  }

  const subtreeOrder = new Map<string, number>();
  const visiting = new Set<string>();
  const ranked = new Set<string>();
  for (const start of refs) {
    if (ranked.has(start.id)) continue;
    const stack: Array<{ ref: AgentRecord; expanded: boolean }> = [{ ref: start, expanded: false }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (current.expanded) {
        let order = operationalIndex.get(current.ref.id) ?? Number.MAX_SAFE_INTEGER;
        for (const child of children.get(current.ref.id) ?? []) {
          order = Math.min(order, subtreeOrder.get(child.id) ?? Number.MAX_SAFE_INTEGER);
        }
        subtreeOrder.set(current.ref.id, order);
        visiting.delete(current.ref.id);
        ranked.add(current.ref.id);
        continue;
      }
      if (ranked.has(current.ref.id) || visiting.has(current.ref.id)) continue;
      visiting.add(current.ref.id);
      stack.push({ ref: current.ref, expanded: true });
      const descendants = children.get(current.ref.id);
      if (!descendants) continue;
      for (let i = descendants.length - 1; i >= 0; i--) {
        const child = descendants[i];
        if (!ranked.has(child.id) && !visiting.has(child.id)) stack.push({ ref: child, expanded: false });
      }
    }
  }

  for (const siblings of children.values()) {
    siblings.sort(
      (a, b) =>
        (subtreeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (subtreeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        (operationalIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (operationalIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const lastSiblingById = new Map<string, boolean>();
  for (const siblings of children.values()) {
    for (let i = 0; i < siblings.length; i++) lastSiblingById.set(siblings[i].id, i === siblings.length - 1);
  }

  const rows: AgentRecord[] = [];
  const visited = new Set<string>();
  const depthById = new Map<string, number>();
  const visit = (root: AgentRecord, rootDepth: number): void => {
    const stack: Array<{ ref: AgentRecord; depth: number }> = [{ ref: root, depth: rootDepth }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current.ref.id)) continue;
      visited.add(current.ref.id);
      depthById.set(current.ref.id, current.depth);
      rows.push(current.ref);
      const descendants = children.get(current.ref.id);
      if (!descendants) continue;
      for (let i = descendants.length - 1; i >= 0; i--) {
        if (!visited.has(descendants[i].id)) stack.push({ ref: descendants[i], depth: current.depth + 1 });
      }
    }
  };

  const topLevel = children.get("main") ?? [];
  for (const root of topLevel) visit(root, 0);
  for (const ref of refs) {
    if (!visited.has(ref.id)) visit(ref, 0);
  }

  return { rows, depthById, parentById, lastSiblingById };
}

function treePrefix(
  ref: AgentRecord,
  depthById: ReadonlyMap<string, number>,
  parentById: ReadonlyMap<string, string>,
  lastSiblingById: ReadonlyMap<string, boolean>,
  theme: Theme,
): string {
  const depth = depthById.get(ref.id) ?? 0;
  if (depth === 0) return "";
  const lastSibling = lastSiblingById.get(ref.id);
  const segments: string[] = [lastSibling ? "└── " : "├── "];
  const ancestry = new Set<string>();
  let parent = parentById.get(ref.id);
  while (parent && parent !== "main" && !ancestry.has(parent)) {
    const grandparent = parentById.get(parent);
    if (!grandparent || grandparent === "main") break;
    ancestry.add(parent);
    segments.push(lastSiblingById.get(parent) ? "    " : "│   ");
    parent = grandparent;
  }
  return theme.fg("dim", segments.reverse().join(""));
}

export class AgentHub implements Component {
  private timer: ReturnType<typeof setInterval> | undefined;
  private selectedIndex = 0;
  private viewMode: "roster" | "tree" = "roster";
  private narrowDetailsOpen = false;
  private detailScrollOffset = 0;
  private lastRenderWidth = 80;
  private lastRenderHeight = 24;
  private notice: string | undefined;

  constructor(
    private tui: TUI,
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    private theme: Theme,
    private keybindings: any,
    private done: () => void,
    private onOpenConversation: (record: AgentRecord) => void,
    private onReviveAgent?: (record: AgentRecord) => void,
    private showCost = true,
  ) {
    this.timer = setInterval(() => {
      this.tui.requestRender();
    }, TICK_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  invalidate(): void {}

  private getRecords(): AgentRecord[] {
    return this.manager.listAgents();
  }

  private getOrderedRecords(): {
    records: AgentRecord[];
    depthById?: Map<string, number>;
    parentById?: Map<string, string>;
    lastSiblingById?: Map<string, boolean>;
  } {
    const raw = this.getRecords();
    if (this.viewMode === "tree") {
      const projection = projectAgentTree(raw);
      return {
        records: projection.rows,
        depthById: projection.depthById,
        parentById: projection.parentById,
        lastSiblingById: projection.lastSiblingById,
      };
    }
    // Roster view: newest / active first
    const records = [...raw].sort((a, b) => {
      const aRunning = a.status === "running" ? 0 : 1;
      const bRunning = b.status === "running" ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
    return { records };
  }

  private computeAggregate(records: AgentRecord[]): AggregateMetrics {
    let running = 0;
    let idle = 0;
    let completed = 0;
    let aborted = 0;
    let tokens = 0;
    let requests = 0;
    let tools = 0;
    let cost = 0;
    let durationMs = 0;

    const now = Date.now();
    for (const r of records) {
      if (r.status === "running") running++;
      else if (r.status === "queued") idle++;
      else if (r.status === "aborted" || r.status === "stopped" || r.status === "error") aborted++;
      else completed++;

      const usage = r.lifetimeUsage;
      if (usage) {
        tokens += getLifetimeTotal(usage);
        cost += getLifetimeCost(usage);
      }
      const activity = this.agentActivity.get(r.id);
      if (activity) {
        requests += activity.turnCount || 0;
        tools += activity.toolUses || 0;
      }
      const dur = r.completedAt ? r.completedAt - r.startedAt : now - r.startedAt;
      if (dur > 0) durationMs += dur;
    }

    return {
      running,
      idle,
      completed,
      aborted,
      total: records.length,
      tokens,
      requests,
      tools,
      cost,
      durationMs,
    };
  }

  private statusBadge(status: AgentRecord["status"]): string {
    switch (status) {
      case "running":
        return this.theme.fg("accent", "● running");
      case "queued":
        return this.theme.fg("warning", "○ queued");
      case "completed":
      case "steered":
        return this.theme.fg("muted", "◌ completed");
      case "aborted":
      case "stopped":
      case "error":
        return this.theme.fg("error", "✖ " + status);
      default:
        return this.theme.fg("dim", String(status));
    }
  }

  private statusGlyph(status: AgentRecord["status"]): string {
    switch (status) {
      case "running":
        return this.theme.fg("accent", "●");
      case "queued":
        return this.theme.fg("warning", "○");
      case "completed":
      case "steered":
        return this.theme.fg("muted", "◌");
      case "aborted":
      case "stopped":
      case "error":
        return this.theme.fg("error", "✖");
      default:
        return "·";
    }
  }

  // ---- Key handling ----

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;

    // Alt+A or Esc or Ctrl+S: close Hub
    if (
      matchesKey(data, "alt+a") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+s") ||
      data === "\x1ba" ||
      data === "\x1bA"
    ) {
      if (this.narrowDetailsOpen) {
        this.narrowDetailsOpen = false;
        this.tui.requestRender();
        return;
      }
      this.done();
      return;
    }

    const { records } = this.getOrderedRecords();
    const count = records.length;

    // Up / Down navigation
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (count > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % count;
        this.detailScrollOffset = 0;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (count > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + count) % count;
        this.detailScrollOffset = 0;
        this.tui.requestRender();
      }
      return;
    }

    // Toggle flat vs tree view
    if (matchesKey(data, "t")) {
      this.viewMode = this.viewMode === "roster" ? "tree" : "roster";
      this.tui.requestRender();
      return;
    }

    // Tab: toggle inspector on narrow screens
    if (matchesKey(data, Key.tab)) {
      this.narrowDetailsOpen = !this.narrowDetailsOpen;
      this.tui.requestRender();
      return;
    }

    // PageUp / PageDown for scrolling inspector
    if (matchesKey(data, Key.pageUp)) {
      this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 4);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.detailScrollOffset += 4;
      this.tui.requestRender();
      return;
    }

    // Kill / Abort agent: x
    if (matchesKey(data, "x")) {
      const selected = records[this.selectedIndex];
      if (selected && selected.status === "running") {
        this.manager.abort(selected.id);
        this.notice = `Aborted agent "${selected.handle || selected.id}".`;
        this.tui.requestRender();
      }
      return;
    }

    // Revive / Resume agent: r
    if (matchesKey(data, "r")) {
      const selected = records[this.selectedIndex];
      if (selected && (selected.status === "completed" || selected.status === "aborted")) {
        if (this.onReviveAgent) {
          this.done();
          this.onReviveAgent(selected);
        } else {
          // Open conversation viewer directly to prompt/steer
          this.done();
          this.onOpenConversation(selected);
        }
      }
      return;
    }

    // Enter: open conversation viewer
    if (matchesKey(data, Key.enter)) {
      const selected = records[this.selectedIndex];
      if (selected) {
        this.done();
        this.onOpenConversation(selected);
      }
      return;
    }
  }

  // ---- Render ----

  render(width: number): string[] {
    this.lastRenderWidth = width;
    const height = Math.max(16, Math.min(36, Math.floor((process.stdout.rows || 30) * 0.82)));
    this.lastRenderHeight = height;

    const isSplit = width >= SPLIT_MIN_WIDTH;
    const innerWidth = Math.max(10, width - 4);
    const contentRows = Math.max(8, height - 4);

    const { records, depthById, parentById, lastSiblingById } = this.getOrderedRecords();
    const aggregate = this.computeAggregate(records);

    if (isSplit) {
      const rosterWidth = Math.max(ROSTER_MIN_WIDTH, Math.min(Math.floor(width * 0.55), width - DETAIL_MIN_WIDTH - 6));
      const bodyWidth = Math.max(DETAIL_MIN_WIDTH, width - rosterWidth - 5);

      const rosterLines = this.renderRosterLines(rosterWidth, contentRows, records, aggregate, depthById, parentById, lastSiblingById);
      const inspectorLines = this.renderInspectorLines(bodyWidth, contentRows, records[this.selectedIndex]);

      const lines: string[] = [];
      lines.push(this.topBorderSplit(width, " Agent Hub (Alt+A) ", rosterWidth));
      for (let i = 0; i < contentRows; i++) {
        const left = rosterLines[i] || "";
        const right = inspectorLines[i] || "";
        lines.push(this.splitRow(left, right, width, rosterWidth, bodyWidth));
      }
      lines.push(this.dividerSplit(width, rosterWidth));
      const footerText = this.theme.fg(
        "dim",
        `j/k:select  t:${this.viewMode === "roster" ? "tree" : "flat"}  r:revive  x:kill  Enter:open  Esc:close`,
      );
      lines.push(this.row(footerText, width));
      lines.push(this.bottomBorder(width));
      return lines;
    }

    // Narrow terminal mode
    const lines: string[] = [];
    lines.push(this.topBorder(width, " Agent Hub (Alt+A) "));
    const activeLines = this.narrowDetailsOpen
      ? this.renderInspectorLines(innerWidth, contentRows, records[this.selectedIndex])
      : this.renderRosterLines(innerWidth, contentRows, records, aggregate, depthById, parentById, lastSiblingById);

    for (let i = 0; i < contentRows; i++) {
      lines.push(this.row(activeLines[i] || "", width));
    }
    lines.push(this.divider(width));
    const footerText = this.theme.fg(
      "dim",
      this.narrowDetailsOpen
        ? "Tab:roster  PgUp/PgDn:scroll  Enter:open  Esc:roster"
        : `j/k:select  Tab:details  t:${this.viewMode === "roster" ? "tree" : "flat"}  r/x:manage  Enter:open  Esc:close`,
    );
    lines.push(this.row(footerText, width));
    lines.push(this.bottomBorder(width));
    return lines;
  }

  // ---- Roster lines ----

  private renderRosterLines(
    width: number,
    rows: number,
    records: AgentRecord[],
    aggregate: AggregateMetrics,
    depthById?: Map<string, number>,
    parentById?: Map<string, string>,
    lastSiblingById?: Map<string, boolean>,
  ): string[] {
    const lines: string[] = [];

    // Header aggregate
    const statusSummary = [
      aggregate.running > 0 ? this.theme.fg("accent", `● ${aggregate.running} running`) : undefined,
      aggregate.idle > 0 ? this.theme.fg("warning", `○ ${aggregate.idle} idle`) : undefined,
      aggregate.completed > 0 ? this.theme.fg("muted", `◌ ${aggregate.completed} done`) : undefined,
      aggregate.aborted > 0 ? this.theme.fg("error", `✖ ${aggregate.aborted} aborted`) : undefined,
    ].filter(Boolean).join("  ") || this.theme.fg("dim", "0 agents");

    const totalsSummary = [
      this.showCost && aggregate.cost > 0 ? formatCost(aggregate.cost) : undefined,
      aggregate.durationMs > 0 ? formatDuration(aggregate.durationMs) : undefined,
      `${aggregate.requests} req`,
      `${aggregate.tools} tools`,
      formatTokens(aggregate.tokens),
    ].filter(Boolean).join(this.theme.fg("dim", " · "));

    lines.push(truncateToWidth(statusSummary, width));
    lines.push(truncateToWidth(totalsSummary, width));
    lines.push(this.theme.fg("dim", "─".repeat(width)));

    if (this.notice) {
      lines.push(this.theme.fg("accent", truncateToWidth(this.notice, width)));
    }

    if (records.length === 0) {
      lines.push("");
      lines.push(this.theme.fg("muted", "  No subagents in current session."));
      lines.push(this.theme.fg("dim", "  Spawn an agent with the Agent tool or press Esc to close."));
      while (lines.length < rows) lines.push("");
      return lines.slice(0, rows);
    }

    // Render roster entries
    const availableRows = rows - lines.length;
    let startIdx = 0;
    if (this.selectedIndex >= availableRows) {
      startIdx = this.selectedIndex - availableRows + 1;
    }

    for (let i = startIdx; i < records.length && lines.length < rows; i++) {
      const r = records[i];
      const isSelected = i === this.selectedIndex;
      const cursor = isSelected ? this.theme.fg("accent", "❯ ") : "  ";

      const branch =
        this.viewMode === "tree" && depthById && parentById && lastSiblingById
          ? treePrefix(r, depthById, parentById, lastSiblingById, this.theme)
          : "";

      const glyph = this.statusGlyph(r.status);
      const name = r.handle || r.id;
      const styledName = isSelected ? this.theme.bold(this.theme.fg("accent", name)) : this.theme.bold(name);
      const modelObj = r.session?.model;
      const modelName = modelObj ? modelObj.id.split("/").pop() || modelObj.id : "";
      const modelTag = modelName ? this.theme.fg("dim", `[${modelName}]`) : "";

      const now = Date.now();
      const elapsed = r.completedAt ? r.completedAt - r.startedAt : now - r.startedAt;
      const elapsedStr = elapsed > 0 ? this.theme.fg("dim", formatDuration(elapsed)) : "";

      const firstLine = `${cursor}${branch}${glyph} ${styledName} ${modelTag} ${elapsedStr}`;
      lines.push(truncateToWidth(firstLine, width));

      // Second line: activity or description
      const activity = this.agentActivity.get(r.id);
      let actDesc = "";
      if (activity && activity.activeTools.size > 0) {
        const tools = Array.from(activity.activeTools.values()).join(", ");
        actDesc = this.theme.fg("accent", `⎿ active: ${tools}`);
      } else if (r.description) {
        actDesc = this.theme.fg("dim", `⎿ ${sanitizeDisplayText(r.description)}`);
      }
      if (actDesc && lines.length < rows) {
        lines.push(truncateToWidth(`    ${actDesc}`, width));
      }
    }

    while (lines.length < rows) lines.push("");
    return lines.slice(0, rows);
  }

  // ---- Inspector lines ----

  private renderInspectorLines(width: number, rows: number, record: AgentRecord | undefined): string[] {
    const lines: string[] = [];
    if (!record) {
      lines.push(this.theme.fg("dim", "No agent selected."));
      while (lines.length < rows) lines.push("");
      return lines.slice(0, rows);
    }

    const activity = this.agentActivity.get(record.id);

    // Title / Identity
    lines.push(this.theme.bold(this.theme.fg("accent", `Agent: ${record.handle || record.id}`)));
    lines.push(`${this.statusBadge(record.status)}  ${this.theme.fg("dim", `Type: ${record.type}`)}`);

    if (record.description) {
      lines.push(this.theme.fg("dim", "Task: ") + sanitizeDisplayText(record.description));
    }

    lines.push(this.theme.fg("dim", "─".repeat(width)));

    // Model & Reasoning
    const modelObj = record.session?.model;
    if (modelObj) {
      lines.push(this.theme.bold("Model: ") + modelObj.id);
    }

    // Usage & Context window gauge
    const usage = record.lifetimeUsage;
    if (usage) {
      const tok = getLifetimeTotal(usage);
      const cst = getLifetimeCost(usage);
      lines.push(this.theme.bold("Usage: ") + `${formatTokens(tok)} tok · ${formatCost(cst)}`);

      // Context gauge if contextWindow is known on model
      const contextWindow = (modelObj as any)?.contextWindow || 200_000;
      lines.push(this.theme.bold("Context: ") + contextGauge(tok, contextWindow, this.theme));
    }

    // Active tool / Intent
    if (activity) {
      lines.push(
        this.theme.bold("Execution: ") +
          `${activity.turnCount || 0} turns · ${activity.toolUses || 0} tool calls`,
      );
      if (activity.activeTools.size > 0) {
        const toolsList = Array.from(activity.activeTools.values()).join(", ");
        lines.push(this.theme.bold(this.theme.fg("accent", "Running Tool: ")) + toolsList);
      }
      if (activity.responseText) {
        lines.push(this.theme.bold("Recent Output:"));
        const preview = sanitizeDisplayText(activity.responseText.slice(-200));
        lines.push(this.theme.fg("dim", truncateToWidth(preview, width)));
      }
    }

    // Lineage
    lines.push(this.theme.fg("dim", "─".repeat(width)));
    lines.push(
      this.theme.bold("Lineage: ") +
        `Spawned by ${record.parentAgentId ? record.parentAgentId : "main"}`,
    );

    // Artifacts
    if (record.outputFile) {
      lines.push(this.theme.bold("Transcript: ") + this.theme.fg("dim", record.outputFile));
    }
    if (record.worktree) {
      lines.push(this.theme.bold("Worktree: ") + this.theme.fg("dim", record.worktree.path));
    }

    // Apply scroll offset
    const maxScroll = Math.max(0, lines.length - rows);
    this.detailScrollOffset = Math.min(this.detailScrollOffset, maxScroll);
    const visible = lines.slice(this.detailScrollOffset, this.detailScrollOffset + rows);
    while (visible.length < rows) visible.push("");
    return visible.slice(0, rows);
  }

  // ---- Chrome borders ----

  private topBorder(width: number, title: string): string {
    const box = { topLeft: "╭", topRight: "╮", horizontal: "─" };
    const inner = Math.max(0, width - 2);
    const shown = truncateToWidth(` ${title} `, inner);
    const fill = Math.max(0, inner - visibleWidth(shown));
    return (
      this.theme.fg("border", box.topLeft) +
      this.theme.bold(this.theme.fg("accent", shown)) +
      this.theme.fg("border", box.horizontal.repeat(fill) + box.topRight)
    );
  }

  private topBorderSplit(width: number, title: string, sidebarWidth: number): string {
    const box = { topLeft: "╭", topRight: "╮", horizontal: "─", teeDown: "┬" };
    const leftLen = sidebarWidth + 2;
    const rightLen = Math.max(0, width - leftLen - 3);

    const shown = truncateToWidth(` ${title} `, leftLen);
    const leftFill = Math.max(0, leftLen - visibleWidth(shown));
    const left =
      this.theme.fg("border", box.topLeft) +
      this.theme.bold(this.theme.fg("accent", shown)) +
      this.theme.fg("border", box.horizontal.repeat(leftFill));

    return left + this.theme.fg("border", box.teeDown + box.horizontal.repeat(rightLen) + box.topRight);
  }

  private divider(width: number): string {
    const box = { teeRight: "├", teeLeft: "┤", horizontal: "─" };
    return this.theme.fg("border", box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
  }

  private dividerSplit(width: number, sidebarWidth: number): string {
    const box = { teeRight: "├", teeLeft: "┤", horizontal: "─", teeUp: "┴" };
    const leftLen = sidebarWidth + 2;
    const rightLen = Math.max(0, width - leftLen - 3);
    return this.theme.fg(
      "border",
      box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft,
    );
  }

  private bottomBorder(width: number): string {
    const box = { bottomLeft: "╰", bottomRight: "╯", horizontal: "─" };
    return this.theme.fg("border", box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
  }

  private row(content: string, width: number): string {
    return `${this.theme.fg("border", "│")} ${fit(content, Math.max(0, width - 4))} ${this.theme.fg("border", "│")}`;
  }

  private splitRow(sidebar: string, body: string, width: number, sidebarWidth: number, bodyWidth: number): string {
    const bar = this.theme.fg("border", "│");
    return `${bar} ${fit(sidebar, sidebarWidth)} ${bar} ${fit(body, bodyWidth)} ${bar}`;
  }
}
