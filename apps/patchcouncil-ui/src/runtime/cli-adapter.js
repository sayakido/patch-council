const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");
const { resolveCommand } = require("./resolve-command");

function runCliRuntime(options) {
  const emitter = new EventEmitter();
  const runtime = options.runtime || "runtime";
  const command = options.command;
  const args = Array.isArray(options.args) ? options.args : [];
  const input = typeof options.input === "string" ? options.input : "";
  const inputMode = options.input_mode || options.inputMode || (input ? "stdin" : "none");
  const finalArgs = buildArgs(args, input, inputMode);
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const timeoutMs = Number(options.timeoutMs || 0);
  const killGraceMs = Number(options.killGraceMs || 1500);
  const threadId = options.threadId || `${runtime}-thread`;
  const turnId = options.turnId || `${runtime}-turn-${Date.now()}`;
  const resolved = resolveCommand(command, { cwd, env });

  let child = null;
  let settled = false;
  let timeout = null;
  let stdoutText = "";
  let stderrText = "";
  let replyText = "";
  let killedForTimeout = false;
  let completedEventEmitted = false;

  const done = new Promise((resolve) => {
    function emit(event) {
      emitter.emit("event", event);
      emitter.emit(event.type, event);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    }

    setImmediate(() => {
      if (!resolved) {
        const message = `command not found: ${command}`;
        emit(turnFailed(runtime, threadId, turnId, message));
        finish({ ok: false, runtime, threadId, turnId, error: message, events: [] });
        return;
      }

      child = spawn(resolved, finalArgs, {
        cwd,
        env,
        windowsHide: true,
        stdio: [inputMode === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
      });

      emit({
        type: "runtime.turn.started",
        runtime,
        thread_id: threadId,
        turn_id: turnId,
        command: resolved,
        args: finalArgs,
      });

      if (inputMode === "stdin" && child.stdin) {
        child.stdin.end(input);
      }

      child.on("error", (error) => {
        emit(turnFailed(runtime, threadId, turnId, error.message));
        finish({ ok: false, runtime, threadId, turnId, error: error.message, stdout: stdoutText, stderr: stderrText });
      });

      const stdoutLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      const stderrLines = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

      stdoutLines.on("line", (line) => {
        stdoutText += line + "\n";
        const parsed = parseRuntimeLine(line);
        if (parsed?.type === "delta") {
          replyText += parsed.text;
          emit({
            type: "runtime.reply.delta",
            runtime,
            thread_id: threadId,
            turn_id: turnId,
            text: parsed.text,
          });
          return;
        }
        if (parsed?.type === "completed") {
          completedEventEmitted = true;
          replyText = parsed.text || replyText;
          emit({
            type: "runtime.reply.completed",
            runtime,
            thread_id: threadId,
            turn_id: turnId,
            item_id: parsed.itemId || `${turnId}-reply`,
            text: parsed.text || replyText,
          });
          return;
        }
        if (parsed?.type === "ignored") {
          return;
        }
        replyText += line + "\n";
        emit({
          type: "runtime.reply.delta",
          runtime,
          thread_id: threadId,
          turn_id: turnId,
          text: line + "\n",
        });
      });

      stderrLines.on("line", (line) => {
        stderrText += line + "\n";
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        if (code === 0 && !killedForTimeout) {
          const text = replyText.trimEnd();
          if (text && !completedEventEmitted) {
            emit({
              type: "runtime.reply.completed",
              runtime,
              thread_id: threadId,
              turn_id: turnId,
              item_id: `${turnId}-reply`,
              text,
            });
          }
          emit({
            type: "runtime.turn.completed",
            runtime,
            thread_id: threadId,
            turn_id: turnId,
          });
          finish({ ok: true, runtime, threadId, turnId, stdout: stdoutText, stderr: stderrText, text });
          return;
        }

        const message = killedForTimeout
          ? `runtime timed out after ${timeoutMs}ms`
          : `runtime exited with code ${code}${signal ? ` signal ${signal}` : ""}`;
        emit(turnFailed(runtime, threadId, turnId, message));
        finish({ ok: false, runtime, threadId, turnId, error: message, stdout: stdoutText, stderr: stderrText });
      });

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (!child || child.killed || settled) return;
          killedForTimeout = true;
          terminateProcess(child, killGraceMs);
        }, timeoutMs);
      }
    });
  });

  return {
    emitter,
    done,
    cancel(reason = "cancelled") {
      if (!child || child.killed) return;
      killedForTimeout = true;
      terminateProcess(child, killGraceMs);
      emitter.emit("event", turnFailed(runtime, threadId, turnId, reason));
    },
  };
}

function buildArgs(args, input, inputMode) {
  if (!input || inputMode !== "argument") return args.slice();
  const printFlagIndex = args.findIndex((arg) => arg === "-p" || arg === "--print");
  if (printFlagIndex >= 0) {
    return [
      ...args.slice(0, printFlagIndex + 1),
      input,
      ...args.slice(printFlagIndex + 1),
    ];
  }
  return [...args, input];
}

function parseRuntimeLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const data = JSON.parse(trimmed);
    if (data.type === "delta") {
      return { type: "delta", text: String(data.text || "") };
    }
    if (data.type === "completed") {
      return { type: "completed", text: String(data.text || ""), itemId: data.item_id };
    }
    if (data.type === "item.completed" && data.item?.type === "agent_message") {
      return { type: "completed", text: String(data.item.text || ""), itemId: data.item.id };
    }
    if (data.type === "result" && data.subtype === "success") {
      return { type: "completed", text: String(data.result || "") };
    }
    if (data.type === "stream_event") {
      const event = data.event || {};
      const delta = event.delta || {};
      if (event.type === "content_block_delta" && delta.type === "text_delta") {
        return { type: "delta", text: String(delta.text || "") };
      }
      return { type: "ignored" };
    }
    if (isKnownRuntimeEnvelope(data.type)) {
      return { type: "ignored" };
    }
  } catch {
    return null;
  }
  return null;
}

function isKnownRuntimeEnvelope(type) {
  return [
    "thread.started",
    "turn.started",
    "turn.completed",
    "system",
    "assistant",
  ].includes(type);
}

function turnFailed(runtime, threadId, turnId, message) {
  return {
    type: "runtime.turn.failed",
    runtime,
    thread_id: threadId,
    turn_id: turnId,
    message,
  };
}

function terminateProcess(child, killGraceMs) {
  if (process.platform === "win32" && child.pid) {
    try {
      child.kill();
    } catch {
      // fall through to taskkill
    }
    setTimeout(() => {
      if (child.killed) return;
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    }, killGraceMs).unref();
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {
      // process already gone
    }
  }, killGraceMs).unref();
}

module.exports = { runCliRuntime, parseRuntimeLine };
