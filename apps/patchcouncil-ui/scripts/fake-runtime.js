const scenario = process.argv[2] || "stream";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeDelta(text, delay = 20) {
  process.stdout.write(JSON.stringify({ type: "delta", text }) + "\n");
  await wait(delay);
}

async function main() {
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
