#!/usr/bin/env python3
"""JSON-lines host for one persistent Python kernel.

Protocol
--------
stdin (one JSON object per line):
  {"op":"exec","id":"<uuid>","code":"...","timeoutSec":30,"reset":false}
  {"op":"interrupt"}
  {"op":"shutdown"}

stdout (one JSON object per line, flushed):
  {"op":"ready","python":"...","pythonVersion":"...","kernel":"...","pid":N}
  {"op":"reset_ok"}
  {"op":"stream","id":"...","name":"stdout|stderr","text":"..."}
  {"op":"display","id":"...","data":{...},"metadata":{...},"transient":{...}}
  {"op":"update_display","id":"...","data":{...},"transient":{...}}
  {"op":"clear_output","id":"...","wait":false}
  {"op":"result","id":"...","executionCount":N,"data":{...},"metadata":{...}}
  {"op":"error","id":"...","ename":"...","evalue":"...","traceback":[...]}
  {"op":"done","id":"...","status":"ok|error|timeout|interrupted",
   "executionCount":N,"lost":false}
  {"op":"fatal","message":"...","traceback":"..."}

stderr carries diagnostics only.

State directory
---------------
The ephemeral kernelspec is written under `<state>/kernels/<name>/kernel.json`
where `<state>` is `--state` when given and the journal directory otherwise.
The host reads it through a private KernelSpecManager, so the user's kernelspec
registry is never written or needed for an absolute interpreter path.
"""

import argparse
import copy
import hashlib
import json
import os
import platform
import queue
import shutil
import signal
import sys
import tempfile
import threading
import time
import traceback
import uuid

DEFAULT_TIMEOUT_SEC = 30.0
MAX_TIMEOUT_SEC = 3600.0
IDLE_REPLY_GRACE = 2.0
INTERRUPT_GRACE = 5.0
FORWARD_CAP_BYTES = 10 * 1024 * 1024
FORWARD_NOTICE = "\n[truncated: forwarding limit of 10 MiB per call reached]\n"
JOURNAL_CELL_CAP_BYTES = 2 * 1024 * 1024
CELL_TRUNCATION_NOTICE = "\n[truncated: cell output exceeded 2 MiB]\n"
IMAGE_TRUNCATION_NOTICE = "[truncated image data]"
NBFORMAT_MAJOR = 4
NBFORMAT_MINOR = 5
EXPORT_MAX_CODE_CELLS = 1000
EXPORT_CELL_CAP_BYTES = 2 * 1024 * 1024
EXPORT_CELL_NOTICE = "\n[truncated: cell output exceeded 2 MiB during export]\n"
EXPORT_CELLS_NOTICE = (
    "Notebook truncated: only the first %d code cells were exported."
    % EXPORT_MAX_CODE_CELLS
)
DEFAULT_KERNELSPEC = {
    "name": "python3",
    "display_name": "Python 3",
    "language": "python",
}
DEFAULT_LANGUAGE_INFO = {"name": "python"}
DROP_ENV = ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "IPYTHONDIR")

STARTUP_CELL = (
    "import os as _kh_os, sys as _kh_sys\n"
    "_kh_cwd = _kh_os.getcwd()\n"
    "if _kh_cwd not in _kh_sys.path:\n"
    "    _kh_sys.path.insert(0, _kh_cwd)\n"
)


def emit(obj):
    """Write one protocol event to stdout and flush."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def diag(message):
    """Write one diagnostic line to stderr."""
    stamp = time.strftime("%H:%M:%S")
    sys.stderr.write("[kernel-host %s] %s\n" % (stamp, message))
    sys.stderr.flush()


def normalize_timeout(value):
    """30 s default, 0 disables the deadline, otherwise clamp to 1..3600."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SEC
    if seconds <= 0:
        return 0.0
    return min(max(seconds, 1.0), MAX_TIMEOUT_SEC)


class ExecState:
    """Mutable bookkeeping for one exec call."""

    def __init__(self, exec_id, code):
        self.id = exec_id
        self.code = code
        self.msg_ids = set()
        self.count = None
        self.reply = None
        self.saw_error = False
        self.outputs = []
        self.pending_clear = False
        self.forwarded_bytes = 0
        self.forward_cut = False
        self.interrupted = False


class KernelHost:
    def __init__(self, selection, cwd, journal_path, meta_path, state_dir=None):
        self.selection = selection
        self.cwd = os.path.abspath(cwd)
        self.journal_path = os.path.abspath(journal_path)
        self.meta_path = os.path.abspath(meta_path)
        state = state_dir or os.path.dirname(self.journal_path)
        self.state_dir = os.path.abspath(state)
        self.kernel_name = ""
        self.kernelspec_meta = {}
        self.interpreter = ""
        self.ksm = None
        self.km = None
        self.kc = None
        self.stop_evt = None
        self.readers = []
        self.gen = 0
        self.msgq = queue.Queue()
        self.deferred = []
        self.pending_boundary = False
        self.had_kernel = False
        self.language_info = {}
        self.last_count = 0
        self.cells = 0
        self.any_truncated = False
        self.shutting_down = False

    # ------------------------------------------------------------------
    # kernelspec and environment
    # ------------------------------------------------------------------
    def prepare(self):
        """Resolve the selection into a kernel name plus a spec manager."""
        from jupyter_client.kernelspec import KernelSpecManager

        os.makedirs(self.state_dir, exist_ok=True)
        if not os.path.isdir(self.cwd):
            raise RuntimeError("project cwd does not exist: " + self.cwd)
        if os.path.isabs(self.selection):
            python = os.path.abspath(self.selection)
            if not os.path.exists(python):
                raise RuntimeError("kernel interpreter not found: " + python)
            name = "kernelhost-" + hashlib.sha1(python.encode("utf-8")).hexdigest()[:12]
            kernels_dir = os.path.join(self.state_dir, "kernels")
            spec_dir = os.path.join(kernels_dir, name)
            os.makedirs(spec_dir, exist_ok=True)
            display = "Python 3 (" + python + ")"
            spec = {
                "argv": [python, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                "language": "python",
                "display_name": display,
            }
            with open(os.path.join(spec_dir, "kernel.json"), "w", encoding="utf-8") as fh:
                json.dump(spec, fh)
            self.ksm = KernelSpecManager(kernel_dirs=[kernels_dir])
            resolved = self.ksm.get_kernel_spec(name)
            self.kernel_name = name
            self.interpreter = python
            self.kernelspec_meta = {
                "name": name,
                "display_name": resolved.display_name,
                "language": resolved.language,
            }
            return

        self.ksm = KernelSpecManager()
        spec = self.ksm.get_kernel_spec(self.selection)
        argv0 = spec.argv[0] if spec.argv else ""
        if os.path.isabs(argv0):
            python = argv0
        else:
            python = shutil.which(argv0) or sys.executable
        self.kernel_name = self.selection
        self.interpreter = os.path.abspath(python)
        self.kernelspec_meta = {
            "name": self.selection,
            "display_name": spec.display_name,
            "language": spec.language,
        }

    def _kernel_env(self):
        env = {k: v for k, v in os.environ.items() if k not in DROP_ENV}
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        bindir = os.path.dirname(self.interpreter)
        if bindir:
            env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
        return env

    # ------------------------------------------------------------------
    # kernel lifecycle
    # ------------------------------------------------------------------
    def start_kernel(self, emit_ready=True):
        from jupyter_client import KernelManager

        self._teardown_kernel()
        km = KernelManager(kernel_name=self.kernel_name, kernel_spec_manager=self.ksm)
        try:
            km.start_kernel(cwd=self.cwd, env=self._kernel_env())
        except Exception as exc:
            raise RuntimeError("kernel start failed: " + str(exc))
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=60)
        except Exception as exc:
            try:
                kc.stop_channels()
            except Exception:
                pass
            try:
                km.shutdown_kernel(now=True)
            except Exception:
                pass
            raise RuntimeError("kernel did not become ready: " + str(exc))

        self.gen += 1
        self.km = km
        self.kc = kc
        self.stop_evt = threading.Event()
        self.readers = []
        gen = self.gen
        for channel, reader in (("iopub", kc.get_iopub_msg), ("shell", kc.get_shell_msg)):
            thread = threading.Thread(
                target=self._reader_loop,
                args=(channel, reader, gen, self.stop_evt),
                daemon=True,
            )
            thread.start()
            self.readers.append(thread)

        info = self._kernel_info()
        lang = (info.get("content") or {}).get("language_info") or {}
        if lang:
            self.language_info = lang
        self._startup_probe()
        self.had_kernel = True
        self._write_meta()
        if emit_ready:
            emit(
                {
                    "op": "ready",
                    "python": self.interpreter,
                    "pythonVersion": str(
                        self.language_info.get("version")
                        or platform.python_version()
                    ),
                    "kernel": self.kernel_name,
                    "pid": self._kernel_pid(),
                }
            )
        return True

    def _reader_loop(self, channel, getter, gen, stop_evt):
        while not stop_evt.is_set():
            try:
                msg = getter(timeout=0.2)
            except queue.Empty:
                continue
            except Exception:
                if stop_evt.is_set():
                    break
                time.sleep(0.05)
                continue
            self.msgq.put((channel, gen, msg))

    def _kernel_pid(self):
        km = self.km
        if km is None:
            return 0
        provisioner = getattr(km, "provisioner", None)
        process = getattr(provisioner, "process", None)
        pid = getattr(process, "pid", None)
        if pid:
            return int(pid)
        return 0

    def _teardown_kernel(self):
        km, kc, stop_evt, readers = self.km, self.kc, self.stop_evt, self.readers
        self.km = None
        self.kc = None
        self.stop_evt = None
        self.readers = []
        if stop_evt is not None:
            stop_evt.set()
        for thread in readers:
            thread.join(timeout=2.0)
        if kc is not None:
            try:
                kc.stop_channels()
            except Exception:
                pass
        if km is not None:
            try:
                km.shutdown_kernel(now=True)
            except Exception:
                pass

    def _ensure_kernel(self):
        if self.km is not None and self.kc is not None and self.km.is_alive():
            return True
        restarting = self.had_kernel
        if self.km is not None:
            self._teardown_kernel()
        self.start_kernel(emit_ready=True)
        if restarting:
            self.pending_boundary = True
        return True

    def _restart_kernel(self):
        """Restart in place for a reset; emits no ready event."""
        km = self.km
        if km is None or not km.is_alive():
            restarting = self.had_kernel
            self._teardown_kernel()
            self.start_kernel(emit_ready=False)
            if restarting:
                self.pending_boundary = True
            return
        ok = True
        try:
            km.restart_kernel(now=True)
        except Exception as exc:
            diag("restart_kernel failed: " + str(exc))
            ok = False
        self._drain_events(0.5)
        if not ok or not km.is_alive():
            restarting = self.had_kernel
            self._teardown_kernel()
            self.start_kernel(emit_ready=False)
            if restarting:
                self.pending_boundary = True
            return
        self._startup_probe()

    def _shutdown_kernel_now(self):
        self._teardown_kernel()

    def _request_interrupt(self):
        km = self.km
        if km is None:
            return
        try:
            km.interrupt_kernel()
        except Exception as exc:
            diag("interrupt_kernel failed: " + str(exc))

    # ------------------------------------------------------------------
    # channel helpers
    # ------------------------------------------------------------------
    def _next_event(self, timeout=None):
        try:
            return self.msgq.get(timeout=timeout)
        except queue.Empty:
            return None

    def _handle_idle_op(self, op):
        """Handle an op that arrived while no cell was running."""
        name = op.get("op")
        if name == "interrupt":
            self._request_interrupt()
        elif name == "shutdown":
            self.shutting_down = True
        elif name == "exec":
            self.deferred.append(op)
        else:
            diag("unknown op: " + str(name))

    def _drain_events(self, seconds):
        """Discard queued kernel traffic for up to `seconds`."""
        end = time.monotonic() + seconds
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            ev = self._next_event(min(remaining, 0.05))
            if ev is None:
                continue
            if ev[0] == "op":
                self._handle_idle_op(ev[1])

    def _wait_shell_reply(self, msg_id, timeout):
        end = time.monotonic() + timeout
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return None
            ev = self._next_event(min(remaining, 0.1))
            if ev is None:
                continue
            kind = ev[0]
            if kind == "op":
                op = ev[1]
                if op.get("op") == "shutdown":
                    self.shutting_down = True
                    return None
                if op.get("op") == "interrupt":
                    self._request_interrupt()
                else:
                    self.deferred.append(op)
                continue
            if kind != "shell" or ev[1] != self.gen:
                continue
            msg = ev[2]
            if msg.get("parent_header", {}).get("msg_id") == msg_id:
                return msg

    def _kernel_info(self):
        msg_id = self.kc.kernel_info()
        reply = self._wait_shell_reply(msg_id, 60.0)
        if reply is None:
            raise RuntimeError("no kernel_info_reply from kernel")
        return reply

    def _startup_probe(self):
        """Make the project cwd importable when it is not already."""
        msg_id = self.kc.execute(
            STARTUP_CELL,
            silent=True,
            store_history=False,
            allow_stdin=False,
        )
        self._wait_iopub_idle(msg_id, 60.0)

    def _wait_iopub_idle(self, msg_id, timeout):
        ids = {msg_id}
        end = time.monotonic() + timeout
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return False
            ev = self._next_event(min(remaining, 0.1))
            if ev is None:
                continue
            if ev[0] == "op":
                op = ev[1]
                if op.get("op") == "shutdown":
                    self.shutting_down = True
                    return False
                if op.get("op") == "interrupt":
                    self._request_interrupt()
                else:
                    self.deferred.append(op)
                continue
            if ev[0] != "iopub" or ev[1] != self.gen:
                continue
            msg = ev[2]
            parent = msg.get("parent_header", {}).get("msg_id")
            mtype = msg.get("header", {}).get("msg_type")
            if mtype == "execute_input" and parent in ids:
                ids.add(msg.get("header", {}).get("msg_id"))
                continue
            if parent not in ids:
                continue
            if mtype == "status" and msg.get("content", {}).get("execution_state") == "idle":
                return True

    # ------------------------------------------------------------------
    # exec
    # ------------------------------------------------------------------
    def handle_exec(self, op):
        exec_id = str(op.get("id") or uuid.uuid4())
        code = op.get("code") or ""
        timeout_sec = normalize_timeout(op.get("timeoutSec", DEFAULT_TIMEOUT_SEC))
        reset = bool(op.get("reset"))

        try:
            self._ensure_kernel()
        except Exception:
            self._fatal("kernel startup failed", traceback.format_exc())

        if reset:
            try:
                self._restart_kernel()
            except Exception:
                self._fatal("kernel restart failed", traceback.format_exc())
            self.pending_boundary = True
            emit({"op": "reset_ok"})

        if not code.strip():
            emit(
                {
                    "op": "done",
                    "id": exec_id,
                    "status": "ok",
                    "executionCount": self.last_count,
                    "lost": False,
                }
            )
            return

        state = ExecState(exec_id, code)
        status = "ok"
        lost = False
        try:
            msg_id = self.kc.execute(
                code,
                silent=False,
                store_history=True,
                allow_stdin=False,
                stop_on_error=True,
                user_expressions={},
            )
        except Exception:
            diag("execute failed: " + traceback.format_exc())
            self._teardown_kernel()
            emit(
                {
                    "op": "done",
                    "id": exec_id,
                    "status": "error",
                    "executionCount": self.last_count,
                    "lost": True,
                }
            )
            self._journal_cell(self.last_count, code, [], lost=True)
            return

        state.msg_ids.add(msg_id)
        deadline = None if timeout_sec == 0 else time.monotonic() + timeout_sec
        interrupt_deadline = None
        grace_status = "timeout"
        idle_at = None
        timed_out = False
        forced_status = None
        last_liveness = time.monotonic()

        while True:
            now = time.monotonic()
            ev = self._next_event(0.05)
            if ev is not None:
                kind = ev[0]
                if kind == "op":
                    op_name = ev[1].get("op")
                    if op_name == "interrupt":
                        if not state.interrupted:
                            state.interrupted = True
                            self._request_interrupt()
                        if interrupt_deadline is None:
                            interrupt_deadline = now + INTERRUPT_GRACE
                            grace_status = "interrupted"
                    elif op_name == "shutdown":
                        self.shutting_down = True
                        forced_status = "interrupted"
                        lost = True
                        self._shutdown_kernel_now()
                        break
                    elif op_name == "exec":
                        self.deferred.append(ev[1])
                    else:
                        diag("unknown op: " + str(op_name))
                elif kind == "iopub":
                    if ev[1] != self.gen:
                        continue
                    msg = ev[2]
                    if msg.get("parent_header", {}).get("msg_id") not in state.msg_ids:
                        continue
                    if self._handle_iopub(state, msg) == "idle":
                        idle_at = time.monotonic()
                elif kind == "shell":
                    if ev[1] != self.gen:
                        continue
                    msg = ev[2]
                    if msg.get("parent_header", {}).get("msg_id") in state.msg_ids:
                        state.reply = msg

            now = time.monotonic()
            if idle_at is not None:
                if state.reply is not None or now - idle_at >= IDLE_REPLY_GRACE:
                    break
            else:
                if deadline is not None and not timed_out and now >= deadline:
                    timed_out = True
                    self._request_interrupt()
                    interrupt_deadline = now + INTERRUPT_GRACE
                    grace_status = "timeout"
                if (
                    interrupt_deadline is not None
                    and now >= interrupt_deadline
                    and idle_at is None
                ):
                    lost = True
                    forced_status = grace_status
                    self._shutdown_kernel_now()
                    break
                if now - last_liveness >= 0.25:
                    last_liveness = now
                    if self.km is None or not self.km.is_alive():
                        lost = True
                        forced_status = "error"
                        self._shutdown_kernel_now()
                        break

        if forced_status is not None:
            status = forced_status
        elif timed_out:
            status = "timeout"
        elif state.interrupted:
            status = "interrupted"
        else:
            status = self._status_from_reply(state)
        if timed_out and forced_status is None:
            status = "timeout"

        count = state.count
        if count is None and state.reply is not None:
            reply_count = (state.reply.get("content") or {}).get("execution_count")
            if reply_count is not None:
                count = int(reply_count)
        if count is None:
            count = self.last_count
        count = int(count or 0)
        self.last_count = count

        emit(
            {
                "op": "done",
                "id": exec_id,
                "status": status,
                "executionCount": count,
                "lost": bool(lost),
            }
        )
        self._journal_cell(
            count,
            code,
            self._serialize_outputs(state.outputs),
            lost=lost,
        )

    @staticmethod
    def _status_from_reply(state):
        reply = state.reply
        if reply is None:
            return "error" if state.saw_error else "ok"
        content = reply.get("content") or {}
        status = content.get("status")
        if status == "ok":
            return "ok"
        if status == "error":
            return "error"
        if status in ("aborted", "interrupted"):
            return "interrupted"
        return "error" if state.saw_error else "ok"

    def _handle_iopub(self, state, msg):
        mtype = msg.get("header", {}).get("msg_type")
        content = msg.get("content") or {}
        if mtype == "status":
            return "idle" if content.get("execution_state") == "idle" else None
        if mtype == "execute_input":
            header_id = msg.get("header", {}).get("msg_id")
            if header_id:
                state.msg_ids.add(header_id)
            count = content.get("execution_count")
            if count is not None:
                state.count = int(count)
            return None
        if mtype == "stream":
            name = content.get("name") or "stdout"
            text = content.get("text") or ""
            self._forward_stream(state, name, text)
            self._append_stream(state, name, text)
            return None
        if mtype == "execute_result":
            data = content.get("data") or {}
            metadata = content.get("metadata") or {}
            count = content.get("execution_count")
            if count is not None:
                state.count = int(count)
            emit(
                {
                    "op": "result",
                    "id": state.id,
                    "executionCount": state.count,
                    "data": data,
                    "metadata": metadata,
                }
            )
            self._append_output(
                state,
                {
                    "output_type": "execute_result",
                    "execution_count": state.count if state.count is not None else 0,
                    "data": data,
                    "metadata": metadata,
                },
            )
            return None
        if mtype == "display_data":
            data = content.get("data") or {}
            metadata = content.get("metadata") or {}
            transient = content.get("transient") or {}
            emit(
                {
                    "op": "display",
                    "id": state.id,
                    "data": data,
                    "metadata": metadata,
                    "transient": transient,
                }
            )
            output = {
                "output_type": "display_data",
                "data": copy.deepcopy(data),
                "metadata": copy.deepcopy(metadata),
            }
            display_id = transient.get("display_id") if isinstance(transient, dict) else None
            if display_id:
                output["_display_id"] = str(display_id)
            self._append_output(state, output)
            return None
        if mtype == "update_display_data":
            data = content.get("data") or {}
            metadata = content.get("metadata") or {}
            transient = content.get("transient") or {}
            emit(
                {
                    "op": "update_display",
                    "id": state.id,
                    "data": data,
                    "transient": transient,
                }
            )
            display_id = transient.get("display_id") if isinstance(transient, dict) else None
            if display_id:
                for output in state.outputs:
                    if output.get("_display_id") == str(display_id):
                        if isinstance(output.get("data"), dict):
                            output["data"] = copy.deepcopy(data)
                        if isinstance(output.get("metadata"), dict):
                            output["metadata"] = copy.deepcopy(metadata)
            return None
        if mtype == "clear_output":
            wait = bool(content.get("wait"))
            emit({"op": "clear_output", "id": state.id, "wait": wait})
            if wait:
                state.pending_clear = True
            else:
                state.outputs = []
                state.pending_clear = False
            return None
        if mtype == "error":
            ename = str(content.get("ename") or "")
            evalue = str(content.get("evalue") or "")
            tb = content.get("traceback") or []
            state.saw_error = True
            emit(
                {
                    "op": "error",
                    "id": state.id,
                    "ename": ename,
                    "evalue": evalue,
                    "traceback": tb,
                }
            )
            self._append_output(
                state,
                {
                    "output_type": "error",
                    "ename": ename,
                    "evalue": evalue,
                    "traceback": list(tb),
                },
            )
            return None
        return None

    def _append_output(self, state, output):
        if state.pending_clear:
            state.outputs = []
            state.pending_clear = False
        state.outputs.append(output)

    def _append_stream(self, state, name, text):
        if not text:
            return
        if state.pending_clear:
            state.outputs = []
            state.pending_clear = False
        if state.outputs:
            last = state.outputs[-1]
            if last.get("output_type") == "stream" and last.get("name") == name:
                last["text"] = (last.get("text") or "") + text
                return
        state.outputs.append({"output_type": "stream", "name": name, "text": text})

    def _forward_stream(self, state, name, text):
        if state.forward_cut or not text:
            return
        size = len(text.encode("utf-8"))
        remaining = FORWARD_CAP_BYTES - state.forwarded_bytes
        if size <= remaining:
            state.forwarded_bytes += size
            emit({"op": "stream", "id": state.id, "name": name, "text": text})
            return
        if remaining > 0:
            head = text.encode("utf-8")[:remaining].decode("utf-8", "ignore")
            if head:
                emit({"op": "stream", "id": state.id, "name": name, "text": head})
        state.forwarded_bytes = FORWARD_CAP_BYTES
        state.forward_cut = True
        emit({"op": "stream", "id": state.id, "name": "stdout", "text": FORWARD_NOTICE})

    @staticmethod
    def _serialize_outputs(outputs):
        clean = []
        for output in outputs:
            item = {k: v for k, v in output.items() if not k.startswith("_")}
            clean.append(item)
        return clean

    # ------------------------------------------------------------------
    # journal and meta
    # ------------------------------------------------------------------
    def _journal_append(self, obj):
        parent = os.path.dirname(self.journal_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        line = json.dumps(obj, ensure_ascii=True)
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
            fh.flush()

    def _journal_cell(self, count, source, outputs, lost=False):
        try:
            if self.pending_boundary:
                self._journal_append(
                    {"v": 1, "type": "boundary", "text": "Kernel reset"}
                )
                self.pending_boundary = False
            cell = {
                "v": 1,
                "type": "cell",
                "execution_count": int(count or 0),
                "source": source,
                "outputs": outputs,
                "truncated": False,
            }
            line, truncated = self._fit_cell(cell)
            parent = os.path.dirname(self.journal_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(self.journal_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
            self.cells += 1
            if truncated:
                self.any_truncated = True
            if lost:
                diag("cell %d ended with lost=true" % count)
            self._write_meta()
        except Exception:
            diag("journal write failed: " + traceback.format_exc())

    @staticmethod
    def _fit_cell(cell):
        """Serialize a cell, capping it at JOURNAL_CELL_CAP_BYTES."""
        line = json.dumps(cell, ensure_ascii=True)
        if len(line.encode("utf-8")) <= JOURNAL_CELL_CAP_BYTES:
            return line, False

        work = copy.deepcopy(cell)
        work["truncated"] = True
        streams = [o for o in work["outputs"] if o.get("output_type") == "stream"]
        saved = []
        for output in streams:
            text = output.get("text") or ""
            saved.append((output, text))
            output["text"] = ""

        overhead = len(json.dumps(work, ensure_ascii=True).encode("utf-8"))
        budget = JOURNAL_CELL_CAP_BYTES - overhead - len(CELL_TRUNCATION_NOTICE) - 64
        last_with_text = None
        for output, text in saved:
            if not text:
                continue
            if budget > 0:
                keep = text.encode("utf-8")[:budget].decode("utf-8", "ignore")
                output["text"] = keep
                budget -= len(keep.encode("utf-8"))
            last_with_text = output
        if last_with_text is not None:
            last_with_text["text"] = (last_with_text.get("text") or "") + CELL_TRUNCATION_NOTICE
        line = json.dumps(work, ensure_ascii=True)
        if len(line.encode("utf-8")) <= JOURNAL_CELL_CAP_BYTES:
            return line, True

        for output in work["outputs"]:
            data = output.get("data")
            if isinstance(data, dict):
                for key in list(data):
                    if key.startswith("image/") and isinstance(data[key], str):
                        data[key] = IMAGE_TRUNCATION_NOTICE
        line = json.dumps(work, ensure_ascii=True)
        if len(line.encode("utf-8")) <= JOURNAL_CELL_CAP_BYTES:
            return line, True

        for output in work["outputs"]:
            data = output.get("data")
            if isinstance(data, dict):
                for key in list(data):
                    data[key] = "[truncated]"
        line = json.dumps(work, ensure_ascii=True)
        if len(line.encode("utf-8")) <= JOURNAL_CELL_CAP_BYTES:
            return line, True

        work["outputs"] = [
            {"output_type": "stream", "name": "stdout", "text": CELL_TRUNCATION_NOTICE}
        ]
        line = json.dumps(work, ensure_ascii=True)
        if len(line.encode("utf-8")) <= JOURNAL_CELL_CAP_BYTES:
            return line, True

        source = work["source"] or ""
        keep = len(source)
        while keep > 0:
            keep = max(0, keep - max(4096, (len(line) - JOURNAL_CELL_CAP_BYTES) * 2))
            work["source"] = source[:keep] + CELL_TRUNCATION_NOTICE if keep else ""
            line = json.dumps(work, ensure_ascii=True)
            if len(line.encode("utf-8")) <= JOURNAL_CELL_CAP_BYTES:
                break
        return line, True

    def _write_meta(self):
        meta = {
            "v": 1,
            "kernelspec": self.kernelspec_meta,
            "language_info": self.language_info,
            "selection": self.selection,
            "cells": self.cells,
            "truncated": self.any_truncated,
        }
        parent = os.path.dirname(self.meta_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = self.meta_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(meta, ensure_ascii=True, indent=2) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.meta_path)

    # ------------------------------------------------------------------
    # main loop
    # ------------------------------------------------------------------
    def _fatal(self, message, tb=""):
        self.shutting_down = True
        try:
            emit({"op": "fatal", "message": message, "traceback": tb})
        finally:
            try:
                self._teardown_kernel()
            except Exception:
                pass
            sys.exit(1)

    def _stdin_loop(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                op = json.loads(line)
            except ValueError:
                diag("ignoring malformed stdin line")
                continue
            if not isinstance(op, dict):
                diag("ignoring non-object stdin line")
                continue
            self.msgq.put(("op", op))
        self.msgq.put(("op", {"op": "shutdown"}))

    def _install_signal_handlers(self):
        def handler(signum, frame):
            diag("signal %d received, shutting down" % signum)
            try:
                km = self.km
                if km is not None:
                    km.shutdown_kernel(now=True)
            except Exception:
                pass
            os._exit(0)

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass

    def shutdown(self):
        self.shutting_down = True
        self._teardown_kernel()

    def run(self):
        self._install_signal_handlers()
        try:
            self.prepare()
            self.start_kernel(emit_ready=True)
        except Exception:
            self._fatal("kernel startup failed", traceback.format_exc())
        reader = threading.Thread(target=self._stdin_loop, daemon=True)
        reader.start()
        try:
            while not self.shutting_down:
                ev = self._next_event()
                if ev is None:
                    continue
                if ev[0] != "op":
                    continue
                op = ev[1]
                name = op.get("op")
                if name == "exec":
                    self.handle_exec(op)
                    while self.deferred and not self.shutting_down:
                        self.handle_exec(self.deferred.pop(0))
                elif name == "interrupt":
                    self._request_interrupt()
                elif name == "shutdown":
                    self.shutting_down = True
                else:
                    diag("unknown op: " + str(name))
        finally:
            self.shutdown()
        return 0


# ----------------------------------------------------------------------
# notebook export
# ----------------------------------------------------------------------
class ExportError(Exception):
    """Raised when the journal cannot be turned into a notebook."""


def _export_fail(message):
    emit({"ok": False, "error": message})
    return 1


def _source_lines(text):
    """Split source text into nbformat source lines, keeping line endings."""
    if not text:
        return []
    return text.splitlines(True)


def _markdown_cell(text):
    return {
        "cell_type": "markdown",
        "id": uuid.uuid4().hex,
        "metadata": {},
        "source": _source_lines(text),
    }


def _cell_size(cell):
    return len(json.dumps(cell, ensure_ascii=True).encode("utf-8"))


def _load_journal(path):
    """Read the journal into (kind, payload) records, skipping blank lines.

    A final line without its trailing newline is a write in progress and is
    ignored; a malformed line that is properly terminated is still an error.
    """
    entries = []
    with open(path, "r", encoding="utf-8", newline="") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line:
                continue
            if not raw.endswith("\n"):
                break
            try:
                obj = json.loads(line)
            except ValueError:
                raise ExportError("journal line %d: invalid JSON" % lineno)
            if not isinstance(obj, dict):
                raise ExportError("journal line %d: not a JSON object" % lineno)
            kind = obj.get("type")
            if kind == "cell":
                entries.append(("cell", obj))
            elif kind == "boundary":
                entries.append(("boundary", str(obj.get("text") or "")))
    return entries


def _read_meta(path):
    """Return (kernelspec, language_info), falling back when meta is unusable."""
    fallback_spec = dict(DEFAULT_KERNELSPEC)
    fallback_lang = dict(DEFAULT_LANGUAGE_INFO)
    if not path:
        return fallback_spec, fallback_lang
    try:
        with open(path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return fallback_spec, fallback_lang
    if not isinstance(meta, dict):
        return fallback_spec, fallback_lang
    spec = meta.get("kernelspec")
    if not isinstance(spec, dict) or not spec.get("name"):
        spec = fallback_spec
    else:
        spec = {
            "name": str(spec.get("name")),
            "display_name": str(spec.get("display_name") or spec.get("name")),
            "language": str(spec.get("language") or "python"),
        }
    lang = meta.get("language_info")
    if not isinstance(lang, dict) or not lang.get("name"):
        lang = {"name": spec.get("language") or "python"}
    else:
        lang = copy.deepcopy(lang)
    return spec, lang


def _export_output(item, cell_count):
    """Copy one journal output into its nbformat 4.5 shape."""
    kind = item.get("output_type")
    if kind == "stream":
        return {
            "output_type": "stream",
            "name": str(item.get("name") or "stdout"),
            "text": item.get("text") or "",
        }
    if kind in ("execute_result", "display_data"):
        data = item.get("data")
        metadata = item.get("metadata")
        output = {
            "output_type": kind,
            "data": copy.deepcopy(data) if isinstance(data, dict) else {},
            "metadata": copy.deepcopy(metadata) if isinstance(metadata, dict) else {},
        }
        if kind == "execute_result":
            count = item.get("execution_count")
            try:
                output["execution_count"] = int(count)
            except (TypeError, ValueError):
                output["execution_count"] = cell_count
        return output
    if kind == "error":
        tb = item.get("traceback")
        return {
            "output_type": "error",
            "ename": str(item.get("ename") or ""),
            "evalue": str(item.get("evalue") or ""),
            "traceback": [str(part) for part in tb] if isinstance(tb, list) else [],
        }
    return None


def _fit_export_cell(cell):
    """Cap one exported code cell at EXPORT_CELL_CAP_BYTES."""
    if _cell_size(cell) <= EXPORT_CELL_CAP_BYTES:
        return cell, False
    work = copy.deepcopy(cell)
    saved = []
    for output in work["outputs"]:
        if output.get("output_type") == "stream":
            saved.append((output, output.get("text") or ""))
            output["text"] = ""
    budget = (
        EXPORT_CELL_CAP_BYTES
        - _cell_size(work)
        - len(EXPORT_CELL_NOTICE.encode("utf-8"))
        - 1024
    )
    last = None
    for output, text in saved:
        if text and budget > 0:
            keep = text.encode("utf-8")[:budget].decode("utf-8", "ignore")
            output["text"] = keep
            budget -= len(keep.encode("utf-8"))
        if text:
            last = output
    if last is not None:
        last["text"] = (last.get("text") or "") + EXPORT_CELL_NOTICE
    if _cell_size(work) <= EXPORT_CELL_CAP_BYTES:
        return work, True
    for output in work["outputs"]:
        data = output.get("data")
        if isinstance(data, dict):
            for key in list(data):
                if key.startswith("image/") and isinstance(data[key], str):
                    data[key] = IMAGE_TRUNCATION_NOTICE
    if _cell_size(work) <= EXPORT_CELL_CAP_BYTES:
        return work, True
    for output in work["outputs"]:
        data = output.get("data")
        if isinstance(data, dict):
            for key in list(data):
                data[key] = "[truncated]"
    if _cell_size(work) <= EXPORT_CELL_CAP_BYTES:
        return work, True
    work["outputs"] = [
        {"output_type": "stream", "name": "stdout", "text": EXPORT_CELL_NOTICE}
    ]
    if _cell_size(work) <= EXPORT_CELL_CAP_BYTES:
        return work, True
    source_text = "".join(work["source"]) or ""
    keep = len(source_text)
    while keep > 0:
        keep = max(0, keep - 4096)
        work["source"] = _source_lines(source_text[:keep] + EXPORT_CELL_NOTICE)
        if _cell_size(work) <= EXPORT_CELL_CAP_BYTES:
            break
    return work, True


def _export_code_cell(record):
    """Build one code cell from a journal cell record."""
    count = record.get("execution_count")
    if count is not None:
        try:
            count = int(count)
        except (TypeError, ValueError):
            count = 0
    outputs = []
    raw = record.get("outputs")
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            output = _export_output(item, count if count is not None else 0)
            if output is not None:
                outputs.append(output)
    cell = {
        "cell_type": "code",
        "id": uuid.uuid4().hex,
        "execution_count": count,
        "metadata": {},
        "outputs": outputs,
        "source": _source_lines(record.get("source") or ""),
    }
    return _fit_export_cell(cell)


def _build_cells(entries, title):
    """Turn journal records into notebook cells; report whether anything was cut."""
    cells = []
    if title:
        cells.append(_markdown_cell("# " + title))
    code_cells = 0
    capped = False
    cell_cut = False
    for kind, payload in entries:
        if kind == "boundary":
            cells.append(_markdown_cell("## " + payload))
            continue
        if code_cells >= EXPORT_MAX_CODE_CELLS:
            capped = True
            break
        cell, cut = _export_code_cell(payload)
        if cut:
            cell_cut = True
        cells.append(cell)
        code_cells += 1
    if capped:
        cells.append(_markdown_cell(EXPORT_CELLS_NOTICE))
    return cells, bool(capped or cell_cut)


def _write_notebook_atomic(path, notebook):
    """Write the notebook beside its destination and rename it into place."""
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".nb-export-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(notebook, ensure_ascii=True, indent=1) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def run_export(args):
    """--export-only entry point: journal plus meta in, one JSON line out."""
    if not args.journal:
        return _export_fail("--journal is required")
    if not args.out:
        return _export_fail("--out is required")
    out = args.out
    if not out.lower().endswith(".ipynb"):
        out += ".ipynb"
    out = os.path.abspath(out)
    try:
        entries = _load_journal(args.journal)
    except ExportError as exc:
        return _export_fail(str(exc))
    except OSError as exc:
        return _export_fail("journal read failed: " + str(exc))
    if not any(kind == "cell" for kind, _ in entries):
        return _export_fail("session has no recorded cells; nothing written")
    kernelspec, language_info = _read_meta(args.meta)
    cells, truncated = _build_cells(entries, args.title)
    notebook = {
        "cells": cells,
        "metadata": {"kernelspec": kernelspec, "language_info": language_info},
        "nbformat": NBFORMAT_MAJOR,
        "nbformat_minor": NBFORMAT_MINOR,
    }
    try:
        _write_notebook_atomic(out, notebook)
    except OSError as exc:
        return _export_fail("notebook write failed: " + str(exc))
    emit({"ok": True, "path": out, "cells": len(cells), "truncated": truncated})
    return 0


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="host.py", description="JSON-lines Python kernel host"
    )
    parser.add_argument(
        "--kernel", default=None, help="absolute Python path or kernelspec name"
    )
    parser.add_argument("--cwd", default=None, help="project directory for the kernel")
    parser.add_argument("--journal", default=None, help="JSONL journal path")
    parser.add_argument("--meta", default=None, help="JSON meta path")
    parser.add_argument(
        "--state",
        default=None,
        help="state directory for ephemeral kernelspecs (default: journal directory)",
    )
    parser.add_argument(
        "--export-only",
        action="store_true",
        help="export the journal to a notebook and exit without a kernel",
    )
    parser.add_argument("--out", default=None, help="notebook path for --export-only")
    parser.add_argument("--title", default=None, help="notebook title for --export-only")
    return parser


def parse_args(argv):
    return _build_parser().parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.export_only:
        return run_export(args)
    missing = [
        name
        for name in ("kernel", "cwd", "journal", "meta")
        if not getattr(args, name)
    ]
    if missing:
        _build_parser().error(
            "the following arguments are required: "
            + ", ".join("--" + name for name in missing)
        )
    host = KernelHost(args.kernel, args.cwd, args.journal, args.meta, args.state)
    return host.run()


if __name__ == "__main__":
    sys.exit(main())
