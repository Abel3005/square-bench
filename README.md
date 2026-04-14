# Square-bench

Square-bench is the benchmark for testing AI agents in real terminal environments.

Harness Engineering has been primary in AI.

So We should test and verify it.

## Evaluation Process

1. User input Dataset, Agent, etc.
2. Iterate 3- Each element of Datasets 
4. Clone the repository in project workspace
4. Agent run with workspace and prompt template and its output stream out event file
5. Evaluate Outputs with `swebench.harness.run_evaluation`

## Agents

**Access Squarecode**:

squarecode is cli agent program.

- **run squarecode**: squarecode run [prompt]
- **run squarecode**: squarecode run --agent=deepwork-headless [prompt]


## Dataset

- Every Dataset must has list that consist of ["repo","base_commit","problem_statement"]
- repo: github repository url
- base_commit: hash of commit


## Prompt Template

```
You are fixing a real bug in {repo} at commit {base_commit}.

<problem_statement>
{problem_statement}
</problem_statement>

Work in the current directory (already checked out at the base commit).
Edit the source files to resolve the problem. Do not commit.
When done, exit.
```


## Platform

- **Next.js(16.2.3)**: Check dataset and modified file by Agent.
- **FastAPI**: interact with Next.js server. It makes local cli agent's results connect the webserver.
- **tailwindCSS(^4)**: CSS style

## Open question

- we open to contribute this code.
- consider the PLAN.md that has our plan and bugs