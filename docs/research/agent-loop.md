# How Writey's agent loop should work (research, 2026-10-26)

The owner asked for Writey's pen agent to work like a real agent: the model decides what to do, and Writey shouldn't save tokens by cutting the answer down. This note sums up how current coding agents run their loops and what Writey takes from them.

## What coding agents do

**The loop is simple, and the model is in charge.** Claude Code, Codex CLI, OpenCode and mini-SWE-agent all run the same loop: call the model, run the tools it asks for, append the results, and repeat until it replies without a tool call. There is no planner and no scripted steps. The only limits are a turn cap or a budget, for safety. mini-SWE-agent does over 70% on SWE-bench Verified with about 100 lines and a fully linear history.
Sources: [Claude Agent SDK, agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop), [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), [Claude Code's master loop](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/).

**Cost is controlled by the prompt cache, not by cutting the work.** Providers cache prompt prefixes automatically: cached input is 50–90% cheaper and up to 80% faster to the first token. Agents keep hit rates around 80–90% with three rules:

1. The system prompt and tool definitions are identical on every request, with nothing per request or per day in them.
2. The history is append-only: each request starts with the previous one exactly. Editing an earlier message breaks the cache from that point on.
3. Dynamic content (tool results, new screenshots) goes at the end.

Sources: [Prompt caching in Codex CLI](https://codex.danielvaughan.com/2026/04/21/codex-cli-prompt-caching-maximise-cache-hits-cost-reduction/), [Don't break the cache](https://codex.danielvaughan.com/2026/06/19/dont-break-the-cache-prompt-caching-research-codex-cli-cost-latency-optimisation-agent-loop/), [OpenAI reasoning items cookbook](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items) (keeping reasoning items raised cache use from 40% to 80%).

**Docs load just in time.** Claude Code keeps core tools in the prompt but loads skills and extra tool schemas only when they're needed (skills and tool search). Anthropic's context-engineering guide says to aim for the "smallest set of high-signal tokens", with lightweight references that are loaded on demand.
Sources: [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Agent SDK: what consumes context](https://code.claude.com/docs/en/agent-sdk/agent-loop#the-context-window).

**Tools are few, consolidated and hard to misuse.** Anthropic's guidance: fewer tools that each cover a whole workflow, errors that are specific and actionable, and inputs designed so mistakes are hard to make ("poka-yoke").
Sources: [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

**Old screenshots are pruned, a few at a time.** Computer-use agents keep the last two or three screenshots and replace older ones with a text placeholder. This keeps the cost from growing with every look, while the prefix changes only now and then.
Sources: [Claude Code issue on screenshot eviction](https://github.com/anthropics/claude-code/issues/27869), [Magnitude memory docs](https://docs.magnitude.run/advanced/memory), [recency in GUI agents](https://arxiv.org/pdf/2603.26041).

**Retries and recovery stay inside the loop.** Agents use backoff on rate limits and overloads, carry on after an output-limit cut-off, and send tool errors back to the model instead of stopping. Writey already did this (D47).
Source: [Claude Code vs Codex loop architectures](https://codex.danielvaughan.com/2026/04/09/claude-code-query-engine-vs-codex-rs-agent-loop/).

## Where Writey went wrong

Writey's loop was already agentic (D46). What made one integral cost 128k tokens was the way it fed the model, not the agency:

- **The cache broke every time.** The history wasn't append-only: each `look_at_page` rewrote every earlier message to drop its images. And the system prompt changed with each request.
- **The token count hid the cache.** The 128k figure counted cached and uncached tokens the same.
- **Every request carried about 5k tokens of guides** for graphs, physics and chemistry, even for an integral.
- **Working lines could be placed by pixels.** The model guessed coordinates and letter sizes for each line, which is what made the ink tiny and overlapping.

## What changed (HANDOFF D51)

- **The model decides everything again.** No step budget or length limits in the prompt, and the full teaching guidance for the margin is back. Reasoning effort is medium (high for full solutions and checks). The 40-request safety cap stays.
- **The system prompt is static.** It's identical for every request and every answer, so it stays cached. Spoken-reply instructions and hints moved into the user message.
- **Diagram guides load like skills.** `diagram_guide {topics}` loads graphs, physics, chemistry or pictures on demand, and the system prompt lists what each topic covers.
- **The history is append-only.** The newest three pictures of the page (and three close-ups) are kept; older ones become a short note.
- **ChatGPT gets a `prompt_cache_key`** per notebook, so requests reach the same cache.
- **The chat shows cached tokens**, e.g. "128.7k tokens (110k cached)", so the cost is visible honestly.
- **Tools are consolidated and harder to misuse.** `write_math` takes several lines in one call. Working lines always flow down the page, and pinned labels have a minimum size and never land on other writing.

## Not adopted (yet)

- **A todo or plan tool** like Claude Code's TodoWrite. It's useful for long multi-part tasks, but a page answer is short. Revisit if the model loses track on long solutions.
- **Compaction.** One answer stays far below the context limit.
- **Running read-only tools in parallel.** Writey's tools are fast and on-page order matters.
