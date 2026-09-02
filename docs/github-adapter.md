# GitHub task and dependency adapters

The built-in GitHub pair turns selected repository issues and native issue dependencies into the
normalized task DAG. It uses the authenticated `gh` CLI by default; `AGENT_RUNNER_GH_BIN` selects a
different compatible executable for testing or installation control.

## Selection

```yaml
tasks:
  provider: github
  dependencies: github-native
  config:
    includeLabels:
      - agent:task
```

When `includeLabels` is present, an issue must contain every configured label. With no labels
configured, every issue is selected. Pull requests returned by the REST issues endpoint are always
excluded.

## Normalization

- Task id: `issue-<number>`
- Source id: the GitHub issue number
- Revision: GitHub node id plus `updated_at`
- Pending: an open selected issue
- Completed: a closed issue except `not_planned`
- Blocked: `not_planned` or an open issue labeled `agent:blocked`
- Prompt: issue title, URL, and body

Native `blocked by` relationships become dependency edges. Same-repository dependencies must refer
to another discovered issue. Missing issues, pagination/schema errors, and cross-repository
dependencies fail closed. Cross-repository DAGs require an explicit later design rather than silently
collapsing identities.

Dependency reads use at most four concurrent requests by default to reduce secondary-rate-limit
pressure. Every REST call requests GitHub API version `2026-03-10` and handles all pages.

## Read-only inspection

After registration:

```text
agent-runner ready owner/repository
```

This refreshes issues and dependencies, validates the graph, and prints ready, waiting, blocked, and
completed task ids. It does not claim or execute work.

## Live dogfood evidence

Agent Runner's external dogfood contract selects its own `agent:task` issues. The first GitHub
graph contains [RUN-01](https://github.com/theycallme-eric/agent-runner/issues/1) and dependent
[DELIVERY-01](https://github.com/theycallme-eric/agent-runner/issues/2). A live `ready` refresh on
2026-08-31 returned RUN-01 as ready, DELIVERY-01 as waiting, and exactly one dependency edge. The
controller registration database and project contract used for this check now live in the external
project-support workspace; the visible task graph remains on GitHub.

## Sources

- [GitHub issue dependency API](https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2026-03-10)
- [Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)
- [GitHub issues API](https://docs.github.com/en/rest/issues?apiVersion=2026-03-10)
