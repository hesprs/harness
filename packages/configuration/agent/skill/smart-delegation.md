---
name: smart-delegation
description: Guidelines to help you to work smartly by spawning child agents. Must use for huge work where decomposition is beneficial.
---

## 1. Evaluation

Evaluate the optimal agent delegation strategy to achieve the goal, principles:

- Depending on the size of the plan, if the plan only involves one to two files, code all by yourself. Otherwise use child agents.
- Before spawning agents, if the agents' tasks are closely related under one topic, you SHOULD create a temporary markdown file elaborating current goals and context, and pass this file as the topic when spawning agents. The topic file is shared - use for team context, the prompt is per-agent - use for granular task assignment. These two composes the model's initial understanding, they don't inherit your context.
- Each agent focus on one atomic task
- Don't let one agent do all the work. If you find spawning only one agent is enough, it often means you don't need other agents at all, do it all by yourself.
- Resolve task dependency, maximize speed by parallelization, ach agent has clear scope and target without overlapping. Goal is to construct a **DAG** of agent execution that completes the task.
- Common dependencies:
  - install deps before implementation
  - tests after public interface is pinned, before concrete implementation
  - shared parts first, then individual consumers

After evaluation, save your detailed plan to the personal note.

## 2. Implement

Delegate agents in the correct order and wait them to finish.

After all agents finish, read the files that they are supposed to change. If the implementation is not complete, does not comply with the canonical plan, or obviously flawed, resume the corresponding session and tell it to finish. ALWAYS review before continuing delegation.

Real-time communication is as important as planning and implementation. You can see what agents are doing through their personal notes. If some agents stall or are going to the wrong direction, `talk` to them directly.
