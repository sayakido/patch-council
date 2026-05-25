# aictl

`aictl` is a local AI CLI orchestrator. It coordinates multiple AI command line tools through a project-local task store, shared context, and role-based workflows.

The default MVP workflow is:

```text
Codex draft plan
-> OpenCode challenge
-> Codex final plan
-> OpenCode implement
-> Codex review git diff
-> OpenCode fix if required
-> write memory
```

## Install for development

```bash
pip install -e .
```

or:

```bash
pipx install -e .
```

## Commands

```bash
aictl init
aictl doctor
aictl agents
aictl plan "your request"
aictl do
aictl review
aictl auto "your request"
aictl continue
```

## Project files

`aictl init` creates:

```text
.project-ai/
  config.yaml
  memory.md
  decisions.md
  tasks/
```

Each task is stored under `.project-ai/tasks/<task-id>/` with `state.json`, `turns.jsonl`, prompts, plans, reviews, and final notes.

## Agent model

Workflows select agents by capability instead of hard-coded names. The default configuration uses Codex for planning and review, and OpenCode for challenge, implementation, and fixes. Other AI CLIs can be added as `generic_cli` agents in `.project-ai/config.yaml`.
