const scenario = process.argv[2] || "stream";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeDelta(text, delay = 20) {
  process.stdout.write(JSON.stringify({ type: "delta", text }) + "\n");
  await wait(delay);
}

async function main() {
  if (scenario === "echo-arg") {
    process.stdout.write(process.argv[3] || "");
    return;
  }

  if (scenario === "echo-stdin") {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(input);
    return;
  }

  if (scenario === "codex-jsonl") {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Codex JSONL final text." },
    }) + "\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\n");
    return;
  }

  if (scenario === "claude-jsonl") {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude " } },
    }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "JSONL partial." } },
    }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Claude JSONL final text.",
    }) + "\n");
    return;
  }

  if (scenario === "stream") {
    await writeDelta("Hello ");
    await writeDelta("from ");
    await writeDelta("fake runtime.");
    process.stdout.write(JSON.stringify({ type: "completed", text: "Hello from fake runtime." }) + "\n");
    return;
  }

  if (scenario === "plain") {
    process.stdout.write("plain line one\n");
    await wait(20);
    process.stdout.write("plain line two\n");
    return;
  }

  if (scenario === "crash") {
    process.stderr.write("simulated crash\n");
    process.exit(7);
  }

  if (scenario === "hang") {
    process.stdout.write(JSON.stringify({ type: "delta", text: "starting hang" }) + "\n");
    await wait(60_000);
    return;
  }

  process.stderr.write(`unknown scenario: ${scenario}\n`);
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exit(1);
});
