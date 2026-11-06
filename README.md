# skills

4x25's skills for personal use.

A personal collection of [Agent Skills](https://agentskills.io) — portable `SKILL.md` folders that work with Claude Code, Codex, and other compatible agent harnesses.

## Included skills

- [`gold-price`](skills/gold-price/SKILL.md) — Ping An digital/physical gold prices and range history, plus ICBC physical gold prices.
- [`exchange-rate`](skills/exchange-rate/SKILL.md) — Bank foreign-exchange purchase/settlement quotes and range history, starting with Ping An's 10 currencies.

## Structure

```text
.
├── skills/                 # Canonical skills, one folder per skill
│   └── <skill-name>/
│       └── SKILL.md
├── .agents/skills          # Symlink → ../skills
├── .claude/skills          # Symlink → ../skills
├── AGENTS.md               # Repository guidance for agents
├── CLAUDE.md               # Claude Code entry point (imports AGENTS.md)
└── README.md
```

`.agents/skills` and `.claude/skills` are relative symlinks to the top-level `skills/` directory, so each skill has a single source of truth while staying discoverable in both layouts.

## Adding a skill

```bash
mkdir -p skills/my-skill
$EDITOR skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: What the skill does and when an agent should use it.
---

# My Skill

Instructions for the agent go here.
```

## Using a skill

- **In this repo:** Claude Code discovers skills through `.claude/skills`; other agent harnesses use `.agents/skills`. Both point at `skills/`.
- **In another project:** link the skill folder into that project's `.claude/skills/` or `.agents/skills/`.
- **As a personal skill:** link it into `~/.claude/skills/` (or the equivalent directory of your agent harness).
