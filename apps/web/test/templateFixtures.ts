import type { ConfigProfile, ProfileStep } from "@mc/core";

/** Fictional catalogue workflows; independent of execution policy. */
const templates: (Omit<ConfigProfile, "steps" | "nodes"> & {
  path: string[];
  nodes: ProfileStep[];
})[] = [
  {
    name: "feature",
    labels: [],
    trigger: "label type:feature",
    rounds: 3,
    budget: 400000,
    path: ["plan", "go/no-go", "implement", "verify", "review", "draft PR"],
    nodes: [
      {
        name: "plan",
        phase: null,
        role: "FIDO, or the assigned GUIDO",
        checks: [
          {
            kind: "review",
            text: "Plan lists the acceptance criteria as a checklist verify can prove",
          },
          {
            kind: "rule",
            text: "Every file in the plan sits inside the agent's area",
          },
        ],
      },
      {
        name: "go/no-go",
        phase: null,
        role: "FLIGHT polls, you decide",
        gate: true,
        retry: "no-go → back to plan",
        checks: [
          {
            kind: "gate",
            text: "FLIGHT polls every check; you make the call",
          },
        ],
      },
      {
        name: "implement",
        phase: "working",
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "New test fails on the base commit (Mission Control re-runs it)",
          },
          {
            kind: "cmd",
            text: "The same test passes on the branch",
          },
        ],
      },
      {
        name: "draft PR",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "rule",
            text: "PR is open as a draft",
          },
          {
            kind: "rule",
            text: "Body lists the deploy steps",
          },
        ],
      },
      {
        name: "review",
        phase: "review",
        role: "RETRO, fresh eyes: sees the ticket, plan, diff and check output, not the author's chat",
        retry: "Critical or Important findings → fix → verify",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
      },
      {
        name: "verify",
        phase: "ci",
        role: "Mission Control runs it",
        max: 3,
        retry: "fail → fix → back to verify · max 3",
        checks: [
          {
            kind: "cmd",
            text: "Full test suite passes (takes the test lock)",
          },
          {
            kind: "cmd",
            text: "Typecheck exits 0",
          },
          {
            kind: "rule",
            text: "No existing test weakened, skipped or deleted",
          },
          {
            kind: "rule",
            text: "Diff stays inside the area; no stray files",
          },
        ],
      },
      {
        name: "fix",
        phase: "working",
        role: "GUIDO",
        checks: [
          {
            kind: "agent",
            text: "Each finding has a commit or a written ruling",
          },
        ],
      },
    ],
    planRequired: false,
    reviewer: {
      role: "RETRO",
      depth: "light",
    },
    tries: 3,
  },
  {
    name: "bugfix",
    labels: [],
    trigger: "label bug",
    rounds: 3,
    budget: 250000,
    path: ["reproduce", "fix", "verify", "review", "draft PR"],
    nodes: [
      {
        name: "reproduce",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "A test reproduces the bug: fails on the base commit for the reported reason",
          },
        ],
      },
      {
        name: "fix",
        phase: "working",
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "The reproducing test passes",
          },
        ],
      },
      {
        name: "verify",
        phase: "ci",
        role: "Mission Control runs it",
        max: 3,
        retry: "fail → fix → back to verify · max 3",
        checks: [
          {
            kind: "cmd",
            text: "Full test suite passes (takes the test lock)",
          },
          {
            kind: "cmd",
            text: "Typecheck exits 0",
          },
          {
            kind: "rule",
            text: "No stray files",
          },
        ],
      },
      {
        name: "draft PR",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "rule",
            text: "PR is open as a draft",
          },
        ],
      },
      {
        name: "review",
        phase: "review",
        role: "RETRO, fresh eyes: sees the ticket, plan, diff and check output, not the author's chat",
        retry: "Critical or Important findings → fix → verify",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
      },
    ],
    planRequired: false,
    reviewer: {
      role: "RETRO",
      depth: "light",
    },
    tries: 3,
  },
  {
    name: "small-change",
    labels: [],
    trigger: "chore, test or docs ticket",
    rounds: 2,
    budget: 120000,
    path: ["implement", "verify", "review", "draft PR"],
    nodes: [
      {
        name: "implement",
        phase: "working",
        role: "GUIDO or INCO",
        checks: [
          {
            kind: "rule",
            text: "Only the paths this ticket type allows changed (tests for test, docs for docs)",
          },
        ],
      },
      {
        name: "verify",
        phase: "ci",
        role: "Mission Control runs it",
        max: 2,
        retry: "fail → back to implement · max 2",
        checks: [
          {
            kind: "cmd",
            text: "Full test suite passes (takes the test lock)",
          },
          {
            kind: "rule",
            text: "No existing test weakened, skipped or deleted",
          },
        ],
      },
      {
        name: "review",
        phase: "review",
        role: "RETRO, fresh eyes",
        retry: "Critical or Important findings → implement → verify",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
      },
      {
        name: "draft PR",
        phase: null,
        role: "GUIDO or INCO",
        checks: [
          {
            kind: "rule",
            text: "PR is open as a draft",
          },
        ],
      },
    ],
    planRequired: false,
    reviewer: {
      role: "RETRO",
      depth: "light",
    },
    tries: 3,
  },
  {
    name: "research",
    labels: [],
    trigger: "label research",
    rounds: 2,
    budget: 150000,
    path: ["investigate", "write-up", "review"],
    nodes: [
      {
        name: "investigate",
        phase: "working",
        role: "NETWORK",
        checks: [
          {
            kind: "agent",
            text: "Every claim cites a file, doc, URL or message",
          },
        ],
      },
      {
        name: "write-up",
        phase: null,
        role: "NETWORK",
        checks: [
          {
            kind: "agent",
            text: "One-line answer first, then the evidence",
          },
        ],
      },
      {
        name: "review",
        phase: "review",
        role: "RETRO (hand-off)",
        retry: "gaps → write-up again",
        checks: [
          {
            kind: "review",
            text: "A second agent re-checked each citation",
          },
        ],
      },
    ],
    planRequired: false,
    reviewer: {
      role: "RETRO",
      depth: "light",
    },
    tries: 3,
  },
  {
    name: "review",
    labels: [],
    trigger: "PR opened in a lane",
    rounds: 1,
    budget: 120000,
    path: ["read PR", "findings", "propose"],
    nodes: [
      {
        name: "read PR",
        phase: null,
        role: "RETRO",
        checks: [
          {
            kind: "agent",
            text: "Diff read against the ticket's intent",
          },
        ],
      },
      {
        name: "findings",
        phase: null,
        role: "RETRO",
        checks: [
          {
            kind: "agent",
            text: "Each finding has file:line and a failure scenario",
          },
        ],
      },
      {
        name: "propose",
        phase: null,
        role: "RETRO",
        checks: [
          {
            kind: "gate",
            text: "Comments wait for your approval; nothing posts on its own",
          },
        ],
      },
    ],
    planRequired: false,
    reviewer: {
      role: "RETRO",
      depth: "light",
    },
    tries: 3,
  },
  {
    name: "tiger-team",
    labels: [],
    trigger: "FLIGHT or you, for a blocker or a big ticket",
    rounds: 2,
    budget: 600000,
    path: ["split", "work ×N", "verify each", "combine", "review"],
    nodes: [
      {
        name: "split",
        phase: null,
        role: "FLIGHT",
        checks: [
          {
            kind: "rule",
            text: "Sub-tasks have areas that don't overlap",
          },
        ],
      },
      {
        name: "work ×N",
        phase: null,
        role: "GUIDO ×N in parallel",
        retry: "runs in parallel, one sub-task per agent",
        checks: [
          {
            kind: "cmd",
            text: "Each sub-task's scoped tests pass",
          },
        ],
      },
      {
        name: "verify each",
        phase: null,
        role: "RETRO",
        max: 2,
        retry: "fail → that sub-task again · max 2",
        checks: [
          {
            kind: "review",
            text: "A verifier confirms each result",
          },
        ],
      },
      {
        name: "combine",
        phase: null,
        role: "GUIDO",
        checks: [
          {
            kind: "cmd",
            text: "Combined branch passes the full suite (takes the test lock)",
          },
        ],
      },
      {
        name: "review",
        phase: "review",
        role: "RETRO, fresh eyes",
        retry: "findings → fix the combined branch",
        checks: [
          {
            kind: "review",
            text: "Spec verdict: does what the ticket asks; every acceptance criterion has evidence",
          },
          {
            kind: "review",
            text: "Quality verdict: no Critical or Important findings (Minor ones are logged, not looped)",
          },
          {
            kind: "rule",
            text: "Blast radius: callers and shared code listed by Mission Control were checked",
          },
          {
            kind: "review",
            text: "Pages it touches opened in a real browser, with screenshots",
          },
        ],
      },
    ],
    planRequired: false,
    reviewer: {
      role: "RETRO",
      depth: "light",
    },
    tries: 3,
  },
  {
    name: "watch",
    labels: [],
    trigger: "every 10 min",
    rounds: 0,
    budget: null,
    path: ["poll", "triage", "assign"],
    nodes: [
      {
        name: "poll",
        phase: null,
        role: "Mission Control",
        checks: [
          {
            kind: "rule",
            text: "Board reachable; new or changed tickets listed",
          },
        ],
      },
      {
        name: "triage",
        phase: null,
        role: "FLIGHT",
        checks: [
          {
            kind: "agent",
            text: "Each ticket matched to a lane and a template",
          },
        ],
      },
      {
        name: "assign",
        phase: null,
        role: "FLIGHT",
        retry: "then poll again in 10 min",
        checks: [
          {
            kind: "gate",
            text: "Starting an agent waits for you unless auto-approved",
          },
        ],
      },
    ],
    planRequired: false,
    reviewer: {
      role: "RETRO",
      depth: "light",
    },
    tries: 3,
  },
];

export const TEMPLATES: ConfigProfile[] = templates.map(({ path, ...template }) => ({
  ...template,
  steps: path.flatMap((name) => template.nodes.filter((node) => node.name === name)),
}));
