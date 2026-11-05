# AGENTS.md

Guidance for AI agents working in this repository. `CLAUDE.md` imports this file, so keep shared instructions here.

## Purpose

This repository is a personal collection of Agent Skills. A skill is a self-contained folder containing a `SKILL.md` file with YAML frontmatter and instructions the agent loads on demand.

## Layout

- `skills/<name>/SKILL.md` — canonical location; all skills live here.
- `.agents/skills` — symlink to `../skills`; never add or edit files through this path.
- `.claude/skills` — symlink to `../skills`; never add or edit files through this path.
- `CLAUDE.md` — Claude Code entry point; it imports this file.
- `README.md` — user-facing overview.

## Creating or editing a skill

1. Create `skills/<name>/`.
2. Add `SKILL.md` with YAML frontmatter:
   - `name` — lowercase letters, numbers, and hyphens only; must match the folder name; at most 64 characters.
   - `description` — what the skill does and when to use it; at most 1024 characters. State the trigger conditions explicitly, since agents use this field to decide whether to load the skill.
3. Keep `SKILL.md` concise. Put long reference material in `references/`, helper scripts in `scripts/`, and templates or static assets in `assets/`.
4. Make skills self-contained: do not reference files outside the skill folder.
5. Write instructions that are imperative and tool-agnostic where possible.

## Conventions

- Do not modify, replace, or duplicate the `.agents/skills` and `.claude/skills` symlinks.
- Do not create skills directly in `.agents/` or `.claude/`.
- Keep each skill focused on one task; split unrelated capabilities into separate skills.
- Verify that any commands or scripts in a skill run successfully before committing.
