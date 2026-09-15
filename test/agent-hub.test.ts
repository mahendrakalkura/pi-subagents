import { describe, expect, it, vi } from "vitest";
import { AgentHub, projectAgentTree } from "../src/ui/agent-hub.js";
import type { AgentRecord } from "../src/types.js";

function makeRecord(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    handle: id,
    description: `Task for ${id}`,
    status: "running",
    toolUses: 0,
    startedAt: Date.now() - 5000,
    lifetimeUsage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalCost: 0.005,
    },
    compactionCount: 0,
    ...overrides,
  };
}

describe("projectAgentTree", () => {
  it("projects flat list of root agents at depth 0", () => {
    const records = [makeRecord("a"), makeRecord("b")];
    const tree = projectAgentTree(records);
    expect(tree.rows).toHaveLength(2);
    expect(tree.depthById.get("a")).toBe(0);
    expect(tree.depthById.get("b")).toBe(0);
  });

  it("projects parent-child relationships with correct depth", () => {
    const parent = makeRecord("parent");
    const child = makeRecord("child", { parentAgentId: "parent" });
    const grandchild = makeRecord("grandchild", { parentAgentId: "child" });

    const tree = projectAgentTree([grandchild, parent, child]);
    expect(tree.rows.map(r => r.id)).toEqual(["parent", "child", "grandchild"]);
    expect(tree.depthById.get("parent")).toBe(0);
    expect(tree.depthById.get("child")).toBe(1);
    expect(tree.depthById.get("grandchild")).toBe(2);
  });
});

describe("AgentHub component", () => {
  const mockTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
  };

  const mockTui = {
    requestRender: vi.fn(),
  };

  it("renders empty state cleanly when no agents exist", () => {
    const manager = {
      listAgents: () => [],
      abort: vi.fn(),
      resume: vi.fn(),
    } as any;

    const hub = new AgentHub(
      mockTui as any,
      manager,
      new Map(),
      mockTheme as any,
      {},
      vi.fn(),
      vi.fn(),
    );

    const lines = hub.render(100);
    expect(lines.length).toBeGreaterThan(5);
    const content = lines.join("\n");
    expect(content).toContain("Agent Hub");
    expect(content).toContain("No subagents in current session");
    hub.dispose();
  });

  it("renders split view with roster and inspector when terminal is wide", () => {
    const records = [
      makeRecord("agent-1", { status: "running" }),
      makeRecord("agent-2", { status: "completed" }),
    ];

    const manager = {
      listAgents: () => records,
      abort: vi.fn(),
      resume: vi.fn(),
    } as any;

    const hub = new AgentHub(
      mockTui as any,
      manager,
      new Map(),
      mockTheme as any,
      {},
      vi.fn(),
      vi.fn(),
    );

    const lines = hub.render(120);
    const content = lines.join("\n");
    expect(content).toContain("Agent Hub");
    expect(content).toContain("agent-1");
    expect(content).toContain("running");
    hub.dispose();
  });

  it("toggles flat and tree view with 't' key", () => {
    const records = [
      makeRecord("parent"),
      makeRecord("child", { parentAgentId: "parent" }),
    ];

    const manager = {
      listAgents: () => records,
      abort: vi.fn(),
      resume: vi.fn(),
    } as any;

    const hub = new AgentHub(
      mockTui as any,
      manager,
      new Map(),
      mockTheme as any,
      {},
      vi.fn(),
      vi.fn(),
    );

    hub.handleInput("t");
    expect(mockTui.requestRender).toHaveBeenCalled();
    hub.dispose();
  });

  it("closes on escape or alt+a", () => {
    const done = vi.fn();
    const manager = { listAgents: () => [] } as any;

    const hub = new AgentHub(
      mockTui as any,
      manager,
      new Map(),
      mockTheme as any,
      {},
      done,
      vi.fn(),
    );

    hub.handleInput("\x1ba");
    expect(done).toHaveBeenCalled();
    hub.dispose();
  });
});
