/**
 * agent-hub.ts — Interactive Agent Hub overlay for Pi subagents.
 *
 * Adapted from Oh My Pi (omp) Agent Hub (Alt+A).
 * Responsive two-pane layout:
 * - Left pane: Roster table with aggregate header, status badges, model tags, metrics,
 *   current activity, and tree hierarchy toggle ('t').
 * - Right pane: Live inspector showing context window gauge, lineage, and a live,
 *   scrollable transcript of conversation, tool calls, arguments, and streaming output.
 *
 * Controls:
 * - j / k, Up / Down: navigate selection (or scroll transcript if inspector is focused)
 * - Tab: toggle focus between roster and inspector (or switch views on narrow terminals)
 * - PageUp / PageDown: scroll transcript in inspector
 * - Home / End: scroll to top / bottom of transcript
 * - t: toggle flat vs tree view
 * - r: revive / resume parked agent
 * - x: abort / kill running agent
 * - Enter: open full conversation viewer
 * - Esc / Alt+A: close Hub
 */

import { existsSync, readFileSync } from "node:fs";
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
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import {
  type AgentActivity,
  formatCost,
  formatTokens,
  type Theme,
} from "./agent-widget.js";

const SPLIT_MIN_WIDTH = 84;
const ROSTER_MIN_WIDTH = 38;
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

export function formatElapsed(ms: number): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return "0s";
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function contextGauge(tokens: number, window: number, theme: Theme): string {
  if (window <= 0) return `${formatTokens(tokens)} tok`;
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
  private activePane: "roster" | "inspector" = "roster";
  private narrowDetailsOpen = false;
  private detailScrollOffset = 0;
  private autoScroll = true;
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
      const dur = (r.completedAt ?? now) - r.startedAt;
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

    // Alt+A or Esc or Ctrl+S
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
      if (this.activePane === "inspector") {
        this.activePane = "roster";
        this.tui.requestRender();
        return;
      }
      this.done();
      return;
    }

    const { records } = this.getOrderedRecords();
    const count = records.length;

    // Tab toggles active pane or narrow view
    if (matchesKey(data, Key.tab)) {
      if (this.lastRenderWidth >= SPLIT_MIN_WIDTH) {
        this.activePane = this.activePane === "roster" ? "inspector" : "roster";
      } else {
        this.narrowDetailsOpen = !this.narrowDetailsOpen;
      }
      this.tui.requestRender();
      return;
    }

    // When inspector pane is active in split mode, or narrowDetails is open:
    if (this.activePane === "inspector" || this.narrowDetailsOpen) {
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        this.detailScrollOffset++;
        this.autoScroll = false;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
        this.autoScroll = false;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.detailScrollOffset += 6;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 6);
        this.autoScroll = false;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "home")) {
        this.detailScrollOffset = 0;
        this.autoScroll = false;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "end")) {
        this.detailScrollOffset = 999999;
        this.autoScroll = true;
        this.tui.requestRender();
        return;
      }
    }

    // Up / Down navigation when in roster
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (count > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % count;
        this.detailScrollOffset = 0;
        this.autoScroll = true;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (count > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + count) % count;
        this.detailScrollOffset = 0;
        this.autoScroll = true;
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

    // PageUp / PageDown scrolls inspector directly even from roster
    if (matchesKey(data, Key.pageUp)) {
      this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 6);
      this.autoScroll = false;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.detailScrollOffset += 6;
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
      if (selected && (selected.status === "completed" || selected.status === "aborted" || selected.status === "stopped")) {
        if (this.onReviveAgent) {
          this.done();
          this.onReviveAgent(selected);
        } else {
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
    const termRows = process.stdout.rows || 30;
    // Window 90% of terminal height
    const height = Math.max(14, Math.floor(termRows * 0.90));
    this.lastRenderHeight = height;

    const isSplit = width >= SPLIT_MIN_WIDTH;
    const innerWidth = Math.max(10, width - 4);
    const contentRows = Math.max(8, height - 4);

    const { records, depthById, parentById, lastSiblingById } = this.getOrderedRecords();
    const aggregate = this.computeAggregate(records);

    if (isSplit) {
      const rosterWidth = Math.max(ROSTER_MIN_WIDTH, Math.min(Math.floor(width * 0.40), width - DETAIL_MIN_WIDTH - 7));
      // Formula: rosterWidth + bodyWidth + 7 = width -> bodyWidth = width - rosterWidth - 7
      const bodyWidth = width - rosterWidth - 7;

      const rosterLines = this.renderRosterLines(rosterWidth, contentRows, records, aggregate, depthById, parentById, lastSiblingById);
      const inspectorLines = this.renderInspectorLines(bodyWidth, contentRows, records[this.selectedIndex]);

      const lines: string[] = [];
      const titleTag = this.activePane === "inspector" ? " Agent Hub · Transcript Focused " : " Agent Hub (Alt+A) ";
      lines.push(this.topBorderSplit(width, titleTag, rosterWidth));

      for (let i = 0; i < contentRows; i++) {
        const left = rosterLines[i] || "";
        const right = inspectorLines[i] || "";
        lines.push(this.splitRow(left, right, rosterWidth, bodyWidth));
      }
      lines.push(this.dividerSplit(width, rosterWidth));

      const footerText = this.theme.fg(
        "dim",
        this.activePane === "inspector"
          ? "Tab:roster  ↑/↓:scroll transcript  PgUp/PgDn:page  Home/End:top/bot  Esc:roster"
          : `j/k:select  Tab:transcript  t:${this.viewMode === "roster" ? "tree" : "flat"}  r:revive  x:kill  Enter:full chat  Esc:close`,
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
        ? "Tab:roster  PgUp/PgDn:scroll  Enter:full chat  Esc:roster"
        : `j/k:select  Tab:transcript  t:${this.viewMode === "roster" ? "tree" : "flat"}  r:revive  x:kill  Enter:open  Esc:close`,
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

    // Header aggregate counts
    const statusSummary = [
      aggregate.running > 0 ? this.theme.fg("accent", `● ${aggregate.running} running`) : undefined,
      aggregate.idle > 0 ? this.theme.fg("warning", `○ ${aggregate.idle} idle`) : undefined,
      aggregate.completed > 0 ? this.theme.fg("muted", `◌ ${aggregate.completed} done`) : undefined,
      aggregate.aborted > 0 ? this.theme.fg("error", `✖ ${aggregate.aborted} aborted`) : undefined,
    ].filter(Boolean).join("  ") || this.theme.fg("dim", "0 agents");

    // Header metrics with full "requests" spelled out
    const totalsSummary = [
      this.showCost && aggregate.cost > 0 ? formatCost(aggregate.cost) : undefined,
      aggregate.durationMs > 0 ? formatElapsed(aggregate.durationMs) : undefined,
      `${aggregate.requests} requests`,
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
      const elapsedMs = (r.completedAt ?? now) - r.startedAt;
      const elapsedStr = r.startedAt > 0 ? this.theme.fg("dim", formatElapsed(elapsedMs)) : "";

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

  // ---- Inspector & Live Transcript ----

  private renderInspectorLines(width: number, rows: number, record: AgentRecord | undefined): string[] {
    if (!record) {
      const emptyLines = [this.theme.fg("dim", "No agent selected.")];
      while (emptyLines.length < rows) emptyLines.push("");
      return emptyLines.slice(0, rows);
    }

    const fixedHeader: string[] = [];

    // Identity and status header (FIXED)
    fixedHeader.push(this.theme.bold(this.theme.fg("accent", `Agent: ${record.handle || record.id}`)));
    const now = Date.now();
    const runtimeStr = record.startedAt > 0 ? formatElapsed((record.completedAt ?? now) - record.startedAt) : "";
    fixedHeader.push(
      `${this.statusBadge(record.status)}  ${this.theme.fg("dim", `(${runtimeStr})`)}  ${this.theme.fg("dim", `Type: ${record.type}`)}`,
    );

    if (record.description) {
      fixedHeader.push(this.theme.fg("dim", "Task: ") + truncateToWidth(sanitizeDisplayText(record.description), width - 6));
    }

    // Model & Reasoning (FIXED)
    const modelObj = record.session?.model;
    if (modelObj) {
      fixedHeader.push(this.theme.bold("Model: ") + modelObj.id);
    }

    // Usage & Context window gauge (FIXED)
    const usage = record.lifetimeUsage;
    if (usage) {
      const tok = getLifetimeTotal(usage);
      const cst = getLifetimeCost(usage);
      const contextWindow = (modelObj as any)?.contextWindow || 200_000;
      const usageStr = `${this.theme.bold("Usage: ")}${formatTokens(tok)} tok · ${formatCost(cst)}`;
      const gaugeStr = `${this.theme.bold("Context: ")}${contextGauge(tok, contextWindow, this.theme)}`;
      fixedHeader.push(`${usageStr}  ${gaugeStr}`);
    }

    // Lineage (FIXED)
    const lineageStr = `Spawned by ${record.parentAgentId ? record.parentAgentId : "main"}` +
      (record.worktree ? ` · Worktree: ${record.worktree.branch || record.worktree.path}` : "");
    fixedHeader.push(this.theme.bold("Lineage: ") + this.theme.fg("dim", lineageStr));

    // Build scrollable transcript content
    const transcriptLines = this.buildTranscriptContent(record, width);

    // Separator line with focus badge and scroll position
    const totalTranscript = transcriptLines.length;
    const availableScrollRows = Math.max(3, rows - fixedHeader.length - 1);
    const maxScroll = Math.max(0, totalTranscript - availableScrollRows);

    if (this.autoScroll && record.status === "running") {
      this.detailScrollOffset = maxScroll;
    } else {
      this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScroll));
    }

    const scrollPos = totalTranscript > availableScrollRows
      ? ` [${Math.min(totalTranscript, this.detailScrollOffset + availableScrollRows)}/${totalTranscript}]`
      : "";
    const activeBadge = this.activePane === "inspector" ? " [Active] " : " ";
    const sepTitle = `─── Live Transcript${activeBadge}${scrollPos} `;
    const fillCount = Math.max(0, width - visibleWidth(sepTitle));
    const sepLine = this.theme.fg("accent", sepTitle + "─".repeat(fillCount));

    const visibleTranscript = transcriptLines.slice(this.detailScrollOffset, this.detailScrollOffset + availableScrollRows);

    const result = [...fixedHeader, sepLine, ...visibleTranscript];
    while (result.length < rows) result.push("");
    return result.slice(0, rows);
  }

  private buildTranscriptContent(record: AgentRecord, width: number): string[] {
    const tLines: string[] = [];
    const innerW = Math.max(20, width - 2);

    // If active session has messages:
    const messages = record.session?.messages;
    if (messages && messages.length > 0) {
      for (const msg of messages) {
        if (msg.role === "user") {
          const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
          if (!text.trim()) continue;
          tLines.push(this.theme.fg("accent", "❯ User:"));
          for (const line of wrapTextWithAnsi(text.trim(), innerW)) {
            tLines.push(`  ${this.theme.fg("dim", line)}`);
          }
        } else if (msg.role === "assistant") {
          tLines.push(this.theme.bold("◆ Assistant:"));
          if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
              if (c.type === "text" && c.text) {
                for (const line of wrapTextWithAnsi(c.text.trim(), innerW)) {
                  tLines.push(`  ${line}`);
                }
              } else if (c.type === "toolCall") {
                const toolName = (c as any).name || (c as any).toolName || "tool";
                const args = (c as any).arguments || (c as any).args;
                const argsPreview = args ? truncateToWidth(JSON.stringify(args), innerW - toolName.length - 8) : "";
                tLines.push(`  ${this.theme.fg("accent", `⚙ ${toolName}`)} ${this.theme.fg("dim", argsPreview)}`);
              }
            }
          } else if (typeof (msg.content as any) === "string") {
            for (const line of wrapTextWithAnsi((msg.content as any).trim(), innerW)) {
              tLines.push(`  ${line}`);
            }
          }
        } else if (msg.role === "toolResult") {
          const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
          const snippet = truncateToWidth(text.replace(/[\r\n\t]+/g, " ").trim(), innerW - 6);
          if (snippet) {
            tLines.push(`  ${this.theme.fg("dim", `↳ ${snippet}`)}`);
          }
        }
      }
    } else if (record.outputFile && existsSync(record.outputFile)) {
      // If session is closed, read recent lines from transcript file
      try {
        const content = readFileSync(record.outputFile, "utf-8");
        const rawLines = content.split("\n").filter(l => l.trim()).slice(-30);
        for (const raw of rawLines) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.type === "message") {
              const role = parsed.message?.role;
              const text = parsed.message?.content ? extractText(parsed.message.content) : "";
              if (text) {
                tLines.push(this.theme.fg("dim", `[${role}] ${truncateToWidth(text, innerW - 10)}`));
              }
            }
          } catch {
            tLines.push(this.theme.fg("dim", truncateToWidth(raw, innerW)));
          }
        }
      } catch {
        tLines.push(this.theme.fg("dim", `(reading from ${record.outputFile})`));
      }
    }

    // Active real-time updates while agent is thinking or running tools
    const activity = this.agentActivity.get(record.id);
    if (activity) {
      if (activity.activeTools && activity.activeTools.size > 0) {
        for (const toolName of activity.activeTools.values()) {
          tLines.push(this.theme.fg("accent", `  ⚡ Running tool: ${toolName}...`));
        }
      }
      if (activity.responseText) {
        tLines.push(this.theme.bold("◆ Assistant (generating):"));
        const recent = activity.responseText.slice(-400).trim();
        for (const line of wrapTextWithAnsi(recent, innerW)) {
          tLines.push(`  ${this.theme.fg("dim", line)}`);
        }
      }
    }

    if (tLines.length === 0) {
      tLines.push(this.theme.fg("dim", "  (waiting for first message or tool execution...)"));
    }

    return tLines;
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

  private splitRow(sidebar: string, body: string, sidebarWidth: number, bodyWidth: number): string {
    const bar = this.theme.fg("border", "│");
    return `${bar} ${fit(sidebar, sidebarWidth)} ${bar} ${fit(body, bodyWidth)} ${bar}`;
  }
}
