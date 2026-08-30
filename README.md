# my-skills

Reusable agent skills — not tied to any one project or tool. Each top-level folder
is a self-contained skill (instructions + templates/scripts it needs).

Symlink a skill into an agent's skill directory to use it, e.g. for Claude Code:

```bash
ln -s /path/to/my-skills/<skill-name> ~/.claude/skills/<skill-name>
```

## Skills

- **write-lesson** — bootstrap and author pages for an Astro-based study-notes/
  lesson site (component library, dark-mode theme, optional Gemini AI-tutor chat
  sidebar).
