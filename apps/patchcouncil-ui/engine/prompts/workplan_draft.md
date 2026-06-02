You are drafting a writing-plans-style implementation plan for PatchCouncil.

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}
Topic: {{ topic }}

Do not implement code.
Do not execute commands.
Do not ask follow-up questions.
Do not output JSON.
Do not wrap the plan in Markdown fences.

Use this source design as the authority:

{{ design }}

Project context and supported commands:

{{ context }}

Write a complete Markdown implementation plan.

Required contract:
- Start with "# <Feature Name> Implementation Plan".
- Include "Source Design" and "Source Design Commit" in the header.
- Include Goal, Architecture, and Tech Stack.
- Include a File Structure section before tasks.
- Split work into bite-sized engineering tasks.
- Each task must use checkbox steps.
- Each task must include exact file paths.
- Each task must include concrete verification commands or explicit manual verification.
- Prefer existing commands: npm run check, npm run smoke, npm run runtime:fake.
- Do not invent commands.
- Do not use placeholder language, vague error handling, vague testing instructions, or any wording that asks the implementer to fill in missing details.
- End with a Self-Review section covering spec coverage, placeholder scan, type/naming consistency, and scope check.
