# Learning Framework

The learning hub is a public, read-only module for organising a long-term learning
plan inside Cairn. It stores no personal data and makes no network requests.

## Purpose

Use the page to keep four things together:

1. a dependency-aware knowledge tree;
2. a self-assessment of current skills;
3. a sequence of project-driven learning phases;
4. reusable prompts for teaching, evaluation, and literature mapping.

The text shipped with Cairn is a neutral template. Replace it with your own plan
through a local module customisation; do not commit personal goals, transcripts,
course schedules, email addresses, or private project names to a public fork.

## Suggested structure

| Layer | Example scope | Completion check |
| --- | --- | --- |
| Foundations | programming, data structures, testing | can explain and apply the basics without copying an answer |
| Systems | operating systems, networking, concurrency | can trace a failure path and explain recovery |
| Architecture | interfaces, contracts, modules, observability | can justify boundaries and replace one implementation |
| Machine learning | mathematics, training, evaluation | can explain assumptions, metrics, and failure modes |
| Agents | planning, tools, memory, evaluation | can turn an observed problem into a testable hypothesis |
| Security | least privilege, sandboxing, trust boundaries | can identify each trust boundary and its controls |
| Research method | question, baseline, experiment, analysis | can produce a reproducible experiment and report |

## Weekly loop

Project work → identify a knowledge gap → study the prerequisite → return to the
project → explain the result → read related work → formulate a small experiment.

## Public-content boundary

The public module is a framework, not a personal profile. Keep local
customisations separate from the repository and review every Markdown file for
identifying details before publishing a fork.
