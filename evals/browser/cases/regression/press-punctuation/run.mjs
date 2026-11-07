import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { withChrome } from "../snapshot-coordinates/chrome.mjs";

const exec = promisify(execFile);
const bsk = resolve(process.env.BSK_PRESS_BSK ?? "target/debug/bsk");
const extension = resolve(process.env.BSK_PRESS_EXTENSION ?? "apps/extension/dist/chrome-mv3");
const executable = process.env.BSK_PRESS_CHROME;
assert(executable, "Set BSK_PRESS_CHROME to Chrome for Testing");
const port = Number(process.env.BSK_PRESS_PORT ?? 52964);
const output = resolve(process.env.BSK_PRESS_OUTPUT ?? "evals/browser/results/press-punctuation");
const baseline = process.env.BSK_PRESS_BASELINE === "1";
const record = process.env.BSK_PRESS_VIDEO === "1";
await mkdir(output, { recursive: true });
const bskHome = await mkdtemp(join(tmpdir(), "bsk-press-"));
const env = { ...process.env, BSK_HOME: bskHome, BSK_AUTO_UPDATE: "off", BSK_AUTO_START: "0" };
const transcript = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function cli(args) {
  const { stdout, stderr } = await exec(bsk, [...args, "--json"], {
    env,
    timeout: 65_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  transcript.push({ args, result, stderr });
  return result;
}
async function until(read, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(200);
  }
  throw new Error("Timed out waiting for live browser state");
}

const frames = [];
let acknowledge;
let castSession;
const daemon = spawn(bsk, ["daemon", "start", "--foreground", "--port", String(port)], {
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
let daemonLog = "";
daemon.stderr.on("data", (chunk) => {
  daemonLog += chunk;
});
try {
  await delay(500);
  await withChrome(
    {
      executable,
      deviceScale: 1,
      zoom: 1,
      extensionPath: extension,
      extraArgs: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
      onEvent: (event) => {
        if (event.method === "Page.screencastFrame" && event.sessionId === castSession) {
          frames.push(event.params);
          acknowledge(event.params.sessionId);
        }
      },
    },
    async (send) => {
      await until(async () => {
        const browsers = await cli(["browsers"]);
        return (Array.isArray(browsers) ? browsers : browsers.browsers).length === 1;
      });
      const { session_id: session } = await cli(["session", "start"]);
      const sessionArgs = ["--session", session];
      const url =
        "https://microsoft.github.io/monaco-editor/playground.html?source=v0.55.1#example-creating-the-editor-hello-world";
      await cli(["navigate", url, ...sessionArgs]);
      const { targetInfos } = await send("Target.getTargets");
      const target = targetInfos.find(
        (item) => item.type === "page" && item.url.startsWith(url.split("#")[0]),
      );
      assert(target, "Monaco page exists");
      const { sessionId } = await send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      const evaluate = async (expression) => {
        const reply = await send(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sessionId,
        );
        assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
        return reply.result.value;
      };
      await until(() =>
        evaluate(
          'Boolean(window.monaco?.editor.getModels().length && document.querySelector("[aria-label=\\"JavaScript Input\\"]"))',
        ),
      );
      await delay(2_000);
      // 仅监听键盘事件；页面原有编辑器、快捷键处理器和文档均由网站提供。
      await evaluate(`window.__bskPressEvents = [];
        for (const type of ['keydown', 'keyup']) {
          document.addEventListener(type, event => window.__bskPressEvents.push({
            type, key: event.key, code: event.code, keyCode: event.keyCode,
            ctrl: event.ctrlKey, shift: event.shiftKey, trusted: event.isTrusted
          }), {capture: true, passive: true});
        }`);
      const press = async (key) => {
        const sync = await cli(["cooperate", "sync", ...sessionArgs]);
        assert(sync.context_id && sync.observation_id, JSON.stringify(sync));
        const result = await cli([
          "press",
          key,
          "--selector",
          '[aria-label="JavaScript Input"]',
          ...sessionArgs,
          "--context",
          sync.context_id,
          "--observation",
          sync.observation_id,
        ]);
        // 等待网站自动重载预览，再获取下一次操作的页面观察。
        await delay(1_000);
        return result;
      };
      const read = () => evaluate("monaco.editor.getModels()[0].getValue()");
      const before = await read();
      assert(before.startsWith("const value ="), "Website still supplies the expected example");
      await press("Ctrl+Home");
      if (record) {
        castSession = sessionId;
        acknowledge = (frameId) => {
          void send("Page.screencastFrameAck", { sessionId: frameId }, sessionId);
        };
        await send("Page.startScreencast", { format: "jpeg", quality: 85 }, sessionId);
        await delay(2_000);
      }
      await press("Ctrl+/");
      await delay(record ? 3_000 : 700);
      const commented = await read();
      assert.equal(commented, baseline ? before : `// ${before}`);
      await press("Ctrl+/");
      await delay(record ? 3_000 : 700);
      assert.equal(await read(), before, "Second shortcut restores the exact original document");
      if (record) await send("Page.stopScreencast", {}, sessionId);

      await press("Ctrl+]");
      await delay(700);
      const indented = await read();
      assert.equal(indented, baseline ? before : `\t${before}`);
      await press("Ctrl+[");
      await delay(700);
      assert.equal(await read(), before, "Outdent restores the original document");
      await press("Ctrl+End");
      for (const character of ["/", "?", "+", "!", "中"]) {
        await press(character);
        assert.equal(await read(), before + character, `Plain ${character} inserts exactly once`);
        await press("Backspace");
        assert.equal(await read(), before);
      }
      const events = await evaluate("window.__bskPressEvents");
      for (const [key, code, keyCode] of [
        ["/", "Slash", 191],
        ["]", "BracketRight", 221],
        ["[", "BracketLeft", 219],
      ]) {
        for (const type of ["keydown", "keyup"]) {
          const event = events.find((item) => item.type === type && item.key === key && item.ctrl);
          assert(event?.trusted, `${key} ${type} is trusted`);
          assert.equal(event.code, baseline ? "" : code);
          assert.equal(event.keyCode, baseline ? 0 : keyCode);
        }
      }
      await writeFile(
        join(output, "result.json"),
        JSON.stringify(
          {
            url,
            baseline,
            browser: await send("Browser.getVersion"),
            before,
            commented,
            indented,
            events,
          },
          null,
          2,
        ),
      );
      console.log(
        `PASS ${baseline ? "baseline reproduction" : "fixed regression"}: Monaco comments, indentation, plain punctuation and Unicode`,
      );
      await cli(["session", "stop", session]);
    },
  );
} finally {
  await writeFile(join(output, "cli.json"), JSON.stringify(transcript, null, 2));
  await writeFile(join(output, "daemon.log"), daemonLog);
  if (daemon.exitCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill();
    await exited;
  }
}
if (record) {
  assert(frames.length > 1, "Browser supplied screencast frames");
  const listing = ["ffconcat version 1.0"];
  for (const [index, frame] of frames.entries()) {
    const name = `frame-${String(index).padStart(5, "0")}.jpg`;
    await writeFile(join(output, name), Buffer.from(frame.data, "base64"));
    const duration = frames[index + 1]
      ? frames[index + 1].metadata.timestamp - frame.metadata.timestamp
      : 1;
    listing.push(`file '${name}'`, `duration ${Math.max(duration, 0.001)}`);
  }
  await writeFile(join(output, "frames.ffconcat"), `${listing.join("\n")}\n`);
  await exec("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    join(output, "frames.ffconcat"),
    "-vf",
    "fps=10,pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(output, "monaco.mp4"),
  ]);
}
