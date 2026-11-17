---
name: smart-delegation
description: Guidelines to help you to work smartly by spawning child agents. Must use for huge work where decomposition is beneficial, before calling the `spawn` tool.
---

Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

A fresh agent costs more than it looks. It knows only what you put in the prompt, and you see only the summary it sends back — both handoffs drop detail, and neither of you can tell what the other missed. You can't watch it work, only wait or cancel. Its mistakes come back in the same confident register as its findings, and an agent handed your hypothesis tends to return it confirmed. Several at once spend tokens in a burst the leader didn't ask for. Weigh those tokens against the accuracy they buy: the leader pays for agents you did not need, and pays again for work you redo because you skipped one.

Reach for this when you have independent work to run in parallel, when the leader asks for a side quest that shouldn't block your main thread, or when answering would mean reading across several files — delegate that and you keep the conclusion, not the file dumps.

Do the work yourself when it is a handful of tool calls or a lookup whose target you already know; don't delegate a check you could run inline. Delegate review only when you want a read that isn't anchored on yours — then give it the code, not your conclusion. Once you've delegated something, don't also run it yourself; wait for the result. When in doubt, don't spawn.

When you do spawn one, brief it like the peer it is: state the goal and what you have already ruled out, point it at the files and docs worth reading instead of retyping them, and keep the scope explicit and narrow. That brief is the only context it will have, so it is your first lever on every cost above — and if you cannot write a clear one, you do not understand the task well enough to hand it off.

Subagents run in the background; you'll be notified when one completes or talks to you. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the leader asks before it arrives, say it's still running. You can also talk to an agent whenever it is running or idle to steer, inquiry, or assign a new task.

Before spawning agents, if the agents' tasks are closely related under one topic, you SHOULD create a temporary markdown file, or reuse a previous one, that elaborates current goals and context, and pass this file as the topic when spawning agents so they work as a team. The topic file is shared - use for team context, the prompt is per-agent - use for granular assignment. These two composes the model's initial understanding. The topic file can be updated, and all agents under it will be notified about the change. Newly spawned agents already know the topic, no need to read.

What in the topic file: goal, shared context and resources, todo list or DAG (three purposes: show current progress, split tasks between agents, and let agents know what each peer is doing). Update it as the task progress. Keep the topic file concise, garbage / verbose information pollutes everyone's context.

Task execution accumulates context, and context overload costs token and harms execution quality. Keep each agent's task narrow and prefer spawning new agents under the same topic when the task isn't closely related to any of the existing agent's context, rather than continuously letting one agent do all the work. Agents inside the same topic can talk to each other.

If the execution plan is well-defined. And you can clearly resolve dependencies, maximize speed by parallelization, and ensure each agent has clear, non-overlapping scope and target. Construct a DAG and execute according to it. When spawning agents in a row, ALWAYS review before continuing delegation.

Each agent type's model, reasoning effort, and tools come from its definition (`harness.config.ts` at CWD or `~/.pi/agent/`).
