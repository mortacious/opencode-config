#!/usr/bin/env node
/**
 * Fake kernel host for unit tests.
 *
 * Usage: node fake-host.mjs <mode>
 * Modes: echo (default), echo-error, frames, garbage, fatal, exit-early,
 *        silent, pending
 *
 * Speaks the host JSON-lines protocol: stdin carries exec/interrupt/shutdown,
 * stdout carries ready/stream/result/done/fatal.
 */
import process from "node:process";

const mode = process.argv[2] ?? "";
let buffer = "";

// Node's test runner also executes every file under test/, so a bare run with
// no mode argument (no driver attached) must exit instead of waiting on stdin.
if (mode === "") {
  process.stderr.write("fake-host fixture: pass a mode argument\n");
  process.exit(0);
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function ready() {
  write({
    op: "ready",
    python: process.execPath,
    pythonVersion: "fake",
    kernel: "fake",
    pid: process.pid,
  });
}

function diag(text) {
  process.stderr.write(`[fake-host] ${text}\n`);
}

function exitSoon(code = 0) {
  setTimeout(() => process.exit(code), 10);
}

function readMessages(handler) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      handler(message);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

function execReply(message, status = "ok") {
  write({ op: "stream", id: message.id, name: "stdout", text: `echo:${message.code}` });
  write({
    op: "result",
    id: message.id,
    executionCount: 1,
    data: { "text/plain": "1" },
    metadata: {},
  });
  write({
    op: "done",
    id: message.id,
    status,
    executionCount: 1,
    lost: false,
  });
}

if (mode === "exit-early") {
  diag("exiting before ready");
  process.exit(0);
} else if (mode === "silent") {
  ready();
  readMessages((message) => {
    if (message.op === "shutdown") process.exit(0);
  });
} else if (mode === "pending") {
  ready();
  const pending = new Set();
  readMessages((message) => {
    if (message.op === "exec") {
      pending.add(message.id);
    } else if (message.op === "interrupt") {
      for (const id of pending) {
        write({ op: "done", id, status: "interrupted", executionCount: 0, lost: false });
      }
      pending.clear();
    } else if (message.op === "shutdown") {
      process.exit(0);
    }
  });
} else if (mode === "frames") {
  const line = `${JSON.stringify({
    op: "ready",
    python: process.execPath,
    pythonVersion: "fake",
    kernel: "fake",
    pid: process.pid,
  })}\n`;
  process.stdout.write(line.slice(0, 9));
  setTimeout(() => process.stdout.write(line.slice(9)), 15);
  readMessages((message) => {
    if (message.op === "exec") {
      const done = `${JSON.stringify({
        op: "done",
        id: message.id,
        status: "ok",
        executionCount: 7,
        lost: true,
      })}\n`;
      const cut = Math.floor(done.length / 2);
      process.stdout.write(done.slice(0, cut));
      setTimeout(() => process.stdout.write(done.slice(cut)), 15);
    } else if (message.op === "shutdown") {
      process.exit(0);
    }
  });
} else if (mode === "garbage") {
  process.stdout.write("this is not json\n");
  process.stdout.write("\n");
  ready();
  readMessages((message) => {
    if (message.op === "exec") execReply(message);
    else if (message.op === "shutdown") process.exit(0);
  });
} else if (mode === "fatal") {
  ready();
  readMessages((message) => {
    if (message.op === "exec") {
      write({ op: "fatal", message: "boom", traceback: "Traceback: boom" });
      exitSoon(1);
    } else if (message.op === "shutdown") {
      process.exit(0);
    }
  });
} else {
  diag("started");
  ready();
  readMessages((message) => {
    if (message.op === "exec") {
      execReply(message, mode === "echo-error" ? "error" : "ok");
    } else if (message.op === "interrupt") {
      write({ op: "stream", name: "stdout", text: "interrupted" });
    } else if (message.op === "shutdown") {
      process.exit(0);
    }
  });
}
