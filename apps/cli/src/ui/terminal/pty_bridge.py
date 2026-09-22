import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def decode_config():
    if len(sys.argv) < 2:
        emit({"type": "error", "message": "Missing PTY bridge config"})
        sys.exit(1)

    try:
        encoded = sys.argv[1]
        return json.loads(base64.b64decode(encoded).decode("utf-8"))
    except Exception as error:
        emit({"type": "error", "message": f"Invalid PTY bridge config: {error}"})
        sys.exit(1)


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def handle_message(message, fd, pid):
    msg_type = message.get("type")

    if msg_type == "input" and isinstance(message.get("data"), str):
        os.write(fd, base64.b64decode(message["data"]))
        return

    if msg_type == "resize":
        cols = int(message.get("cols", 80))
        rows = int(message.get("rows", 24))
        set_winsize(fd, rows, cols)
        return

    if msg_type == "stop":
        os.kill(pid, signal.SIGTERM)


def main():
    config = decode_config()
    pid, fd = pty.fork()

    if pid == 0:
        env = os.environ.copy()
        env.update(config.get("env", {}))
        env["COLUMNS"] = str(config.get("cols", 80))
        env["LINES"] = str(config.get("rows", 24))
        os.chdir(config["cwd"])
        os.execvpe(config["shell"], [config["shell"], "-lc", config["command"]], env)
        return

    set_winsize(fd, int(config.get("rows", 24)), int(config.get("cols", 80)))

    stdin_fd = sys.stdin.fileno()
    stdin_open = True
    stdin_buffer = ""
    exit_code = 0
    exit_signal = None
    exited = False

    empty_reads_after_exit = 0
    MAX_EMPTY_READS = 10  # bail after this many consecutive empty reads post-exit

    while True:
        if not exited:
            waited_pid, status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                exited = True
                if os.WIFSIGNALED(status):
                    exit_signal = os.WTERMSIG(status)
                    exit_code = 128 + exit_signal
                else:
                    exit_code = os.WEXITSTATUS(status)

        read_fds = [fd, stdin_fd] if stdin_open else [fd]
        ready, _, _ = select.select(read_fds, [], [], 0.05)

        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""

            if data:
                empty_reads_after_exit = 0
                emit({
                    "type": "data",
                    "data": base64.b64encode(data).decode("ascii"),
                })
            elif exited:
                break

        if stdin_open and stdin_fd in ready:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                # EOF: the controlling app is gone. An EOF fd stays readable,
                # so keeping it in select() spun this loop at 100% CPU. Stop
                # watching it and hang up the child like a closed terminal.
                stdin_open = False
                if not exited:
                    try:
                        os.kill(pid, signal.SIGHUP)
                    except OSError:
                        pass
            if chunk:
                stdin_buffer += chunk.decode("utf-8")

                while "\n" in stdin_buffer:
                    line, stdin_buffer = stdin_buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        handle_message(json.loads(line), fd, pid)
                    except Exception as error:
                        emit({"type": "error", "message": f"Invalid PTY bridge message: {error}"})

        if exited:
            try:
                trailing = os.read(fd, 65536)
            except OSError:
                trailing = b""
            if trailing:
                empty_reads_after_exit = 0
                emit({
                    "type": "data",
                    "data": base64.b64encode(trailing).decode("ascii"),
                })
            else:
                empty_reads_after_exit += 1
                if empty_reads_after_exit >= MAX_EMPTY_READS:
                    break

    emit({
        "type": "exit",
        "exitCode": exit_code,
        "signal": exit_signal,
    })


if __name__ == "__main__":
    main()
